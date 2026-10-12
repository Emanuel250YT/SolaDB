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
function lamports(name: string): bigint {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return 0n;
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

export default () => {
  const dataDir = process.env.DATA_DIR || './data';

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
      // Total priority fee per confirm_replication transaction (lamports)
      priorityFeeLamports: lamports('PRIORITY_FEE_LAMPORTS'),
      // How long to wait for a transaction to reach "confirmed"
      txTimeoutMs: int('TX_TIMEOUT_MS', 60_000),
    },

    storage: {
      // rocksdb (production) | fs (one file per chunk, no native module)
      chunkStore: oneOf('CHUNK_STORE', 'rocksdb', ['rocksdb', 'fs'] as const),
      // oracle (production) | file (JSON file, in-memory queries)
      metadataStore: oneOf('METADATA_STORE', 'oracle', ['oracle', 'file'] as const),
      // Root for the fs chunk store (DATA_DIR/chunks) and metadata.json
      dataDir,
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
      // Public URL that serves /chunk/:id/data (advertised on-chain)
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
