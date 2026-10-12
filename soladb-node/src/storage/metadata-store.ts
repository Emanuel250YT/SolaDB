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
 * Structured chunk metadata.  Implemented by OracleService (production) and
 * FileMetadataService (development: one JSON file, queries in memory).
 */
export interface MetadataStore {
  /** Insert, or refresh the mutable fields of an existing record */
  upsertChunk(chunk: ChunkRecord): Promise<void>;
  /** No-op when the chunk has no record */
  updateChunkState(chunkId: string, update: ChunkStateUpdate): Promise<void>;
  getChunk(chunkId: string): Promise<ChunkRecord | null>;
  queryChunks(query: ChunkQuery): Promise<ChunkRecord[]>;
  countChunks(): Promise<number>;
}

/** Nest injection token for the configured MetadataStore (METADATA_STORE) */
export const METADATA_STORE = Symbol('METADATA_STORE');

/** Default / max page size of queryChunks */
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 1000;

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
