import {
  Address,
  address as toAddress,
  Commitment,
  createSignableMessage,
  generateKeyPairSigner,
  Instruction,
  isMessagePartialSigner,
  Rpc,
  SolanaRpcApi,
  TransactionSigner,
} from '@solana/kit';
import { addressBytes, fetchAccount, fetchAccounts, listAccounts } from './accounts';
import { PROGRAM_ADDRESS } from './codec';
import {
  decryptBytes,
  deriveEncryptionKeyPair,
  ENCRYPTION_OVERHEAD,
  EncryptionKeyPair,
  encryptBytes,
  open,
  randomKey,
  seal,
  SEAL_OVERHEAD,
  sha256,
  SignMessage,
} from './crypto';
import { readChunkFromLedger } from './ledger';
import { createSolaDBRpc } from './rpc';
import { decodeIndex, decodeManifest, encodeIndex, encodeManifest, FILE_SCHEMA, FileManifest, toHex } from './manifest';
import {
  soladbInstructions,
  ChunkAccount,
  chunkAccountSize,
  ChunkState,
  ConfigAccount,
  GrantAccount,
  grantAccountSize,
  IdentityAccount,
  OFFSETS,
  pdas,
  quoteChunk,
  RecordAccount,
  recordAccountSize,
  ReplicatorAccount,
  transferSol,
} from './program';
import { SOLADB_ERRORS, TransactionSender, TxOptions, TxRequest, TxVersion } from './transactions';

/** Shape of deployments/solana-<cluster>.json (the fields the SDK reads) */
export interface SolaDBDeployment {
  cluster: string;
  rpcUrl: string;
  programId: string;
  /** Slot of the deployment, informative */
  deploySlot?: number;
  /** Public replicator endpoints, if the deployment advertises any */
  nodes?: string[];
}

export interface SolaDBClientOptions {
  /** RPC URL or a kit Rpc (defaults to deployment.rpcUrl) */
  rpc?: Rpc<SolanaRpcApi> | string;
  /** The user's wallet (kit TransactionSigner: KeyPairSigner, wallet-standard signer…) */
  signer: TransactionSigner;
  /** Signs raw bytes with the wallet key (once, to derive the encryption key).
   *  Optional when `signer` is a kit MessagePartialSigner (e.g. a KeyPairSigner). */
  signMessage?: SignMessage;
  deployment?: SolaDBDeployment;
  /** Program address (defaults to deployment.programId, then the built-in id) */
  programId?: string;
  /** Replicator HTTP endpoints tried first for downloads */
  nodeUrls?: string[];
  /** Plaintext bytes per chunk (default 256 KiB, at most ~1 MiB) */
  chunkSize?: number;
  /** Replicas requested per chunk (default 1) */
  replicas?: number;
  /** Transaction format for segment writes: 1 (4 KiB, default) or 0 (1232 bytes) */
  segmentTxVersion?: TxVersion;
  /** Write segments with a throwaway session key funded by the wallet, so the
   *  wallet signs once per upload (default true) */
  sessionWriter?: boolean;
  /** Priority fee per transaction, in lamports (default 0) */
  priorityFeeLamports?: bigint;
  /** Commitment for confirmations and reads (default "confirmed") */
  commitment?: Commitment;
  /** Transactions in flight at once (default 8) */
  concurrency?: number;
  /** Rebuild chunks from the ledger when no replicator has them (default true) */
  ledgerFallback?: boolean;
  /** Custom chunk source (tests, gateways) tried before the replicators */
  fetchChunk?: (chunk: ChunkRef) => Promise<Uint8Array>;
  /** Give up on a replicator after this long (default 30 s) */
  nodeTimeoutMs?: number;
}

export interface ChunkRef {
  address: Address;
  owner: Address;
  contentHash: Uint8Array;
}

export interface UploadOptions {
  name: string;
  mime?: string;
  replicas?: number;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  stage: 'sign' | 'open' | 'segments' | 'done';
  done: number;
  total: number;
}

export interface UploadResult {
  recordId: Address;
  /** Chunk accounts (data chunks, then the index chunk if any) */
  chunks: Address[];
  size: number;
  /** Upload fees paid to the protocol and replicators (lamports) */
  feePaid: bigint;
  /** Rent locked in chunk + record accounts, refundable (lamports) */
  rentDeposit: bigint;
  /** Wallet-signed transactions */
  signatures: string[];
  /** Segment transactions written to the ledger */
  segmentTransactions: number;
}

export interface FileQuote {
  chunks: number;
  segments: number;
  /** Paid to the protocol and replicators */
  uploadFee: bigint;
  /** Refundable rent of the chunk and record accounts */
  rentDeposit: bigint;
  /** Base fees of every transaction (wallet + segment writes) */
  networkFee: bigint;
  total: bigint;
}

export interface DownloadResult {
  name: string;
  mime: string;
  data: Uint8Array;
  manifest: FileManifest;
}

export interface ChunkStatus {
  address: Address;
  state: ChunkState | 'Closed';
  confirmedReplicas: number;
  requiredReplicas: number;
  replicators: Address[];
}

export interface FileEntry {
  recordId: Address;
  owner: Address;
  /** true when another wallet shared it with this one */
  shared: boolean;
  createdAt: number;
}

/** Records whose sealed manifest would not fit a v0 transaction use an index chunk */
const LEGACY_TX_LIMIT = 1232;
const V1_TX_LIMIT = 4096;
const SIGNATURE_FEE = 5_000n;
const WRITE_SEGMENT_CU = 10_000;

const signMessageWith =
  (signer: TransactionSigner): SignMessage =>
  async (message) => {
    if (!isMessagePartialSigner(signer)) {
      throw new Error('Pass `signMessage` (the wallet cannot sign messages through this signer)');
    }
    const [dictionary] = await signer.signMessages([createSignableMessage(message)]);
    return new Uint8Array(dictionary[signer.address]);
  };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * High-level SolaDB client: encrypted files on Solana.
 *
 *   const soladb = new SolaDBClient({ signer, deployment: DEPLOYMENTS.devnet });
 *   await soladb.register();
 *   const { recordId } = await soladb.uploadFile(bytes, { name: 'report.pdf' });
 *   const { data } = await soladb.downloadFile(recordId);
 *   await soladb.share(recordId, friendAddress);
 *
 * Files are encrypted with a random key (AES-256-GCM) and split into chunks.
 * The wallet signs one batch (open + pay every chunk, create the record);
 * a session key then writes the encrypted bytes to the ledger in segments.
 * The manifest (chunk hashes + key) is sealed to the owner's X25519 key;
 * sharing seals it again for the reader's published key.
 */
export class SolaDBClient {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly signer: TransactionSigner;
  readonly program: Address;
  readonly sender: TransactionSender;

  private readonly ix: ReturnType<typeof soladbInstructions>;
  private readonly signMessage: SignMessage;
  private nodeUrls: string[];
  private readonly chunkSize: number;
  private readonly replicas: number;
  private readonly segmentTxVersion: TxVersion;
  private readonly sessionWriter: boolean;
  private readonly priorityFeeLamports: bigint;
  private readonly commitment: Commitment;
  private readonly ledgerFallback: boolean;
  private readonly customFetch?: (chunk: ChunkRef) => Promise<Uint8Array>;
  private readonly nodeTimeoutMs: number;
  private activeEndpoints?: { urls: string[]; at: number };
  private keyPair?: Promise<EncryptionKeyPair>;
  private configCache?: { value: ConfigAccount; at: number };
  private segmentSizeCache = new Map<TxVersion, number>();
  private loadedDataLimit?: number;
  private endpoints = new Map<Address, string | null>();

  constructor(options: SolaDBClientOptions) {
    const rpc = options.rpc ?? options.deployment?.rpcUrl;
    if (!rpc) throw new Error('Pass `rpc` or a `deployment` with an rpcUrl');
    this.rpc = typeof rpc === 'string' ? createSolaDBRpc(rpc) : rpc;
    this.signer = options.signer;
    this.program = toAddress(options.programId ?? options.deployment?.programId ?? PROGRAM_ADDRESS);
    this.ix = soladbInstructions(this.program);
    this.signMessage = options.signMessage ?? signMessageWith(options.signer);
    this.nodeUrls = (options.nodeUrls ?? options.deployment?.nodes ?? []).map((u) => u.replace(/\/$/, ''));
    this.chunkSize = options.chunkSize ?? 256 * 1024;
    this.replicas = options.replicas ?? 1;
    this.segmentTxVersion = options.segmentTxVersion ?? 1;
    this.sessionWriter = options.sessionWriter ?? true;
    this.priorityFeeLamports = options.priorityFeeLamports ?? 0n;
    this.commitment = options.commitment ?? 'confirmed';
    this.ledgerFallback = options.ledgerFallback ?? true;
    this.customFetch = options.fetchChunk;
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 30_000;
    this.sender = new TransactionSender(this.rpc, { commitment: this.commitment, concurrency: options.concurrency ?? 8 });
  }

  get address(): Address {
    return this.signer.address;
  }

  /** Replace the replicator endpoints tried first for downloads */
  setNodeUrls(urls: string[]): void {
    this.nodeUrls = urls.map((u) => u.replace(/\/$/, ''));
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  /** The wallet's encryption key pair (one message signature, then cached) */
  keys(): Promise<EncryptionKeyPair> {
    this.keyPair ??= deriveEncryptionKeyPair(this.signMessage).catch((err) => {
      this.keyPair = undefined;
      throw err;
    });
    return this.keyPair;
  }

  async identity(user: Address = this.address): Promise<IdentityAccount | null> {
    const account = await fetchAccount<IdentityAccount>(this.rpc, await pdas.identity(user, this.program), 'Identity', this.commitment);
    return account?.data ?? null;
  }

  async isRegistered(user: Address = this.address): Promise<boolean> {
    return (await this.identity(user)) !== null;
  }

  /**
   * Publish this wallet's encryption key.  Registers it the first time and
   * rotates it if a different key is on-chain.  Returns the signature, or
   * null when nothing had to change.
   */
  async register(): Promise<string | null> {
    const { publicKey } = await this.keys();
    const current = await this.identity();
    if (current && toHex(current.encryptionKey) === toHex(publicKey)) return null;
    const instruction = current
      ? await this.ix.updateIdentity(this.signer, publicKey)
      : await this.ix.registerIdentity(this.signer, publicKey);
    return this.sender.send(this.ownerTx([instruction], 'register'));
  }

  // ── Pricing ────────────────────────────────────────────────────────────────

  async config(fresh = false): Promise<ConfigAccount> {
    if (!fresh && this.configCache && Date.now() - this.configCache.at < 30_000) return this.configCache.value;
    const account = await fetchAccount<ConfigAccount>(this.rpc, await pdas.config(this.program), 'Config', this.commitment);
    if (!account) throw new Error(`SolaDB is not initialized on this cluster (program ${this.program})`);
    this.configCache = { value: account.data, at: Date.now() };
    return account.data;
  }

  /** Cost breakdown (lamports) for uploading `size` plaintext bytes */
  async quoteFile(size: number, replicas = this.replicas): Promise<FileQuote> {
    const config = await this.config();
    const segmentSize = await this.segmentSize(this.segmentTxVersion);
    const chunkSizes = this.encryptedChunkSizes(size);
    const indexed = chunkSizes.length > this.inlineChunkLimit();
    if (indexed) chunkSizes.push(32 * chunkSizes.length + ENCRYPTION_OVERHEAD);

    let uploadFee = 0n;
    let rent = 0n;
    let segments = 0;
    for (const chunk of chunkSizes) {
      const count = Math.ceil(chunk / segmentSize);
      segments += count;
      uploadFee += quoteChunk(config, chunk, replicas);
      rent += await this.rentExempt(chunkAccountSize(count, replicas));
    }
    const manifestBytes = 90 + 32 * (indexed ? 1 : chunkSizes.length) + SEAL_OVERHEAD;
    rent += await this.rentExempt(recordAccountSize(FILE_SCHEMA.length, manifestBytes));
    const walletTxs = Math.ceil(chunkSizes.length / 6) + 1;
    const networkFee = (BigInt(segments + walletTxs + (this.sessionWriter ? 1 : 0)) * (SIGNATURE_FEE + this.priorityFeeLamports));
    return { chunks: chunkSizes.length, segments, uploadFee, rentDeposit: rent, networkFee, total: uploadFee + rent + networkFee };
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  async uploadFile(data: Uint8Array, options: UploadOptions): Promise<UploadResult> {
    const replicas = options.replicas ?? this.replicas;
    const progress = options.onProgress ?? (() => undefined);
    const [config, identity, keys] = await Promise.all([this.config(), this.identity(), this.keys()]);
    if (!identity) throw new Error('Register this wallet first (SolaDBClient.register)');
    if (toHex(identity.encryptionKey) !== toHex(keys.publicKey)) {
      throw new Error('The published encryption key is not this wallet\'s; call register() to rotate it');
    }

    // 1. Encrypt and split
    const dek = randomKey();
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < data.length || parts.length === 0; offset += this.chunkSize) {
      parts.push(encryptBytes(dek, data.subarray(offset, offset + this.chunkSize)));
    }
    const hashes = parts.map((p) => sha256(p));
    const manifest: FileManifest = {
      v: 2,
      name: options.name,
      mime: options.mime ?? 'application/octet-stream',
      size: data.length,
      chunkSize: this.chunkSize,
      sha256: sha256(data),
      dek,
      createdAt: Math.floor(Date.now() / 1000),
      chunkCount: parts.length,
      chunks: hashes,
    };

    // 2. Keep the record in one transaction; large files move the chunk list to an index chunk
    const nonce = identity.recordNonce;
    let sealed = seal(keys.publicKey, encodeManifest(manifest));
    let recordIx = await this.ix.createRecord(this.signer, nonce, FILE_SCHEMA, sealed);
    if (this.sender.messageSize(this.ownerTx([recordIx])) > LEGACY_TX_LIMIT) {
      const indexChunk = encryptBytes(dek, encodeIndex(hashes));
      parts.push(indexChunk);
      const indexHash = sha256(indexChunk);
      hashes.push(indexHash);
      sealed = seal(keys.publicKey, encodeManifest({ ...manifest, chunks: [], index: indexHash }));
      recordIx = await this.ix.createRecord(this.signer, nonce, FILE_SCHEMA, sealed);
    }

    // 3. One wallet batch: fund the session writer, open + pay each chunk, create the record
    const segmentSize = await this.segmentSize(this.segmentTxVersion);
    const writer = this.sessionWriter ? await generateKeyPairSigner() : this.signer;
    const chunkAddresses = await Promise.all(hashes.map((h) => pdas.chunk(this.address, h, this.program)));
    const segmentCount = parts.reduce((n, p) => n + Math.ceil(p.length / segmentSize), 0);

    const ownerInstructions: Instruction[] = [];
    if (this.sessionWriter) {
      const perTx = SIGNATURE_FEE + this.priorityFeeLamports;
      const budget = (BigInt(segmentCount + 1) * perTx * 11n) / 10n + (await this.rentExempt(0));
      ownerInstructions.push(transferSol(this.signer, writer.address, budget));
    }
    let feePaid = 0n;
    let rentDeposit = 0n;
    for (let i = 0; i < parts.length; i++) {
      const fee = quoteChunk(config, parts[i].length, replicas);
      feePaid += fee;
      rentDeposit += await this.rentExempt(chunkAccountSize(Math.ceil(parts[i].length / segmentSize), replicas));
      ownerInstructions.push(
        await this.ix.openChunk(this.signer, config.treasury, {
          contentHash: hashes[i],
          size: parts[i].length,
          segmentSize,
          replicas,
          writer: writer.address,
          maxFee: fee,
        }),
      );
    }
    ownerInstructions.push(recordIx);
    rentDeposit += await this.rentExempt(recordAccountSize(FILE_SCHEMA.length, sealed.length));

    const ownerTxs = this.pack(ownerInstructions, 'upload');
    progress({ stage: 'sign', done: 0, total: ownerTxs.length });
    let opened = 0;
    let written = 0;
    let ownerResults: { signature: string }[] = [];
    try {
      ownerResults = await this.sender.sendAll(ownerTxs, {
        onConfirmed: () => progress({ stage: 'open', done: ++opened, total: ownerTxs.length }),
      });

      // 4. Session key writes the segments (each index lands once; retries are safe)
      const writeOptions = await this.segmentTxOptions();
      const requests: TxRequest[] = [];
      parts.forEach((part, c) => {
        for (let index = 0; index * segmentSize < part.length; index++) {
          const slice = part.subarray(index * segmentSize, (index + 1) * segmentSize);
          requests.push({
            feePayer: writer,
            instructions: [this.ix.writeSegment(writer, chunkAddresses[c], index, slice)],
            options: writeOptions,
            label: `segment ${index} of chunk ${c}`,
          });
        }
      });
      const wave = this.sender.concurrency * 8;
      for (let i = 0; i < requests.length; i += wave) {
        await this.sender.sendAll(requests.slice(i, i + wave), {
          isDone: (code) => code === SOLADB_ERRORS.SegmentAlreadyWritten,
          onConfirmed: () => progress({ stage: 'segments', done: ++written, total: requests.length }),
        });
      }
    } finally {
      // return the session key's lamports even when a step failed
      if (this.sessionWriter) await this.sweep(writer).catch(() => undefined);
    }

    const recordId = await pdas.record(this.address, nonce, this.program);
    progress({ stage: 'done', done: 1, total: 1 });
    return {
      recordId,
      chunks: chunkAddresses,
      size: data.length,
      feePaid,
      rentDeposit,
      signatures: ownerResults.map((r) => r.signature),
      segmentTransactions: written,
    };
  }

  /** Decrypt the manifest of a record this wallet owns or was granted */
  async getManifest(recordId: string): Promise<FileManifest> {
    const record = await this.record(recordId);
    let content = record.content;
    if (record.owner !== this.address) {
      const grant = await fetchAccount<GrantAccount>(
        this.rpc,
        await pdas.grant(toAddress(recordId), this.address, this.program),
        'Grant',
        this.commitment,
      );
      if (!grant) throw new Error(`Record ${recordId} is not shared with ${this.address}`);
      content = grant.data.content;
    }
    return decodeManifest(open(await this.keys(), content));
  }

  async downloadFile(recordId: string): Promise<DownloadResult> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    const refs = await this.chunkRefs(record.owner, manifest);

    const plain: Uint8Array[] = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const i = next++;
        plain[i] = decryptBytes(manifest.dek, await this.fetchVerified(refs[i]));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
    const total = plain.reduce((n, p) => n + p.length, 0);
    if (total !== manifest.size) throw new Error(`Integrity check failed for record ${recordId}`);
    const data = new Uint8Array(total);
    let offset = 0;
    for (const p of plain) {
      data.set(p, offset);
      offset += p.length;
    }
    if (toHex(sha256(data)) !== toHex(manifest.sha256)) {
      throw new Error(`Integrity check failed for record ${recordId}`);
    }
    return { name: manifest.name, mime: manifest.mime, data, manifest };
  }

  /** Give `viewer` (who must have registered) read access to a file */
  async share(recordId: string, viewer: string): Promise<string> {
    const viewerAddress = toAddress(viewer);
    const identity = await this.identity(viewerAddress);
    if (!identity) throw new Error(`${viewerAddress} has no SolaDB identity yet`);
    const manifest = await this.getManifest(recordId);
    const sealed = seal(identity.encryptionKey, encodeManifest(manifest));
    const record = toAddress(recordId);
    const grantAddress = await pdas.grant(record, viewerAddress, this.program);
    const exists = await fetchAccount(this.rpc, grantAddress, 'Grant', this.commitment);
    const instruction = exists
      ? await this.ix.updateGrant(this.signer, record, viewerAddress, sealed)
      : await this.ix.grantAccess(this.signer, record, viewerAddress, sealed);
    return this.sender.send(this.ownerTx([instruction], 'share'));
  }

  async revoke(recordId: string, viewer: string): Promise<string> {
    return this.sender.send(
      this.ownerTx([await this.ix.revokeAccess(this.signer, toAddress(recordId), toAddress(viewer))], 'revoke'),
    );
  }

  /** Wallets that hold a grant on the record */
  async viewers(recordId: string): Promise<Address[]> {
    const grants = await listAccounts<GrantAccount>(this.rpc, 'Grant', [{ offset: OFFSETS.grant.record, bytes: addressBytes(toAddress(recordId)) }], {
      program: this.program,
      commitment: this.commitment,
    });
    return grants.map((g) => g.data.viewer);
  }

  /**
   * Delete a file: revoke every grant, close the record and, with
   * `closeChunks`, close the chunks that are settled.  Rent comes back.
   */
  async deleteFile(recordId: string, { closeChunks = true } = {}): Promise<string[]> {
    const record = toAddress(recordId);
    const owner = (await this.record(recordId)).owner;
    if (owner !== this.address) throw new Error('Only the owner can delete a file');
    const manifest = closeChunks ? await this.getManifest(recordId) : undefined;
    const instructions: Instruction[] = [];
    for (const viewer of await this.viewers(recordId)) instructions.push(await this.ix.revokeAccess(this.signer, record, viewer));
    instructions.push(this.ix.deleteRecord(this.signer, record));
    if (manifest) instructions.push(...(await this.closeSettledChunks(manifest)));
    const results = await this.sender.sendAll(this.pack(instructions, 'delete'));
    return results.map((r) => r.signature);
  }

  /** Close the settled chunks of a file to recover their rent (the data stays on replicators) */
  async reclaimDeposits(recordId: string): Promise<{ closed: number; signatures: string[] }> {
    const manifest = await this.getManifest(recordId);
    const instructions = await this.closeSettledChunks(manifest);
    if (instructions.length === 0) return { closed: 0, signatures: [] };
    const results = await this.sender.sendAll(this.pack(instructions, 'reclaim'));
    return { closed: instructions.length, signatures: results.map((r) => r.signature) };
  }

  /**
   * Close every settled chunk this wallet owns, including chunks of deleted
   * files that no manifest points to any more.  Returns the rent recovered.
   */
  async reclaimAllDeposits(): Promise<{ closed: number; lamports: bigint; signatures: string[] }> {
    const chunks = await listAccounts<ChunkAccount>(this.rpc, 'Chunk', [{ offset: OFFSETS.chunk.owner, bytes: addressBytes(this.address) }], {
      program: this.program,
      commitment: this.commitment,
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const closable = chunks.filter(
      (c) => c.data.state === 'Pending' || c.data.confirmedReplicas === c.data.requiredReplicas || now >= c.data.reclaimableAt,
    );
    if (closable.length === 0) return { closed: 0, lamports: 0n, signatures: [] };
    const results = await this.sender.sendAll(this.pack(closable.map((c) => this.ix.closeChunk(this.signer, c.address)), 'reclaim'));
    return {
      closed: closable.length,
      lamports: closable.reduce((n, c) => n + c.lamports, 0n),
      signatures: results.map((r) => r.signature),
    };
  }

  /** Replication state of every chunk of a file */
  async fileStatus(recordId: string): Promise<{ manifest: FileManifest; chunks: ChunkStatus[]; cool: boolean }> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    const refs = await this.chunkRefs(record.owner, manifest, true);
    const chunks = await this.chunkStatus(refs.map((r) => r.address));
    return { manifest, chunks, cool: chunks.every((c) => c.state === 'Cool' || c.state === 'Closed') };
  }

  async chunkStatus(addresses: Address[]): Promise<ChunkStatus[]> {
    const accounts = await fetchAccounts<ChunkAccount>(this.rpc, addresses, 'Chunk', this.commitment);
    return accounts.map((account, i) =>
      account
        ? {
            address: addresses[i],
            state: account.data.state,
            confirmedReplicas: account.data.confirmedReplicas,
            requiredReplicas: account.data.requiredReplicas,
            replicators: account.data.replicators,
          }
        : { address: addresses[i], state: 'Closed', confirmedReplicas: 0, requiredReplicas: 0, replicators: [] },
    );
  }

  /** Resolve once every chunk is Cool (replicated) */
  async waitUntilCool(addresses: Address[], { timeoutMs = 180_000, pollMs = 2_000 } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.chunkStatus(addresses);
      if (status.every((c) => c.state === 'Cool' || c.state === 'Closed')) return;
      await sleep(pollMs);
    }
    throw new Error(`Chunks not replicated after ${timeoutMs} ms`);
  }

  /** Files this wallet created or was given access to (getProgramAccounts) */
  async listFiles(): Promise<FileEntry[]> {
    const me = addressBytes(this.address);
    const [owned, granted] = await Promise.all([
      listAccounts<RecordAccount>(this.rpc, 'Record', [{ offset: OFFSETS.record.owner, bytes: me }], {
        program: this.program,
        commitment: this.commitment,
      }),
      listAccounts<GrantAccount>(this.rpc, 'Grant', [{ offset: OFFSETS.grant.viewer, bytes: me }], {
        program: this.program,
        commitment: this.commitment,
      }),
    ]);
    const files: FileEntry[] = [
      ...owned
        .filter((r) => r.data.schema === FILE_SCHEMA)
        .map((r) => ({ recordId: r.address, owner: r.data.owner, shared: false, createdAt: Number(r.data.createdAt) })),
      ...granted.map((g) => ({ recordId: g.data.record, owner: g.data.owner, shared: true, createdAt: Number(g.data.grantedAt) })),
    ];
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Registered replicators and their endpoints */
  async replicators(): Promise<{ address: Address; authority: Address; endpoint: string; active: boolean; confirmations: bigint }[]> {
    const accounts = await listAccounts<ReplicatorAccount>(this.rpc, 'Replicator', [], { program: this.program, commitment: this.commitment });
    return accounts.map((a) => ({
      address: a.address,
      authority: a.data.authority,
      endpoint: a.data.endpoint,
      active: a.data.active,
      confirmations: a.data.confirmations,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async record(recordId: string): Promise<RecordAccount> {
    const account = await fetchAccount<RecordAccount>(this.rpc, toAddress(recordId), 'Record', this.commitment);
    if (!account) throw new Error(`Record ${recordId} not found`);
    return account.data;
  }

  /** Chunk references of a file, in order (`withIndex` appends the index chunk) */
  private async chunkRefs(owner: Address, manifest: FileManifest, withIndex = false): Promise<ChunkRef[]> {
    const ref = async (contentHash: Uint8Array): Promise<ChunkRef> => ({
      address: await pdas.chunk(owner, contentHash, this.program),
      owner,
      contentHash,
    });
    if (!manifest.index) return Promise.all(manifest.chunks.map(ref));
    const indexRef = await ref(manifest.index);
    const hashes = decodeIndex(decryptBytes(manifest.dek, await this.fetchVerified(indexRef)));
    const refs = await Promise.all(hashes.map(ref));
    return withIndex ? [...refs, indexRef] : refs;
  }

  private async closeSettledChunks(manifest: FileManifest): Promise<Instruction[]> {
    const refs = await this.chunkRefs(this.address, manifest, true).catch(async () =>
      // index chunk unreachable: close what the manifest names directly
      Promise.all([...manifest.chunks, ...(manifest.index ? [manifest.index] : [])].map(async (h) => ({
        address: await pdas.chunk(this.address, h, this.program),
        owner: this.address,
        contentHash: h,
      }))),
    );
    const accounts = await fetchAccounts<ChunkAccount>(this.rpc, refs.map((r) => r.address), 'Chunk', this.commitment);
    const now = BigInt(Math.floor(Date.now() / 1000));
    return accounts
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .filter(
        (a) => a.data.state === 'Pending' || a.data.confirmedReplicas === a.data.requiredReplicas || now >= a.data.reclaimableAt,
      )
      .map((a) => this.ix.closeChunk(this.signer, a.address));
  }

  /** Fetch a chunk (custom source, replicators, then the ledger) and check its hash */
  private async fetchVerified(ref: ChunkRef): Promise<Uint8Array> {
    const errors: string[] = [];
    const check = (bytes: Uint8Array) => toHex(sha256(bytes)) === toHex(ref.contentHash);

    if (this.customFetch) {
      try {
        const bytes = await this.customFetch(ref);
        if (check(bytes)) return bytes;
        errors.push('custom source: content hash mismatch');
      } catch (err) {
        errors.push(`custom source: ${(err as Error).message}`);
      }
    }

    for (const url of await this.endpointsFor(ref.address)) {
      try {
        const response = await fetch(`${url}/chunk/${ref.address}/data`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (check(bytes)) return bytes;
        errors.push(`${url}: content hash mismatch`);
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }

    if (this.ledgerFallback) {
      try {
        return await readChunkFromLedger(this.rpc, ref.address, ref.contentHash, { program: this.program });
      } catch (err) {
        errors.push(`ledger: ${(err as Error).message}`);
      }
    }
    throw new Error(`Chunk ${ref.address} unavailable: ${errors.join('; ')}`);
  }

  /** Configured nodes first, then the replicators that confirmed this chunk */
  private async endpointsFor(chunk: Address): Promise<string[]> {
    const urls = [...this.nodeUrls];
    const account = await fetchAccount<ChunkAccount>(this.rpc, chunk, 'Chunk', this.commitment).catch(() => null);
    const unknown = (account?.data.replicators ?? []).filter((r) => !this.endpoints.has(r));
    if (unknown.length > 0) {
      const replicatorPdas = await Promise.all(unknown.map((r) => pdas.replicator(r, this.program)));
      const replicators = await fetchAccounts<ReplicatorAccount>(this.rpc, replicatorPdas, 'Replicator', this.commitment);
      unknown.forEach((r, i) => {
        const rep = replicators[i]?.data;
        this.endpoints.set(r, rep && rep.active ? rep.endpoint.replace(/\/$/, '') : null);
      });
    }
    for (const r of account?.data.replicators ?? []) {
      const url = this.endpoints.get(r);
      if (url && !urls.includes(url)) urls.push(url);
    }
    // closed chunk (or no confirmation yet): any active replicator may hold it
    if (!account || account.data.replicators.length === 0) {
      if (!this.activeEndpoints || Date.now() - this.activeEndpoints.at > 60_000) {
        const all = await this.replicators().catch(() => []);
        this.activeEndpoints = { urls: all.filter((r) => r.active).map((r) => r.endpoint.replace(/\/$/, '')), at: Date.now() };
      }
      for (const url of this.activeEndpoints.urls) if (!urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  private ownerTx(instructions: Instruction[], label?: string): TxRequest {
    const options: TxOptions = { version: 0 };
    if (this.priorityFeeLamports > 0n) {
      options.computeUnitLimit = Math.min(1_400_000, 200_000 * instructions.length);
      options.priorityFeeLamports = this.priorityFeeLamports;
    }
    return { feePayer: this.signer, instructions, options, label };
  }

  /** Greedily pack wallet instructions into as few v0 transactions as fit */
  private pack(instructions: Instruction[], label: string): TxRequest[] {
    const txs: TxRequest[] = [];
    let current: Instruction[] = [];
    for (const instruction of instructions) {
      const candidate = [...current, instruction];
      const fits = this.sender.messageSize(this.ownerTx(candidate)) <= LEGACY_TX_LIMIT && candidate.length <= 12;
      if (fits || current.length === 0) {
        current = candidate;
      } else {
        txs.push(this.ownerTx(current, `${label} ${txs.length + 1}`));
        current = [instruction];
      }
    }
    if (current.length > 0) txs.push(this.ownerTx(current, `${label} ${txs.length + 1}`));
    return txs;
  }

  /** Largest segment that fits one write transaction of `version` */
  async segmentSize(version: TxVersion): Promise<number> {
    const cached = this.segmentSizeCache.get(version);
    if (cached) return cached;
    const limit = version === 1 ? V1_TX_LIMIT : LEGACY_TX_LIMIT;
    const writer = this.signer;
    const options = { ...(await this.segmentTxOptions(version)) };
    const dummyChunk = await pdas.config(this.program);
    const size = (n: number) =>
      this.sender.messageSize({
        feePayer: writer,
        instructions: [this.ix.writeSegment(writer, dummyChunk, 0, new Uint8Array(n))],
        options,
      });
    let lo = 32;
    let hi = 4_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(mid) <= limit) lo = mid;
      else hi = mid - 1;
    }
    this.segmentSizeCache.set(version, lo);
    return lo;
  }

  private async segmentTxOptions(version: TxVersion = this.segmentTxVersion): Promise<TxOptions> {
    if (version === 0) {
      return this.priorityFeeLamports > 0n
        ? { version: 0, computeUnitLimit: WRITE_SEGMENT_CU, priorityFeeLamports: this.priorityFeeLamports }
        : { version: 0 };
    }
    if (this.loadedDataLimit === undefined) {
      // v1 budgets loaded account data explicitly: program + its data, writer, chunk
      const programData = await pdas.programData(this.program);
      const { value } = await this.rpc.getAccountInfo(programData, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
      const programBytes = Number(value?.space ?? 1_048_576n);
      const raw = programBytes + 36 + 8_192 + 4 * 64;
      this.loadedDataLimit = Math.ceil(raw / 32_768) * 32_768;
    }
    return {
      version: 1,
      computeUnitLimit: WRITE_SEGMENT_CU,
      loadedAccountsDataSizeLimit: this.loadedDataLimit,
      priorityFeeLamports: this.priorityFeeLamports,
    };
  }

  /** Send the session key's remaining lamports back to the wallet */
  private async sweep(writer: TransactionSigner): Promise<void> {
    const { value: balance } = await this.rpc.getBalance(writer.address, { commitment: this.commitment }).send();
    const fee = SIGNATURE_FEE;
    if (balance <= fee) return;
    await this.sender.send({
      feePayer: writer,
      instructions: [transferSol(writer, this.address, balance - fee)],
      options: { version: 0 },
      label: 'return session funds',
    });
  }

  private rentCache = new Map<number, bigint>();
  private async rentExempt(size: number): Promise<bigint> {
    const hit = this.rentCache.get(size);
    if (hit !== undefined) return hit;
    const value = await this.rpc.getMinimumBalanceForRentExemption(BigInt(size)).send();
    this.rentCache.set(size, value);
    return value;
  }

  private encryptedChunkSizes(size: number): number[] {
    const sizes: number[] = [];
    for (let offset = 0; offset < size || sizes.length === 0; offset += this.chunkSize) {
      sizes.push(Math.min(this.chunkSize, size - offset) + ENCRYPTION_OVERHEAD);
    }
    return sizes;
  }

  /** Chunks a manifest can list inline before it needs an index chunk */
  private inlineChunkLimit(): number {
    return 16;
  }
}
