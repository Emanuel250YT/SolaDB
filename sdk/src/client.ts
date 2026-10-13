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
import { BundleEntry, BundleFile, chooseLayout, decodeBundle, decodeStripe, encodeBlobs, encodeBundle, stripePlainLengths } from './blob-layout';
import { BLOB_FILE_SCHEMA, BlobManifest, decodeBlobManifest, encodeBlobManifest, isBlobManifest } from './blob-manifest';
import { gunzip, maybeCompress } from './compression';
import { blobRoot, depth, verifyFragment } from './merkle';
import { fromHex } from './manifest';
import { readChunkFromLedger } from './ledger';
import { createSolaDBRpc } from './rpc';
import { decodeIndex, decodeManifest, encodeIndex, encodeManifest, FILE_SCHEMA, FileManifest, toHex } from './manifest';
import {
  BlobAccount,
  blobAccountSize,
  soladbInstructions,
  ChunkAccount,
  chunkAccountSize,
  ChunkState,
  ConfigAccount,
  GrantAccount,
  grantAccountSize,
  IdentityAccount,
  isClosable,
  MAX_DIRECT_CHUNK_SIZE,
  OFFSETS,
  pdas,
  quoteBlob,
  quoteChunk,
  RecordAccount,
  recordAccountSize,
  ReplicatorAccount,
  transferSol,
  VACANT,
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
  /** Where the encrypted bytes go (default "auto"):
   *  - "blob": Reed-Solomon shards, one per replicator node, one account per
   *    blob, storage prepaid per epoch and checked with storage proofs
   *    (docs/blob-protocol.md).  The cheapest and most durable path.
   *  - "direct": whole chunks straight to replicator nodes (one full copy per
   *    replica, one account per 8 MiB chunk).
   *  - "ledger": written to the Solana ledger in 4 KiB transactions, so
   *    replicators and readers can rebuild them without trusting anyone.
   *  - "auto": blob when a replicator node answers, else ledger. */
  mode?: UploadMode;
  /** Blob storage prepaid, in epochs of the program's `epoch_seconds` (default 12) */
  epochs?: number;
  /** Blob parity shards = node losses tolerated (default: by node count, e.g. 10+4 with 14 nodes) */
  redundancy?: number;
  /** Bytes per ledger chunk (default 256 KiB, at most ~1 MiB) */
  chunkSize?: number;
  /** Bytes per direct chunk (default 8 MiB, at most ~16 MiB) */
  directChunkSize?: number;
  /** gzip the file before encryption when it saves ≥ 10 % (default true) */
  compress?: boolean;
  /** Custom delivery of direct chunks (tests, gateways) instead of HTTP PUT to the nodes */
  pushChunk?: (chunk: ChunkRef, data: Uint8Array) => Promise<void>;
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

export type UploadMode = 'blob' | 'direct' | 'ledger' | 'auto';
export type ResolvedMode = 'blob' | 'direct' | 'ledger';
export type AnyManifest = FileManifest | BlobManifest;

export interface UploadOptions {
  name: string;
  mime?: string;
  replicas?: number;
  /** Overrides the client's mode for this file */
  mode?: UploadMode;
  /** Overrides the client's compress setting for this file */
  compress?: boolean;
  /** Blob storage prepaid, in epochs (overrides the client's) */
  epochs?: number;
  /** Blob parity shards (overrides the client's) */
  redundancy?: number;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  /** `push` = direct chunks sent to the nodes, `segments` = ledger writes */
  stage: 'sign' | 'open' | 'segments' | 'push' | 'done';
  done: number;
  total: number;
}

export interface UploadResult {
  recordId: Address;
  mode: ResolvedMode;
  /** Blob accounts (blob mode) */
  blobs?: Address[];
  /** Erasure code (blob mode): any `k` of `k + m` shards rebuild the file */
  layout?: { k: number; m: number; fragmentSize: number };
  /** Storage paid until (blob mode, unix seconds) */
  expiresAt?: bigint;
  /** Bytes encrypted and stored (after compression) */
  storedSize: number;
  /** Nodes that accepted direct chunks */
  nodes: string[];
  /** Chunk accounts (data chunks, then the index chunk if any) */
  chunks: Address[];
  size: number;
  /** Upload fees paid to the protocol and replicators (lamports) */
  feePaid: bigint;
  /** Rent locked in chunk + record accounts, refundable (lamports): chunk
   *  rent comes back by itself once every replica confirmed */
  rentDeposit: bigint;
  /** Wallet-signed transactions */
  signatures: string[];
  /** Segment transactions written to the ledger */
  segmentTransactions: number;
}

export interface FileQuote {
  mode: ResolvedMode;
  /** Blob mode: erasure code, prepaid epochs and how long they last */
  layout?: { k: number; m: number };
  epochs?: number;
  storageSeconds?: bigint;
  chunks: number;
  segments: number;
  /** Paid to the protocol and replicators */
  uploadFee: bigint;
  /** Refundable rent of the chunk and record accounts (chunkRent + recordRent) */
  rentDeposit: bigint;
  /** Chunk rent: back to the wallet by itself once the chunks are fully replicated */
  chunkRent: bigint;
  /** Record rent: back when the file is deleted */
  recordRent: bigint;
  /** Base fees of every transaction (wallet + segment writes) */
  networkFee: bigint;
  total: bigint;
}

export interface DownloadResult {
  name: string;
  mime: string;
  data: Uint8Array;
  manifest: AnyManifest;
}

/** Blob of a file and its replication state */
export interface BlobStatus {
  address: Address;
  state: 'Hot' | 'Cool' | 'Closed';
  held: number;
  dataShards: number;
  totalShards: number;
  holders: Address[];
  expiresAt: bigint | null;
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
const WRITE_SEGMENT_CU = 12_000;
/** Probe timeout for replicator nodes before a direct upload */
const NODE_PROBE_MS = 3_000;

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
 * Files are compressed when it pays, encrypted with a random key
 * (AES-256-GCM) and split into chunks.  The wallet signs one batch (open +
 * pay every chunk, create the record).  Direct uploads then send each chunk
 * to replicator nodes over HTTP (they check it against its on-chain hash);
 * ledger uploads let a session key write the bytes to the ledger instead.
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
  private readonly directChunkSize: number;
  private readonly mode: UploadMode;
  private readonly compress: boolean;
  private readonly customPush?: (chunk: ChunkRef, data: Uint8Array) => Promise<void>;
  private directNodes?: { urls: string[]; at: number };
  private readonly replicas: number;
  private readonly epochs: number;
  private readonly redundancy?: number;
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
    // leave room for the encryption overhead under the program's 16 MiB cap
    this.directChunkSize = Math.min(options.directChunkSize ?? 8 * 1024 * 1024, MAX_DIRECT_CHUNK_SIZE - 64);
    this.mode = options.mode ?? 'auto';
    this.compress = options.compress ?? true;
    this.customPush = options.pushChunk;
    this.replicas = options.replicas ?? 1;
    this.epochs = options.epochs ?? 12;
    this.redundancy = options.redundancy;
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

  /**
   * Cost breakdown (lamports) for uploading `size` plaintext bytes.  An upper
   * bound when the file compresses (the upload measures the real size).
   */
  async quoteFile(
    size: number,
    replicas = this.replicas,
    mode: UploadMode = this.mode,
    { epochs = this.epochs, redundancy = this.redundancy }: { epochs?: number; redundancy?: number } = {},
  ): Promise<FileQuote> {
    const config = await this.config();
    const resolved = await this.resolveMode(mode);
    if (resolved === 'blob') return this.quoteBlobs(size, epochs, redundancy, config);
    const direct = resolved === 'direct';
    const segmentSize = direct ? 0 : await this.segmentSize(this.segmentTxVersion);
    const chunkSizes = this.encryptedChunkSizes(size, direct ? this.directChunkSize : this.chunkSize);
    const indexed = chunkSizes.length > this.inlineChunkLimit();
    if (indexed) chunkSizes.push(32 * chunkSizes.length + ENCRYPTION_OVERHEAD);

    let uploadFee = 0n;
    let chunkRent = 0n;
    let segments = 0;
    for (const chunk of chunkSizes) {
      const count = direct ? 0 : Math.ceil(chunk / segmentSize);
      segments += count;
      uploadFee += quoteChunk(config, chunk, replicas);
      chunkRent += await this.rentExempt(chunkAccountSize(count, replicas));
    }
    // 86 fixed bytes + name + MIME type (about 40 for typical files) + chunk hashes
    const manifestBytes = 126 + 32 * (indexed ? 1 : chunkSizes.length) + SEAL_OVERHEAD;
    const recordRent = await this.rentExempt(recordAccountSize(FILE_SCHEMA.length, manifestBytes));
    const walletTxs = Math.ceil(chunkSizes.length / 6) + 1;
    const sessionTxs = !direct && this.sessionWriter ? 1 : 0;
    const networkFee = BigInt(segments + walletTxs + sessionTxs) * (SIGNATURE_FEE + this.priorityFeeLamports);
    const rentDeposit = chunkRent + recordRent;
    return {
      mode: resolved,
      chunks: chunkSizes.length,
      segments,
      uploadFee,
      rentDeposit,
      chunkRent,
      recordRent,
      networkFee,
      total: uploadFee + rentDeposit + networkFee,
    };
  }

  /** "auto" → "blob" when a replicator node answers, else "ledger" ("direct" with a custom push) */
  async resolveMode(mode: UploadMode = this.mode): Promise<ResolvedMode> {
    if (mode !== 'auto') return mode;
    if (this.customPush) return 'direct';
    return (await this.directTargets()).length > 0 ? 'blob' : 'ledger';
  }

  private async quoteBlobs(size: number, epochs: number, redundancy: number | undefined, config: ConfigAccount): Promise<FileQuote> {
    const nodes = Math.max(1, (await this.directTargets()).length);
    const layout = chooseLayout({ payloadSize: size, nodes, redundancy: redundancy !== undefined ? Math.min(redundancy, nodes - 1) : undefined });
    const n = layout.k + layout.m;
    let uploadFee = 0n;
    let chunkRent = 0n;
    let remaining = layout.stripes;
    while (remaining > 0) {
      const stripes = Math.min(remaining, layout.stripesPerBlob);
      remaining -= stripes;
      uploadFee += quoteBlob(config, BigInt(stripes * layout.fragmentSize), n, epochs);
      chunkRent += await this.rentExempt(blobAccountSize(n));
    }
    const recordRent = await this.rentExempt(recordAccountSize(BLOB_FILE_SCHEMA.length, 170 + 36 * layout.blobCount + SEAL_OVERHEAD));
    const networkFee = BigInt(Math.ceil((layout.blobCount + 1) / 6)) * (SIGNATURE_FEE + this.priorityFeeLamports);
    const rentDeposit = chunkRent + recordRent;
    return {
      mode: 'blob',
      layout: { k: layout.k, m: layout.m },
      epochs,
      storageSeconds: BigInt(epochs) * config.epochSeconds,
      chunks: layout.blobCount,
      segments: 0,
      uploadFee,
      rentDeposit,
      chunkRent,
      recordRent,
      networkFee,
      total: uploadFee + rentDeposit + networkFee,
    };
  }

  /**
   * Replicator nodes that accept direct chunks now: the configured nodes,
   * then every active registered replicator, each probed with GET /status
   * (registered and active).  Cached for a minute.
   */
  async directTargets(fresh = false): Promise<string[]> {
    if (!fresh && this.directNodes && Date.now() - this.directNodes.at < 60_000) return this.directNodes.urls;
    const registered = await this.replicators().catch(() => []);
    const candidates = [...this.nodeUrls];
    for (const r of registered) {
      const url = r.endpoint.replace(/\/$/, '');
      if (r.active && url && !candidates.includes(url)) candidates.push(url);
    }
    const alive = await Promise.all(
      candidates.map(async (url) => {
        try {
          const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(NODE_PROBE_MS) });
          if (!response.ok) return false;
          const status = (await response.json()) as { registered?: boolean; active?: boolean; programId?: string };
          return status.registered === true && status.active !== false && (!status.programId || status.programId === this.program);
        } catch {
          return false;
        }
      }),
    );
    const urls = candidates.filter((_, i) => alive[i]);
    this.directNodes = { urls, at: Date.now() };
    return urls;
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
    const mode = await this.resolveMode(options.mode ?? this.mode);
    if (mode === 'blob') {
      const compressed = (options.compress ?? this.compress) ? await maybeCompress(data) : null;
      return this.uploadBlobPayload(compressed ?? data, {
        name: options.name,
        mime: options.mime ?? 'application/octet-stream',
        size: data.length,
        sha256: sha256(data),
        compressed: compressed !== null,
        bundle: false,
      }, options, identity.recordNonce, keys.publicKey, config);
    }
    const direct = mode === 'direct';
    // direct uploads need a node before anything is paid
    const targets = direct && !this.customPush ? await this.directTargets(true) : [];
    if (direct && !this.customPush && targets.length === 0) {
      throw new Error('No replicator node is reachable for a direct upload; retry later or use mode "ledger"');
    }

    // 1. Compress (when it pays), encrypt and split
    const compressed = (options.compress ?? this.compress) ? await maybeCompress(data) : null;
    const payload = compressed ?? data;
    const chunkSize = direct ? this.directChunkSize : this.chunkSize;
    const dek = randomKey();
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < payload.length || parts.length === 0; offset += chunkSize) {
      parts.push(encryptBytes(dek, payload.subarray(offset, offset + chunkSize)));
    }
    const hashes = parts.map((p) => sha256(p));
    const manifest: FileManifest = {
      v: 2,
      name: options.name,
      mime: options.mime ?? 'application/octet-stream',
      size: data.length,
      chunkSize,
      sha256: sha256(data),
      dek,
      createdAt: Math.floor(Date.now() / 1000),
      chunkCount: parts.length,
      chunks: hashes,
      ...(direct ? { direct: true } : {}),
      ...(compressed ? { compression: 'gzip' as const } : {}),
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

    // 3. One wallet batch: (ledger: fund the session writer) open + pay each chunk, create the record
    const useSession = !direct && this.sessionWriter;
    const segmentSize = direct ? 0 : await this.segmentSize(this.segmentTxVersion);
    const writer = useSession ? await generateKeyPairSigner() : this.signer;
    const chunkAddresses = await Promise.all(hashes.map((h) => pdas.chunk(this.address, h, this.program)));
    const segmentCount = direct ? 0 : parts.reduce((n, p) => n + Math.ceil(p.length / segmentSize), 0);

    const ownerInstructions: Instruction[] = [];
    if (useSession) {
      const perTx = SIGNATURE_FEE + this.priorityFeeLamports;
      const budget = (BigInt(segmentCount + 1) * perTx * 11n) / 10n + (await this.rentExempt(0));
      ownerInstructions.push(transferSol(this.signer, writer.address, budget));
    }
    let feePaid = 0n;
    let rentDeposit = 0n;
    for (let i = 0; i < parts.length; i++) {
      const fee = quoteChunk(config, parts[i].length, replicas);
      feePaid += fee;
      rentDeposit += await this.rentExempt(chunkAccountSize(direct ? 0 : Math.ceil(parts[i].length / segmentSize), replicas));
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
    let acceptedBy: string[] = [];
    try {
      ownerResults = await this.sender.sendAll(ownerTxs, {
        onConfirmed: () => progress({ stage: 'open', done: ++opened, total: ownerTxs.length }),
      });

      if (direct) {
        // 4a. Each chunk goes to up to `replicas` nodes; the others copy it from them
        let pushed = 0;
        const accepted = new Set<string>();
        const refs = chunkAddresses.map((address, i) => ({ address, owner: this.address, contentHash: hashes[i] }));
        let next = 0;
        const worker = async () => {
          while (next < refs.length) {
            const i = next++;
            for (const url of await this.pushDirect(refs[i], parts[i], targets, replicas)) accepted.add(url);
            progress({ stage: 'push', done: ++pushed, total: refs.length });
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, refs.length) }, worker));
        acceptedBy = [...accepted];
        return {
          recordId: await pdas.record(this.address, nonce, this.program),
          mode,
          storedSize: payload.length,
          nodes: acceptedBy,
          chunks: chunkAddresses,
          size: data.length,
          feePaid,
          rentDeposit,
          signatures: ownerResults.map((r) => r.signature),
          segmentTransactions: 0,
        };
      }

      // 4b. Session key writes the segments (each index lands once; retries are safe)
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
      if (useSession) await this.sweep(writer).catch(() => undefined);
      progress({ stage: 'done', done: 1, total: 1 });
    }

    const recordId = await pdas.record(this.address, nonce, this.program);
    return {
      recordId,
      mode,
      storedSize: payload.length,
      nodes: [],
      chunks: chunkAddresses,
      size: data.length,
      feePaid,
      rentDeposit,
      signatures: ownerResults.map((r) => r.signature),
      segmentTransactions: written,
    };
  }

  /** Decrypt the manifest of a record this wallet owns or was granted (v2 chunks or v3 blobs) */
  async getManifest(recordId: string): Promise<AnyManifest> {
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
    const plain = open(await this.keys(), content);
    return isBlobManifest(plain) ? decodeBlobManifest(plain) : decodeManifest(plain);
  }

  /**
   * Download, verify and decrypt a file.  For a bundle (uploadFiles) pass
   * `entry` to get one of its files, or use downloadBundle for all of them.
   */
  async downloadFile(recordId: string, { entry }: { entry?: string } = {}): Promise<DownloadResult> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v === 3) {
      const payload = await this.downloadBlobPayload(record.owner, manifest);
      if (!manifest.bundle) return { name: manifest.name, mime: manifest.mime, data: payload, manifest };
      const files = decodeBundle(payload);
      const file = entry === undefined ? (files.length === 1 ? files[0] : undefined) : files.find((f) => f.name === entry);
      if (!file) throw new Error(entry === undefined ? `Record ${recordId} is a bundle of ${files.length} files: pass { entry } or use downloadBundle` : `No file "${entry}" in this bundle`);
      return { name: file.name, mime: file.mime, data: file.data, manifest };
    }
    const refs = await this.chunkRefs(record.owner, manifest);

    const plain: Uint8Array[] = new Array(refs.length);
    let next = 0;
    const worker = async () => {
      while (next < refs.length) {
        const i = next++;
        plain[i] = decryptBytes(manifest.dek, await this.fetchVerified(refs[i], !manifest.direct));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
    const total = plain.reduce((n, p) => n + p.length, 0);
    let data: Uint8Array = new Uint8Array(total);
    let offset = 0;
    for (const p of plain) {
      data.set(p, offset);
      offset += p.length;
    }
    if (manifest.compression === 'gzip') data = await gunzip(data);
    if (data.length !== manifest.size || toHex(sha256(data)) !== toHex(manifest.sha256)) {
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
    const sealed = seal(identity.encryptionKey, manifest.v === 3 ? encodeBlobManifest(manifest) : encodeManifest(manifest));
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
    // blobs are prepaid: they close after expiry (reclaimAllDeposits)
    if (manifest && manifest.v === 2) instructions.push(...(await this.closeSettledChunks(manifest)));
    const results = await this.sender.sendAll(this.pack(instructions, 'delete'));
    return results.map((r) => r.signature);
  }

  /** Close the settled chunks of a file to recover their rent (the data stays on replicators) */
  async reclaimDeposits(recordId: string): Promise<{ closed: number; signatures: string[] }> {
    const manifest = await this.getManifest(recordId);
    const instructions = manifest.v === 3 ? await this.closableBlobs(manifest.blobs.map((b) => b.root)) : await this.closeSettledChunks(manifest);
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
    const closable = chunks.filter((c) => isClosable(c.data));
    const blobs = await listAccounts<BlobAccount>(this.rpc, 'Blob', [{ offset: OFFSETS.blob.owner, bytes: addressBytes(this.address) }], {
      program: this.program,
      commitment: this.commitment,
    });
    const config = blobs.length > 0 ? await this.config() : null;
    const closableBlobs = blobs.filter((b) => config && this.blobClosable(b.data, config));
    if (closable.length + closableBlobs.length === 0) return { closed: 0, lamports: 0n, signatures: [] };
    const instructions = [
      ...closable.map((c) => this.ix.closeChunk(this.signer, c.address)),
      ...(await Promise.all(closableBlobs.map((b) => this.ix.closeBlob(this.signer, b.address)))),
    ];
    const results = await this.sender.sendAll(this.pack(instructions, 'reclaim'));
    return {
      closed: instructions.length,
      lamports: [...closable, ...closableBlobs].reduce((n, c) => n + c.lamports, 0n),
      signatures: results.map((r) => r.signature),
    };
  }

  /**
   * Replication state of every chunk of a file.  For blob files each blob is
   * one entry: `confirmedReplicas` = shards held, `requiredReplicas` = shards
   * in total, Cool once any `k` can rebuild it (details in `blobs`).
   */
  async fileStatus(recordId: string): Promise<{ manifest: AnyManifest; chunks: ChunkStatus[]; cool: boolean; blobs?: BlobStatus[] }> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v === 3) {
      const blobs = await this.blobStatus(record.owner, manifest);
      const chunks: ChunkStatus[] = blobs.map((b) => ({
        address: b.address,
        state: b.state,
        confirmedReplicas: b.held,
        requiredReplicas: b.totalShards,
        replicators: b.holders,
      }));
      return { manifest, chunks, cool: blobs.every((b) => b.state !== 'Hot'), blobs };
    }
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
        .filter((r) => r.data.schema === FILE_SCHEMA || r.data.schema === BLOB_FILE_SCHEMA)
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

  // ── Blobs (docs/blob-protocol.md) ──────────────────────────────────────────

  /**
   * Store many small files as one bundle: one blob account and one record for
   * all of them.  Download one with downloadFile(recordId, { entry }) or all
   * with downloadBundle.
   */
  async uploadFiles(files: BundleFile[], options: Omit<UploadOptions, 'mime' | 'mode'> & { name?: string }): Promise<UploadResult & { entries: string[] }> {
    if (files.length === 0) throw new Error('No files to bundle');
    const [config, identity, keys] = await Promise.all([this.config(), this.identity(), this.keys()]);
    if (!identity) throw new Error('Register this wallet first (SolaDBClient.register)');
    if (toHex(identity.encryptionKey) !== toHex(keys.publicKey)) {
      throw new Error('The published encryption key is not this wallet\'s; call register() to rotate it');
    }
    const bundle = encodeBundle(files);
    const compressed = (options.compress ?? this.compress) ? await maybeCompress(bundle) : null;
    const result = await this.uploadBlobPayload(compressed ?? bundle, {
      name: options.name ?? `${files.length} files`,
      mime: 'application/x-soladb-bundle',
      size: bundle.length,
      sha256: sha256(bundle),
      compressed: compressed !== null,
      bundle: true,
    }, options, identity.recordNonce, keys.publicKey, config);
    return { ...result, entries: files.map((f) => f.name) };
  }

  /** Every file of a bundle, each verified against its sha256 */
  async downloadBundle(recordId: string): Promise<BundleEntry[]> {
    const record = await this.record(recordId);
    const manifest = await this.getManifest(recordId);
    if (manifest.v !== 3 || !manifest.bundle) throw new Error(`Record ${recordId} is not a bundle`);
    return decodeBundle(await this.downloadBlobPayload(record.owner, manifest));
  }

  /** Prepay `epochs` more epochs for every blob of a file (owner only) */
  async extendFile(recordId: string, epochs: number): Promise<string[]> {
    const manifest = await this.getManifest(recordId);
    if (manifest.v !== 3) throw new Error('Only blob files are prepaid per epoch');
    const config = await this.config();
    const instructions: Instruction[] = [];
    for (const ref of manifest.blobs) {
      const address = await pdas.blob(this.address, ref.root, this.program);
      const account = await fetchAccount<BlobAccount>(this.rpc, address, 'Blob', this.commitment);
      if (!account) throw new Error(`Blob ${address} is closed`);
      const escrow = account.data.rewardPerShardEpoch * BigInt(account.data.totalShards) * BigInt(epochs);
      const fee = escrow + (escrow * BigInt(config.protocolFeeBps)) / BigInt(10_000 - config.protocolFeeBps);
      instructions.push(await this.ix.extendBlob(this.signer, address, config.treasury, epochs, fee));
    }
    const results = await this.sender.sendAll(this.pack(instructions, 'extend'));
    return results.map((r) => r.signature);
  }

  /** Holders and state of every blob of a v3 manifest */
  async blobStatus(owner: Address, manifest: BlobManifest): Promise<BlobStatus[]> {
    const addresses = await Promise.all(manifest.blobs.map((b) => pdas.blob(owner, b.root, this.program)));
    const accounts = await fetchAccounts<BlobAccount>(this.rpc, addresses, 'Blob', this.commitment);
    return accounts.map((account, i) =>
      account
        ? {
            address: addresses[i],
            state: account.data.state,
            held: account.data.held,
            dataShards: account.data.dataShards,
            totalShards: account.data.totalShards,
            holders: account.data.slots.map((s) => s.holder),
            expiresAt: account.data.expiresAt,
          }
        : { address: addresses[i], state: 'Closed', held: 0, dataShards: manifest.k, totalShards: manifest.k + manifest.m, holders: [], expiresAt: null },
    );
  }

  private async uploadBlobPayload(
    payload: Uint8Array,
    meta: { name: string; mime: string; size: number; sha256: Uint8Array; compressed: boolean; bundle: boolean },
    options: Pick<UploadOptions, 'epochs' | 'redundancy' | 'onProgress'>,
    nonce: bigint,
    publicKey: Uint8Array,
    config: ConfigAccount,
  ): Promise<UploadResult> {
    const progress = options.onProgress ?? (() => undefined);
    const epochs = options.epochs ?? this.epochs;
    const targets = await this.directTargets(true);
    if (targets.length === 0) throw new Error('No replicator node is reachable for a blob upload; retry later or use mode "ledger"');
    const redundancy = options.redundancy ?? this.redundancy;
    const layout = chooseLayout({
      payloadSize: payload.length,
      nodes: targets.length,
      redundancy: redundancy !== undefined ? Math.min(redundancy, targets.length - 1) : undefined,
    });
    const n = layout.k + layout.m;
    const dek = randomKey();
    const blobs = encodeBlobs(payload, layout, dek);
    const manifest: BlobManifest = {
      v: 3,
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      createdAt: Math.floor(Date.now() / 1000),
      sha256: meta.sha256,
      dek,
      payloadSize: payload.length,
      k: layout.k,
      m: layout.m,
      fragmentSize: layout.fragmentSize,
      blobs: blobs.map((b) => ({ root: b.root, stripes: b.stripes })),
      ...(meta.compressed ? { compression: 'gzip' as const } : {}),
      ...(meta.bundle ? { bundle: true as const } : {}),
    };
    const sealed = seal(publicKey, encodeBlobManifest(manifest));
    const recordIx = await this.ix.createRecord(this.signer, nonce, BLOB_FILE_SCHEMA, sealed);
    if (this.sender.messageSize(this.ownerTx([recordIx])) > LEGACY_TX_LIMIT) {
      throw new Error(`This file needs ${blobs.length} blobs, more than one record can list; split it into smaller files`);
    }

    // One wallet batch: open + prepay every blob, create the record
    const addresses = await Promise.all(blobs.map((b) => pdas.blob(this.address, b.root, this.program)));
    const ownerInstructions: Instruction[] = [];
    let feePaid = 0n;
    let rentDeposit = 0n;
    for (const blob of blobs) {
      const fee = quoteBlob(config, BigInt(blob.shardSize), n, epochs);
      feePaid += fee;
      rentDeposit += await this.rentExempt(blobAccountSize(n));
      ownerInstructions.push(
        await this.ix.openBlob(this.signer, config.treasury, {
          root: blob.root,
          dataShards: layout.k,
          totalShards: n,
          shardSize: BigInt(blob.shardSize),
          payloadSize: BigInt(blob.payloadLength),
          epochs,
          maxFee: fee,
        }),
      );
    }
    ownerInstructions.push(recordIx);
    rentDeposit += await this.rentExempt(recordAccountSize(BLOB_FILE_SCHEMA.length, sealed.length));
    const ownerTxs = this.pack(ownerInstructions, 'upload');
    progress({ stage: 'sign', done: 0, total: ownerTxs.length });
    let opened = 0;
    const ownerResults = await this.sender.sendAll(ownerTxs, {
      onConfirmed: () => progress({ stage: 'open', done: ++opened, total: ownerTxs.length }),
    });

    // Each shard to its own node (rotated per blob); a node holds one shard per blob
    const accepted = new Set<string>();
    const jobs = blobs.flatMap((blob, b) => blob.shards.map((shard, j) => ({ b, j, shard })));
    let pushed = 0;
    let next = 0;
    const failures: string[] = [];
    const used = blobs.map(() => new Set<string>());
    const worker = async () => {
      while (next < jobs.length) {
        const { b, j, shard } = jobs[next++];
        const order = targets.map((_, t) => targets[(t + j + b) % targets.length]);
        let done = false;
        for (const url of order) {
          if (used[b].has(url)) continue;
          used[b].add(url);
          try {
            await this.pushShard(url, addresses[b], j, shard, blobs[b].shardRoots, layout.fragmentSize);
            accepted.add(url);
            done = true;
            break;
          } catch (err) {
            failures.push(`blob ${b} shard ${j} → ${url}: ${(err as Error).message}`);
          }
        }
        if (!done) failures.push(`blob ${b} shard ${j}: no node took it`);
        progress({ stage: 'push', done: ++pushed, total: jobs.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    progress({ stage: 'done', done: 1, total: 1 });
    const status = await this.blobStatus(this.address, manifest);
    const unreadable = status.filter((s) => s.held < s.dataShards);
    if (unreadable.length > 0) {
      throw new Error(
        `${unreadable.length} blob(s) got fewer than ${layout.k} shards (${failures.slice(0, 3).join('; ')}). ` +
          'Nodes may still rebuild them; the deposit of an unheld blob comes back after 10 minutes (reclaimAllDeposits).',
      );
    }
    return {
      recordId: await pdas.record(this.address, nonce, this.program),
      mode: 'blob',
      blobs: addresses,
      layout: { k: layout.k, m: layout.m, fragmentSize: layout.fragmentSize },
      expiresAt: status.reduce((min, s) => (s.expiresAt !== null && (min === 0n || s.expiresAt < min) ? s.expiresAt : min), 0n),
      storedSize: payload.length,
      nodes: [...accepted],
      chunks: addresses,
      size: meta.size,
      feePaid,
      rentDeposit,
      signatures: ownerResults.map((r) => r.signature),
      segmentTransactions: 0,
    };
  }

  /** PUT a shard in pieces of 8 MiB (resumable: each piece says its offset) */
  private async pushShard(url: string, blob: Address, index: number, shard: Uint8Array, roots: Uint8Array[], fragmentSize: number): Promise<void> {
    const piece = 8 * 1024 * 1024;
    for (let offset = 0; offset < shard.length; offset += piece) {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (offset === 0) {
        headers['x-soladb-shard-roots'] = roots.map(toHex).join(',');
        headers['x-soladb-fragment-size'] = String(fragmentSize);
      }
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${url}/blob/${blob}/shard/${index}?offset=${offset}`, {
          method: 'PUT',
          headers,
          body: shard.subarray(offset, offset + piece) as BodyInit,
          signal: AbortSignal.timeout(Math.max(this.nodeTimeoutMs, 120_000)),
        });
        // 404: the node's RPC has not seen the open transaction yet
        if (response.status === 404 && offset === 0 && attempt < 5) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        break;
      }
    }
  }

  /** Fetch, verify and decode every stripe of a v3 manifest's blobs → payload (decompressed, checked) */
  private async downloadBlobPayload(owner: Address, manifest: BlobManifest): Promise<Uint8Array> {
    const { k, m, fragmentSize } = manifest;
    const n = k + m;
    const lengths = stripePlainLengths(manifest.payloadSize, k, fragmentSize);
    const payload = new Uint8Array(manifest.payloadSize);
    let global = 0;
    let offset = 0;
    for (const ref of manifest.blobs) {
      const address = await pdas.blob(owner, ref.root, this.program);
      const sources = await this.shardSources(address, n);
      const roots = await this.verifiedRoots(address, ref.root, sources.flatMap((s) => s.urls));
      const first = global;
      const plains: Uint8Array[] = new Array(ref.stripes);
      let cursor = 0;
      const worker = async () => {
        while (cursor < ref.stripes) {
          const stripe = cursor++;
          const fragments: (Uint8Array | null)[] = new Array(n).fill(null);
          let have = 0;
          // data shards first: no decoding needed when they are all there
          for (const source of sources) {
            if (have >= k) break;
            for (const url of source.urls) {
              const fragment = await this.fetchFragment(url, address, source.index, stripe, roots[source.index], fragmentSize, ref.stripes);
              if (fragment) {
                fragments[source.index] = fragment;
                have++;
                break;
              }
            }
          }
          if (have < k) throw new Error(`Blob ${address} stripe ${stripe}: only ${have} verified fragments, ${k} needed`);
          plains[stripe] = decodeStripe(fragments, k, m, fragmentSize, manifest.dek, lengths[first + stripe]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ref.stripes) }, worker));
      for (const plain of plains) {
        payload.set(plain, offset);
        offset += plain.length;
      }
      global += ref.stripes;
    }
    if (offset !== manifest.payloadSize) throw new Error('Integrity check failed: payload size');
    const plain = manifest.compression === 'gzip' ? await gunzip(payload) : payload;
    if (plain.length !== manifest.size || toHex(sha256(plain)) !== toHex(manifest.sha256)) {
      throw new Error('Integrity check failed: sha256');
    }
    return plain;
  }

  /** Per shard index: the endpoints of its holder, then every other active node (data shards first) */
  private async shardSources(blob: Address, n: number): Promise<{ index: number; urls: string[] }[]> {
    const account = await fetchAccount<BlobAccount>(this.rpc, blob, 'Blob', this.commitment).catch(() => null);
    const all = await this.replicators().catch(() => []);
    const byAuthority = new Map(all.filter((r) => r.active).map((r) => [r.authority as string, r.endpoint.replace(/\/$/, '')]));
    const everyone = [...new Set([...this.nodeUrls, ...byAuthority.values()])];
    return Array.from({ length: n }, (_, index) => {
      const holder = account?.data.slots[index]?.holder;
      const own = holder && holder !== VACANT ? byAuthority.get(holder) : undefined;
      return { index, urls: own ? [own, ...everyone.filter((u) => u !== own)] : everyone };
    });
  }

  /** Shard roots from any node, accepted only if they hash to the blob root */
  private async verifiedRoots(blob: Address, root: Uint8Array, urls: string[]): Promise<Uint8Array[]> {
    for (const url of [...new Set(urls)]) {
      try {
        const response = await fetch(`${url}/blob/${blob}/roots`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
        if (!response.ok) continue;
        const body = (await response.json()) as unknown;
        if (!Array.isArray(body) || body.some((r) => typeof r !== 'string' || !/^[0-9a-f]{64}$/i.test(r))) continue;
        const roots = (body as string[]).map(fromHex);
        if (toHex(blobRoot(roots)) === toHex(root)) return roots;
      } catch {
        // next node
      }
    }
    throw new Error(`No node served shard roots matching blob ${blob}`);
  }

  /**
   * One fragment, accepted only if it is exactly `fragmentSize` bytes and its
   * proof has the depth of the blob's stripe tree: a node cannot pass off
   * several fragments (or a subtree) with a shorter proof
   */
  private async fetchFragment(
    url: string,
    blob: Address,
    index: number,
    stripe: number,
    shardRoot: Uint8Array,
    fragmentSize: number,
    stripes: number,
  ): Promise<Uint8Array | null> {
    try {
      const response = await fetch(`${url}/blob/${blob}/shard/${index}/fragment/${stripe}`, { signal: AbortSignal.timeout(this.nodeTimeoutMs) });
      if (!response.ok) return null;
      const header = (response.headers.get('x-soladb-proof') ?? '').split(',').filter(Boolean);
      if (header.length !== depth(stripes) || header.some((h) => !/^[0-9a-f]{64}$/i.test(h))) return null;
      const proof = header.map(fromHex);
      const fragment = new Uint8Array(await response.arrayBuffer());
      if (fragment.length !== fragmentSize) return null;
      return verifyFragment(fragment, stripe, proof, shardRoot) ? fragment : null;
    } catch {
      return null;
    }
  }

  private blobClosable(blob: BlobAccount, config: ConfigAccount, now = BigInt(Math.floor(Date.now() / 1000))): boolean {
    return now >= blob.expiresAt + config.epochSeconds || (blob.held === 0 && now >= blob.openedAt + 600n);
  }

  private async closableBlobs(roots: Uint8Array[]): Promise<Instruction[]> {
    const addresses = await Promise.all(roots.map((r) => pdas.blob(this.address, r, this.program)));
    const accounts = await fetchAccounts<BlobAccount>(this.rpc, addresses, 'Blob', this.commitment);
    const config = await this.config();
    const out: Instruction[] = [];
    for (const account of accounts) {
      if (account && this.blobClosable(account.data, config)) out.push(await this.ix.closeBlob(this.signer, account.address));
    }
    return out;
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
    const hashes = decodeIndex(decryptBytes(manifest.dek, await this.fetchVerified(indexRef, !manifest.direct)));
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
    return accounts
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .filter((a) => isClosable(a.data))
      .map((a) => this.ix.closeChunk(this.signer, a.address));
  }

  /** Fetch a chunk (custom source, replicators, then the ledger) and check its hash */
  private async fetchVerified(ref: ChunkRef, ledger = true): Promise<Uint8Array> {
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

    if (this.ledgerFallback && ledger) {
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

  /**
   * Send a direct chunk to up to `replicas` nodes (PUT /chunk/:address/data;
   * the node checks it against the on-chain hash, stores it and confirms).
   * Returns the nodes that took it; throws when none did.
   */
  private async pushDirect(ref: ChunkRef, data: Uint8Array, targets: string[], replicas: number): Promise<string[]> {
    if (this.customPush) {
      await this.customPush(ref, data);
      return [];
    }
    const errors: string[] = [];
    const accepted: string[] = [];
    for (const url of targets) {
      if (accepted.length >= replicas) break;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetch(`${url}/chunk/${ref.address}/data`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: data as BodyInit,
            signal: AbortSignal.timeout(Math.max(this.nodeTimeoutMs, 120_000)),
          });
          // 404: the node's RPC has not seen the open transaction yet
          if (response.status === 404 && attempt < 5) {
            await sleep(1_000 * (attempt + 1));
            continue;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
          accepted.push(url);
        } catch (err) {
          errors.push(`${url}: ${(err as Error).message}`);
        }
        break;
      }
    }
    if (accepted.length === 0) {
      throw new Error(
        `No node accepted chunk ${ref.address} (${errors.join('; ')}). ` +
          'Its deposit can be reclaimed after 10 minutes (reclaimAllDeposits).',
      );
    }
    return accepted;
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

  private encryptedChunkSizes(size: number, chunkSize: number): number[] {
    const sizes: number[] = [];
    for (let offset = 0; offset < size || sizes.length === 0; offset += chunkSize) {
      sizes.push(Math.min(chunkSize, size - offset) + ENCRYPTION_OVERHEAD);
    }
    return sizes;
  }

  /** Chunks a manifest can list inline before it needs an index chunk */
  private inlineChunkLimit(): number {
    return 16;
  }
}
