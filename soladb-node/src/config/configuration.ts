import * as path from 'path';
import { isAddress } from '@solana/kit';
import { PROGRAM_ADDRESS } from '@soladb/sdk';

/** Integer env var; fails fast on garbage instead of running with NaN */
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

/** Lamport amount env var (u64) */
function lamports(name: string, fallback = 0n): bigint {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an amount in lamports (got "${raw}")`);
  return BigInt(raw);
}

function oneOf<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = (process.env[name] ?? '').trim() || fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

/** Comma-separated base58 addresses */
function addressList(name: string): string[] {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return [];
  const list = raw.split(',').map((a) => a.trim()).filter(Boolean);
  for (const value of list) {
    if (!isAddress(value)) throw new Error(`${name}: "${value}" is not a base58 address`);
  }
  return list;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

const MiB = 1024 * 1024;
/** S3 rejects multipart parts below 5 MiB (except the last one) */
const S3_MIN_PART_SIZE = 5 * MiB;

/** S3 key prefix: empty, or ending with exactly one "/" ("node-1" → "node-1/") */
function s3Prefix(name: string): string {
  const raw = (process.env[name] ?? '').trim().replace(/^\/+|\/+$/g, '');
  return raw === '' ? '' : `${raw}/`;
}

/** Optional Postgres schema name (lower-case identifier) */
function pgSchema(name: string): string {
  const raw = (process.env[name] ?? '').trim();
  if (raw !== '' && !/^[a-z_][a-z0-9_]{0,62}$/.test(raw)) {
    throw new Error(`${name} must be a lower-case identifier (got "${raw}")`);
  }
  return raw;
}

export default () => {
  const dataDir = process.env.DATA_DIR || './data';
  const chunkStore = oneOf('CHUNK_STORE', 'rocksdb', ['rocksdb', 'fs', 's3'] as const);
  // Blob shards are up to 1 GiB: RocksDB is no place for them
  const blobStore = oneOf('BLOB_STORE', chunkStore === 's3' ? 's3' : 'fs', ['fs', 's3'] as const);
  const s3Bucket = (process.env.S3_BUCKET ?? '').trim();
  if ((chunkStore === 's3' || blobStore === 's3') && s3Bucket === '') {
    throw new Error('S3_BUCKET is required when CHUNK_STORE or BLOB_STORE is s3');
  }
  const s3PartSize = int('S3_PART_SIZE', 16 * MiB);
  if (s3PartSize < S3_MIN_PART_SIZE) {
    throw new Error(`S3_PART_SIZE must be at least ${S3_MIN_PART_SIZE} bytes (got ${s3PartSize})`);
  }

  return {
    port: int('PORT', 3000),
    // Allowed browser origins (comma-separated); empty = any origin
    corsOrigin: process.env.CORS_ORIGIN ?? '',

    solana: {
      // Informative label shown in /status (devnet, mainnet, localnet…)
      cluster: process.env.SOLANA_CLUSTER || 'devnet',
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
      programId: process.env.SOLADB_PROGRAM_ID || PROGRAM_ADDRESS,
      // Replicator authority: a solana-keygen JSON file, or the same byte
      // array inline (REPLICATOR_SECRET_KEY wins when both are set)
      replicatorKeypair: process.env.REPLICATOR_KEYPAIR ?? '',
      replicatorSecretKey: process.env.REPLICATOR_SECRET_KEY ?? '',
      // Commitment for every read (chunk scans, ledger history).  "finalized"
      // guarantees the segments a node stores can never be rolled back.
      // getSignaturesForAddress / getTransaction do not accept "processed".
      commitment: oneOf('SOLANA_COMMITMENT', 'finalized', ['confirmed', 'finalized'] as const),
      // Parallel getTransaction requests while rebuilding one chunk
      ledgerConcurrency: Math.max(1, int('LEDGER_CONCURRENCY', 8)),
      // Total priority fee per confirm_replication transaction (lamports; one
      // transaction confirms up to 8 chunks)
      priorityFeeLamports: lamports('PRIORITY_FEE_LAMPORTS'),
      // How long to wait for a transaction to reach "confirmed"
      txTimeoutMs: int('TX_TIMEOUT_MS', 60_000),
    },

    storage: {
      // rocksdb (production) | fs (one file per chunk, no native module) |
      // s3 (any S3-compatible object store)
      chunkStore,
      // oracle (production) | postgres | file (JSON file, in-memory queries)
      metadataStore: oneOf('METADATA_STORE', 'oracle', ['oracle', 'file', 'postgres'] as const),
      // Blob shards: fs (DATA_DIR/blobs) | s3; defaults to s3 with CHUNK_STORE=s3
      blobStore,
      // Root for the fs chunk store (DATA_DIR/chunks), metadata.json and blobs
      dataDir,
    },

    blobs: {
      // Committed shards of the fs blob store (put it on a large volume)
      dir: process.env.BLOB_DIR || path.join(dataDir, 'blobs'),
      // Shards being received, for both blob stores (local disk, also with s3)
      stagingDir: process.env.BLOB_STAGING_DIR || path.join(dataDir, 'blobs-staging'),
      // Erasure-coded blobs (docs/blob-protocol.md): shard pushes are always
      // accepted; this switches the maintenance loop (proofs, claims, repairs)
      enabled: bool('BLOBS_ENABLED', true),
      pollIntervalMs: int('BLOB_POLL_INTERVAL_MS', 10_000),
      // Rebuild vacant shard slots from k other holders
      repair: bool('BLOB_REPAIR', true),
      // Challenge random shards of other holders (bounty when they fail)
      challengeOthers: bool('BLOB_CHALLENGE_OTHERS', false),
      challengeIntervalMs: int('BLOB_CHALLENGE_INTERVAL_MS', 600_000),
      // Prove and claim once this many lamports accrued on a shard
      claimMinLamports: lamports('BLOB_CLAIM_MIN_LAMPORTS', 50_000n),
      // Memory for shard segment hashes (proofs), least recently used evicted
      leafCacheBytes: int('BLOB_LEAF_CACHE_BYTES', 256 * 1024 * 1024),
      // Largest shard this node accepts or rebuilds (disk quota per blob)
      maxShardBytes: int('BLOB_MAX_SHARD_BYTES', 2 * 1024 * 1024 * 1024),
    },

    s3: {
      bucket: s3Bucket,
      // Custom endpoint for MinIO / Cloudflare R2 / Backblaze B2; empty = AWS
      endpoint: (process.env.S3_ENDPOINT ?? '').trim(),
      region: (process.env.S3_REGION ?? '').trim() || 'us-east-1',
      // Empty = the AWS default credential chain (env, profile, instance role)
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      // Key prefix, so several nodes can share a bucket ("node-1/")
      prefix: s3Prefix('S3_PREFIX'),
      // http(s)://endpoint/bucket/key instead of bucket.endpoint (MinIO)
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
      // Create the bucket at boot when it does not exist
      createBucket: bool('S3_CREATE_BUCKET', false),
      // Blob shards above this size are committed with a multipart upload
      multipartThreshold: int('S3_MULTIPART_THRESHOLD', 64 * MiB),
      partSize: s3PartSize,
      // Parts uploaded in parallel (memory: concurrency × part size)
      uploadConcurrency: Math.max(1, int('S3_UPLOAD_CONCURRENCY', 4)),
    },

    postgres: {
      // postgres://user:password@host:5432/db; empty = the PG* variables
      url: process.env.DATABASE_URL ?? '',
      // Tables live in this schema (created if missing); empty = search_path
      schema: pgSchema('PG_SCHEMA'),
      poolMax: Math.max(1, int('PG_POOL_MAX', 10)),
    },

    rocksdb: {
      path: process.env.ROCKSDB_PATH || path.join(dataDir, 'rocksdb'),
    },

    oracle: {
      user: process.env.ORACLE_USER ?? 'soladb',
      password: process.env.ORACLE_PASSWORD ?? '',
      connectionString:
        process.env.ORACLE_CONNECTION_STRING ?? 'localhost:1521/XEPDB1',
    },

    replication: {
      // Public URL that serves /chunk/:id/data (advertised on-chain; direct
      // chunks are fetched from every other replicator's endpoint, never this one)
      nodeEndpoint: process.env.NODE_ENDPOINT || 'http://localhost:3000',
      // Send update_replicator_endpoint at boot when the on-chain value differs
      updateEndpointOnStart: bool('UPDATE_ENDPOINT_ON_START', false),
      // Delay between two scans of the chunks that still need replicas
      pollIntervalMs: Math.max(100, int('POLL_INTERVAL_MS', 5_000)),
      // Chunks rebuilt / confirmed in parallel
      concurrency: Math.max(1, int('REPLICATION_CONCURRENCY', 5)),
      // Store but do not confirm chunks paying less than this per replica
      minRewardLamports: lamports('MIN_REWARD_LAMPORTS'),
      // Only replicate chunks of these uploaders (dedicated nodes, tests on a
      // shared cluster); empty = every uploader
      owners: addressList('REPLICATE_OWNERS'),
    },
  };
};
