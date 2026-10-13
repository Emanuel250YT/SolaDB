import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  address as toAddress,
  Address,
  Commitment,
  KeyPairSigner,
  Rpc,
  Signature,
  SolanaRpcApi,
} from '@solana/kit';
import {
  addressBytes,
  assembleChunk,
  BlobAccount,
  soladbInstructions,
  ChunkAccount,
  ConfigAccount,
  createSolaDBRpc,
  fetchAccount,
  fetchAccounts,
  FetchedAccount,
  listAccounts,
  OFFSETS,
  pdas,
  readSegments,
  ReplicatorAccount,
  challengeSlotHash,
  SLOT_HASHES_ADDRESS,
  TransactionSender,
  TxOptions,
  TxRequest,
} from '@soladb/sdk';
import { loadReplicatorSigner } from './keypair';

/** Compute budget for confirm_replication when a priority fee is set (uses ~9.2k CU) */
const CONFIRM_REPLICATION_CU = 40_000;

/**
 * confirm_replication instructions per transaction (one signature fee for
 * all of them).  8 take at most 989 of the 1232 bytes (distinct owners,
 * priority fee); 11 is the hard limit.
 */
export const MAX_CONFIRMATIONS_PER_TX = 8;

/** Largest serialized transaction (v0 / legacy) */
const PACKET_DATA_SIZE = 1232;

/** Compute budget of a prove_shard (a few dozen sha256 + the SlotHashes lookup) */
const PROVE_SHARD_CU = 120_000;

/** Bytes of the SlotHashes sysvar account (512 entries of 40 bytes + length) */
const SLOT_HASHES_SIZE = 8 + 512 * 40;

/** A chunk to confirm and its owner (the last confirmation refunds the chunk's rent to it) */
export interface ChunkToConfirm {
  address: Address;
  owner: Address;
}

/** A chunk rebuilt from its write_segment transactions */
export interface LedgerChunk {
  data: Uint8Array;
  /** Highest slot among the segment transactions */
  slot: bigint;
}

/**
 * SolanaService
 *
 * Thin wrapper around @soladb/sdk for everything the replicator does
 * on-chain:
 *   • scan the Chunk accounts that still need replicas (getProgramAccounts
 *     with a memcmp on `needs_replicas`),
 *   • rebuild a chunk from the `write_segment` instructions in the ledger,
 *   • list the registered replicators (peers serving direct chunks),
 *   • send `confirm_replication` (several per transaction) /
 *     `update_replicator_endpoint`.
 *
 * Reads use SOLANA_COMMITMENT ("finalized" by default, the Solana analogue
 * of Monad's finalized tag).  Transactions are confirmed at "confirmed".
 */
@Injectable()
export class SolanaService implements OnModuleInit {
  private readonly logger = new Logger(SolanaService.name);

  private rpc: Rpc<SolanaRpcApi>;
  private signer: KeyPairSigner;
  private sender: TransactionSender;
  private ix: ReturnType<typeof soladbInstructions>;
  private program: Address;
  private commitment: Commitment;
  private cluster: string;
  private rpcUrl: string;
  private ledgerConcurrency: number;
  private priorityFeeLamports: bigint;
  private replicatorPda: Address;
  private owners: Address[] = [];

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    this.cluster = this.config.get<string>('solana.cluster');
    this.rpcUrl = this.config.get<string>('solana.rpcUrl');
    this.commitment = this.config.get<Commitment>('solana.commitment');
    this.ledgerConcurrency = this.config.get<number>('solana.ledgerConcurrency');
    this.priorityFeeLamports = this.config.get<bigint>('solana.priorityFeeLamports');
    this.program = toAddress(this.config.get<string>('solana.programId'));
    this.owners = (this.config.get<string[]>('replication.owners') ?? []).map((o) => toAddress(o));

    this.signer = await loadReplicatorSigner({
      keypairPath: this.config.get<string>('solana.replicatorKeypair'),
      secretKey: this.config.get<string>('solana.replicatorSecretKey'),
    });
    // Retries 429 / 5xx with backoff: public RPCs rate-limit getProgramAccounts
    // and getTransaction hard
    this.rpc = createSolaDBRpc(this.rpcUrl);
    this.sender = new TransactionSender(this.rpc, {
      commitment: 'confirmed',
      timeoutMs: this.config.get<number>('solana.txTimeoutMs'),
    });
    this.ix = soladbInstructions(this.program);
    this.replicatorPda = await pdas.replicator(this.signer.address, this.program);

    // Fail fast: RPC reachable and the program deployed on that cluster
    let version: string;
    try {
      version = (await this.rpc.getVersion().send())['solana-core'];
    } catch (err) {
      throw new Error(`Solana RPC ${this.rpcUrl} is unreachable: ${(err as Error).message}`);
    }
    const { value: programAccount } = await this.rpc
      .getAccountInfo(this.program, {
        encoding: 'base64',
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
      })
      .send();
    if (!programAccount) {
      throw new Error(`SolaDB program ${this.program} does not exist on ${this.rpcUrl}`);
    }
    if (!programAccount.executable) {
      throw new Error(`${this.program} on ${this.rpcUrl} is not an executable program`);
    }

    const configAccount = await fetchAccount<ConfigAccount>(
      this.rpc,
      await pdas.config(this.program),
      'Config',
      'confirmed',
    );
    if (!configAccount) {
      this.logger.warn(`SolaDB is not initialized on ${this.cluster} yet (no Config account)`);
    }

    this.logger.log(`Connected to Solana ${this.cluster}: ${this.rpcUrl} (solana-core ${version}, reads at "${this.commitment}")`);
    this.logger.log(`Replicator authority: ${this.signer.address}`);
    this.logger.log(`SolaDB program: ${this.program}`);
    if (this.owners.length > 0) {
      this.logger.log(`Replicating only chunks of: ${this.owners.join(', ')}`);
    }
  }

  // ── Chunk scan ──────────────────────────────────────────────────────────────

  /**
   * Every Chunk account that still wants replicas: complete, not reclaimed
   * and short of its required confirmations (`needs_replicas == true`).
   * With REPLICATE_OWNERS, only those uploaders' chunks (one filtered
   * getProgramAccounts per owner).
   */
  async listChunksNeedingReplicas(): Promise<FetchedAccount<ChunkAccount>[]> {
    const needsReplicas = { offset: OFFSETS.chunk.needsReplicas, bytes: Uint8Array.of(1) };
    const options = { program: this.program, commitment: this.commitment };
    if (this.owners.length === 0) {
      return listAccounts<ChunkAccount>(this.rpc, 'Chunk', [needsReplicas], options);
    }
    const out: FetchedAccount<ChunkAccount>[] = [];
    for (const owner of this.owners) {
      const ownerFilter = { offset: OFFSETS.chunk.owner, bytes: addressBytes(owner) };
      out.push(...(await listAccounts<ChunkAccount>(this.rpc, 'Chunk', [needsReplicas, ownerFilter], options)));
    }
    return out;
  }

  async getChunk(
    chunk: Address,
    commitment: Commitment = this.commitment,
  ): Promise<FetchedAccount<ChunkAccount> | null> {
    return fetchAccount<ChunkAccount>(this.rpc, chunk, 'Chunk', commitment);
  }

  /**
   * True when `chunk` is the SolaDB chunk PDA of its owner + content hash.
   * Only the program can create an account there, so a look-alike account
   * (same layout, owned by another program, read by address) fails this.
   */
  async isChunkAddress(chunk: Address, data: Pick<ChunkAccount, 'owner' | 'contentHash'>): Promise<boolean> {
    return (await pdas.chunk(data.owner, data.contentHash, this.program)) === chunk;
  }

  /** Many chunks at once (null for closed / missing accounts) */
  async getChunks(
    chunks: Address[],
    commitment: Commitment = this.commitment,
  ): Promise<(FetchedAccount<ChunkAccount> | null)[]> {
    return fetchAccounts<ChunkAccount>(this.rpc, chunks, 'Chunk', commitment);
  }

  /**
   * Rebuild a chunk from the ledger and check it against `contentHash`.
   * Throws when a segment is missing or the bytes do not hash to it.
   */
  async readChunk(chunk: Address, contentHash: Uint8Array): Promise<LedgerChunk> {
    const segments = await readSegments(this.rpc, chunk, {
      commitment: this.commitment,
      concurrency: this.ledgerConcurrency,
      program: this.program,
    });
    const data = assembleChunk(segments, contentHash);
    const slot = segments.reduce((max, s) => (s.slot > max ? s.slot : max), 0n);
    return { data, slot };
  }

  // ── Replicator account ──────────────────────────────────────────────────────

  /** This node's Replicator account, or null when the admin has not registered it */
  async getReplicator(commitment: Commitment = this.commitment): Promise<ReplicatorAccount | null> {
    const account = await fetchAccount<ReplicatorAccount>(
      this.rpc,
      this.replicatorPda,
      'Replicator',
      commitment,
    );
    return account?.data ?? null;
  }

  /** Every registered replicator, active or not (their endpoints serve chunks) */
  async listReplicators(): Promise<ReplicatorAccount[]> {
    const accounts = await listAccounts<ReplicatorAccount>(this.rpc, 'Replicator', [], {
      program: this.program,
      commitment: 'confirmed',
    });
    return accounts.map((a) => a.data);
  }

  // ── Blobs (docs/blob-protocol.md) ───────────────────────────────────────────

  /**
   * Blob accounts with a vacant shard slot (memcmp on `needs_holders`),
   * limited to REPLICATE_OWNERS when set.  Read at "confirmed": blobs are
   * verified against their root, not against the ledger.
   */
  async listBlobsNeedingHolders(): Promise<FetchedAccount<BlobAccount>[]> {
    const needsHolders = { offset: OFFSETS.blob.needsHolders, bytes: Uint8Array.of(1) };
    const options = { program: this.program, commitment: 'confirmed' as Commitment };
    if (this.owners.length === 0) return listAccounts<BlobAccount>(this.rpc, 'Blob', [needsHolders], options);
    const out: FetchedAccount<BlobAccount>[] = [];
    for (const owner of this.owners) {
      const ownerFilter = { offset: OFFSETS.blob.owner, bytes: addressBytes(owner) };
      out.push(...(await listAccounts<BlobAccount>(this.rpc, 'Blob', [needsHolders, ownerFilter], options)));
    }
    return out;
  }

  /** Every blob account (challengers pick random held slots from it) */
  async listBlobs(): Promise<FetchedAccount<BlobAccount>[]> {
    return listAccounts<BlobAccount>(this.rpc, 'Blob', [], { program: this.program, commitment: 'confirmed' });
  }

  async getBlob(blob: Address, commitment: Commitment = 'confirmed'): Promise<FetchedAccount<BlobAccount> | null> {
    return fetchAccount<BlobAccount>(this.rpc, blob, 'Blob', commitment);
  }

  /** Many blobs at once (null for closed / missing accounts) */
  async getBlobs(blobs: Address[], commitment: Commitment = 'confirmed'): Promise<(FetchedAccount<BlobAccount> | null)[]> {
    return fetchAccounts<BlobAccount>(this.rpc, blobs, 'Blob', commitment);
  }

  /** The address is the program's blob PDA for (owner, root): only the program can create it */
  async isBlobAddress(blob: Address, data: Pick<BlobAccount, 'owner' | 'root'>): Promise<boolean> {
    return (await pdas.blob(data.owner, data.root, this.program)) === blob;
  }

  /** Whether `owner`'s blobs may be stored here (REPLICATE_OWNERS) */
  replicatesOwner(owner: Address): boolean {
    return this.owners.length === 0 || this.owners.includes(owner);
  }

  async getConfig(): Promise<ConfigAccount | null> {
    const account = await fetchAccount<ConfigAccount>(this.rpc, await pdas.config(this.program), 'Config', 'confirmed');
    return account?.data ?? null;
  }

  /** Take shard slot `index` of `blob` (this node stored and verified the shard) */
  async confirmShard(blob: Address, index: number): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.confirmShard(this.signer, blob, index)],
      options: this._txOptions(),
      label: `confirm_shard ${blob}#${index}`,
    });
  }

  async createChallenge(blob: Address, index: number): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.createChallenge(this.signer, blob, index)],
      options: this._txOptions(),
      label: `create_challenge ${blob}#${index}`,
    });
  }

  /**
   * Answer a challenge: the 1 KiB segment plus its Merkle path.  The
   * instruction carries ~2 KB, so it goes in a v1 transaction (4 KiB), which
   * budgets loaded account data explicitly: program + SlotHashes + blob.
   */
  async proveShard(
    blob: Address,
    index: number,
    segment: Uint8Array,
    shardProof: Uint8Array[],
    topProof: Uint8Array[],
    blobSize: number,
  ): Promise<Signature> {
    const programBytes = await this._programDataSize();
    const raw = programBytes + 36 + SLOT_HASHES_SIZE + blobSize + 4 * 128;
    return this.sender.send({
      feePayer: this.signer,
      instructions: [this.ix.proveShard(this.signer, blob, index, segment, shardProof, topProof)],
      options: {
        version: 1,
        computeUnitLimit: PROVE_SHARD_CU,
        loadedAccountsDataSizeLimit: Math.ceil(raw / 32_768) * 32_768,
        priorityFeeLamports: this.priorityFeeLamports,
      },
      label: `prove_shard ${blob}#${index}`,
    });
  }

  async failChallenge(blob: Address, index: number): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.failChallenge(this.signer, blob, index)],
      options: this._txOptions(),
      label: `fail_challenge ${blob}#${index}`,
    });
  }

  async claimShardRewards(blob: Address, index: number): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.claimShardRewards(this.signer, blob, index)],
      options: this._txOptions(),
      label: `claim_shard_rewards ${blob}#${index}`,
    });
  }

  /**
   * The hash a challenge on `slot` is answered with: that of the first
   * produced slot at or after it (a skipped slot has no entry), or null when
   * none is recorded yet
   */
  async getSlotHash(slot: bigint): Promise<Uint8Array | null> {
    const { value } = await this.rpc
      .getAccountInfo(SLOT_HASHES_ADDRESS, { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!value) return null;
    return challengeSlotHash(new Uint8Array(Buffer.from(value.data[0], 'base64')), slot);
  }

  async currentSlot(): Promise<bigint> {
    return this.rpc.getSlot({ commitment: 'confirmed' }).send();
  }

  private programDataSize?: number;
  private async _programDataSize(): Promise<number> {
    if (this.programDataSize === undefined) {
      const { value } = await this.rpc
        .getAccountInfo(await pdas.programData(this.program), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } })
        .send();
      this.programDataSize = Number(value?.space ?? 1_048_576n);
    }
    return this.programDataSize;
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  /**
   * Confirm that this node stores `chunk`; the program pays the chunk's
   * reward to the replicator authority in the same transaction.  `owner`
   * must be the chunk's owner: the last confirmation closes the chunk
   * account and refunds its rent to it.  Program errors surface as
   * SolaDBTransactionError with `.code` set.
   */
  async confirmReplication(chunk: Address, owner: Address): Promise<Signature> {
    return this.confirmReplications([{ address: chunk, owner }]);
  }

  /**
   * Confirm up to MAX_CONFIRMATIONS_PER_TX chunks in one transaction.  It is
   * atomic: one failing instruction (e.g. a chunk another replica just
   * completed) fails them all.
   */
  async confirmReplications(chunks: ChunkToConfirm[]): Promise<Signature> {
    const request: TxRequest = {
      feePayer: this.signer,
      instructions: await Promise.all(
        chunks.map((c) => this.ix.confirmReplication(this.signer, c.address, c.owner)),
      ),
      options: this._txOptions(CONFIRM_REPLICATION_CU * chunks.length),
      label: chunks.length === 1
        ? `confirm_replication ${chunks[0].address}`
        : `confirm_replication of ${chunks.length} chunks`,
    };
    // message + signature count + one signature
    const size = this.sender.messageSize(request) + 1 + 64;
    if (size > PACKET_DATA_SIZE) {
      throw new Error(`${chunks.length} confirmations take ${size} bytes, more than one transaction holds (${PACKET_DATA_SIZE})`);
    }
    return this.sender.send(request);
  }

  async updateEndpoint(endpoint: string): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.updateReplicatorEndpoint(this.signer, endpoint)],
      options: this._txOptions(),
      label: 'update_replicator_endpoint',
    });
  }

  private _txOptions(computeUnitLimit = CONFIRM_REPLICATION_CU): TxOptions {
    if (this.priorityFeeLamports === 0n) return { version: 0 };
    return {
      version: 0,
      computeUnitLimit,
      priorityFeeLamports: this.priorityFeeLamports,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Replicator authority (fee payer, reward recipient) */
  get address(): Address {
    return this.signer.address;
  }

  /** Cluster details for /status; the RPC URL is cut to its origin (API keys) */
  get network(): { cluster: string; rpcUrl: string; programId: string; commitment: Commitment } {
    let rpcUrl = this.rpcUrl;
    try {
      rpcUrl = new URL(this.rpcUrl).origin;
    } catch {
      // not a URL; shown as configured
    }
    return { cluster: this.cluster, rpcUrl, programId: this.program, commitment: this.commitment };
  }

  /** SOL balance of the replicator authority (lamports) */
  async getBalance(): Promise<bigint> {
    const { value } = await this.rpc
      .getBalance(this.signer.address, { commitment: 'confirmed' })
      .send();
    return value;
  }

  async getSlot(): Promise<bigint> {
    return this.rpc.getSlot({ commitment: this.commitment }).send();
  }
}
