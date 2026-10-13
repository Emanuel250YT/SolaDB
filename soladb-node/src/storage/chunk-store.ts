/**
 * Raw chunk bytes, keyed by chunk account address (base58).  Implemented by
 * RocksDBService (production), S3ChunkStore (any S3-compatible object store)
 * and FsChunkStore (development, no native module).
 */
export interface ChunkStore {
  putChunk(chunkId: string, data: Buffer): Promise<void>;
  /** null when the chunk is not stored */
  getChunk(chunkId: string): Promise<Buffer | null>;
  hasChunk(chunkId: string): Promise<boolean>;
  deleteChunk(chunkId: string): Promise<void>;
  listChunkIds(): Promise<string[]>;
}

/** Nest injection token for the configured ChunkStore (CHUNK_STORE) */
export const CHUNK_STORE = Symbol('CHUNK_STORE');

/** A base58 Solana address: 32–44 characters of the Bitcoin alphabet */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isChunkId(value: string): boolean {
  return typeof value === 'string' && BASE58_ADDRESS.test(value);
}
