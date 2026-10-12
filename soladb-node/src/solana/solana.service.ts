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
  TransactionSender,
  TxOptions,
} from '@soladb/sdk';
import { loadReplicatorSigner } from './keypair';

/** Compute budget for confirm_replication when a priority fee is set (uses ~9.2k CU) */
const CONFIRM_REPLICATION_CU = 40_000;

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
 *   • send `confirm_replication` / `update_replicator_endpoint`.
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

  // ── Transactions ────────────────────────────────────────────────────────────

  /**
   * Confirm that this node stores `chunk`; the program pays the chunk's
   * reward to the replicator authority in the same transaction.  Program
   * errors surface as SolaDBTransactionError with `.code` set.
   */
  async confirmReplication(chunk: Address): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.confirmReplication(this.signer, chunk)],
      options: this._txOptions(),
      label: `confirm_replication ${chunk}`,
    });
  }

  async updateEndpoint(endpoint: string): Promise<Signature> {
    return this.sender.send({
      feePayer: this.signer,
      instructions: [await this.ix.updateReplicatorEndpoint(this.signer, endpoint)],
      options: this._txOptions(),
      label: 'update_replicator_endpoint',
    });
  }

  private _txOptions(): TxOptions {
    if (this.priorityFeeLamports === 0n) return { version: 0 };
    return {
      version: 0,
      computeUnitLimit: CONFIRM_REPLICATION_CU,
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
