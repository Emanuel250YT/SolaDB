import type { ChunkAccount, ChunkState } from '@soladb/sdk';

/** On-chain state, plus `Closed` once the owner closed the chunk account */
export type ChunkStateName = ChunkState | 'Closed';

export const CHUNK_STATES: readonly ChunkStateName[] = ['Pending', 'Hot', 'Cool', 'Closed'];

/** Fields POST /query can sort on */
export const ORDER_BY_FIELDS = [
  'uploadedAt',
  'storedAt',
  'confirmedReplicas',
  'size',
  'slot',
  'chunkId',
] as const;
export type OrderByField = (typeof ORDER_BY_FIELDS)[number];

/** Metadata this node keeps for every chunk it stores */
export interface ChunkRecord {
  /** Chunk account address (base58); also the chunk store key */
  chunkId: string;
  /** Uploader wallet (base58) */
  owner: string;
  /** sha256 of the chunk bytes (hex) */
  contentHash: string;
  /** Chunk length in bytes */
  size: number;
  requiredReplicas: number;
  confirmedReplicas: number;
  state: ChunkStateName;
  /** The uploader closed the chunk to new replicas */
  reclaimed: boolean;
  /** Lamports paid to each replicator (decimal string: JSON has no bigint) */
  rewardPerReplica: string;
  /** Replicators that confirmed, in order (base58) */
  replicators: string[];
  /** Highest slot among the chunk's write_segment transactions (null if unknown) */
  slot: number | null;
  /** When the last segment landed (on-chain `completed_at`) */
  uploadedAt: Date;
  /** When this node stored the bytes */
  storedAt: Date;
  /** When this node's confirm_replication landed */
  confirmedAt: Date | null;
  /** Signature of that confirm_replication transaction */
  confirmSignature: string | null;
}

/** Mutable part of a record, refreshed from the chain */
export interface ChunkStateUpdate {
  state: ChunkStateName;
  confirmedReplicas?: number;
  reclaimed?: boolean;
  replicators?: string[];
  confirmedAt?: Date;
  confirmSignature?: string;
}

export interface ChunkQuery {
  filter?: Partial<{
    owner: string;
    state: ChunkStateName;
    chunkId: string;
    contentHash: string;
  }>;
  orderBy?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * Lifecycle of a blob shard on this node:
 *   Staging   — bytes being received (staged in the BlobStore, unverified)
 *   Stored    — verified against r_index and R, committed; confirm_shard pending
 *   Confirmed — this node holds the shard's slot on-chain
 *   Lost      — the slot was lost (failed challenge, vacated) or the bytes are gone
 *   Expired   — the blob expired or was closed; the bytes can be deleted
 */
export type BlobShardState = 'Staging' | 'Stored' | 'Confirmed' | 'Lost' | 'Expired';

export const BLOB_SHARD_STATES: readonly BlobShardState[] = ['Staging', 'Stored', 'Confirmed', 'Lost', 'Expired'];

/**
 * Metadata this node keeps for every blob shard it holds (one shard per
 * blob per node; docs/blob-protocol.md §5).  Separate from chunk records.
 *
 * Upserts keep the first value of the identity fields (owner … totalShards:
 * the blob address commits to them), always replace `state`, and replace the
 * nullable fields only with non-null values.  updateBlobShard sets exactly
 * the fields it is given (null clears).
 */
export interface BlobShardRecord {
  /** Blob account address (base58) */
  blob: string;
  /** Shard index j (0 ≤ j < totalShards) = this node's slot in the blob account */
  index: number;
  /** Blob owner wallet (base58) */
  owner: string;
  /** Blob root R (hex) */
  root: string;
  /** Shard root r_j (hex) */
  shardRoot: string;
  /** Shard length in bytes (a multiple of the 1 KiB segment) */
  shardSize: number;
  /** k */
  dataShards: number;
  /** n = k + m */
  totalShards: number;
  /** Fragment size F (bytes) when known, for fragment downloads */
  fragmentSize: number | null;
  state: BlobShardState;
  /** When the verified shard was committed to the blob store */
  storedAt: Date | null;
  /** When this node's confirm_shard landed */
  confirmedAt: Date | null;
  /** Signature of that confirm_shard transaction */
  confirmSignature: string | null;
  /** On-chain ShardSlot.proven_at: the last accepted storage proof */
  provenAt: Date | null;
  /** On-chain ShardSlot.claimed_until: rewards claimed up to */
  claimedUntil: Date | null;
  /** On-chain Blob.expires_at */
  expiresAt: Date | null;
}

/** Fields to set on a blob shard record (undefined = keep, null = clear) */
export type BlobShardUpdate = Partial<Omit<BlobShardRecord, 'blob' | 'index'>>;

export interface BlobShardQuery {
  blob?: string;
  state?: BlobShardState;
  /** Default 50, max 1000 (like queryChunks) */
  limit?: number;
  offset?: number;
}

/**
 * Structured chunk and blob-shard metadata.  Implemented by OracleService
 * (production), PostgresMetadataService and FileMetadataService
 * (development: one JSON file, queries in memory).
 */
export interface MetadataStore {
  /** Insert, or refresh the mutable fields of an existing record */
  upsertChunk(chunk: ChunkRecord): Promise<void>;
  /** No-op when the chunk has no record */
  updateChunkState(chunkId: string, update: ChunkStateUpdate): Promise<void>;
  getChunk(chunkId: string): Promise<ChunkRecord | null>;
  queryChunks(query: ChunkQuery): Promise<ChunkRecord[]>;
  countChunks(): Promise<number>;

  /** Insert, or merge into an existing record (rules on BlobShardRecord) */
  upsertBlobShard(shard: BlobShardRecord): Promise<void>;
  /** null when this node has no record of that shard */
  getBlobShard(blob: string, index: number): Promise<BlobShardRecord | null>;
  /** Ordered by blob, then index */
  listBlobShards(query?: BlobShardQuery): Promise<BlobShardRecord[]>;
  /** Set the given fields; no-op when the shard has no record */
  updateBlobShard(blob: string, index: number, update: BlobShardUpdate): Promise<void>;
  /** No-op when the shard has no record */
  deleteBlobShard(blob: string, index: number): Promise<void>;
}

/** Nest injection token for the configured MetadataStore (METADATA_STORE) */
export const METADATA_STORE = Symbol('METADATA_STORE');

/** Default / max page size of queryChunks and listBlobShards */
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 1000;

/** Fields of a BlobShardRecord that updateBlobShard may set */
export const BLOB_SHARD_UPDATE_FIELDS = [
  'owner',
  'root',
  'shardRoot',
  'shardSize',
  'dataShards',
  'totalShards',
  'fragmentSize',
  'state',
  'storedAt',
  'confirmedAt',
  'confirmSignature',
  'provenAt',
  'claimedUntil',
  'expiresAt',
] as const satisfies readonly (keyof BlobShardUpdate)[];

/** Date-valued fields of a BlobShardRecord */
export const BLOB_SHARD_DATE_FIELDS = ['storedAt', 'confirmedAt', 'provenAt', 'claimedUntil', 'expiresAt'] as const;

export const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Metadata record for a chunk account as read from the chain */
export function chunkRecordFromAccount(
  chunkId: string,
  account: ChunkAccount,
  extra: Partial<Pick<ChunkRecord, 'slot' | 'storedAt' | 'confirmedAt' | 'confirmSignature'>> = {},
): ChunkRecord {
  return {
    chunkId,
    owner: account.owner,
    contentHash: toHex(account.contentHash),
    size: account.size,
    requiredReplicas: account.requiredReplicas,
    confirmedReplicas: account.confirmedReplicas,
    state: account.state,
    reclaimed: account.reclaimed,
    rewardPerReplica: account.rewardPerReplica.toString(),
    replicators: [...account.replicators],
    slot: extra.slot ?? null,
    uploadedAt: new Date(Number(account.completedAt || account.openedAt) * 1000),
    storedAt: extra.storedAt ?? new Date(),
    confirmedAt: extra.confirmedAt ?? null,
    confirmSignature: extra.confirmSignature ?? null,
  };
}

/** Mutable fields of a chunk account, as a metadata update */
export function stateUpdateFromAccount(account: ChunkAccount): ChunkStateUpdate {
  return {
    state: account.state,
    confirmedReplicas: account.confirmedReplicas,
    reclaimed: account.reclaimed,
    replicators: [...account.replicators],
  };
}
