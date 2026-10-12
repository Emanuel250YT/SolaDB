import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHUNK_STORE, ChunkStore } from './chunk-store';
import {
  ChunkQuery,
  ChunkRecord,
  ChunkStateUpdate,
  METADATA_STORE,
  MetadataStore,
} from './metadata-store';

/**
 * StorageService
 *
 * Unified facade that routes:
 *   • binary chunk data     → ChunkStore    (RocksDB, or files with CHUNK_STORE=fs)
 *   • structured metadata   → MetadataStore (Oracle, or JSON with METADATA_STORE=file)
 *
 * Callers should always use this service rather than touching the stores
 * directly.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(CHUNK_STORE) private readonly chunks: ChunkStore,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStore,
    private readonly config: ConfigService,
  ) { }

  // ── Write path ──────────────────────────────────────────────────────────────

  /**
   * Persist a chunk: raw bytes first, then the metadata record, so a record
   * never points at bytes that are not on disk.  Both writes are idempotent.
   */
  async storeChunk(meta: ChunkRecord, rawData: Buffer): Promise<void> {
    this.logger.debug(`Storing chunk ${meta.chunkId} (${rawData.length} bytes)`);
    await this.chunks.putChunk(meta.chunkId, rawData);
    await this.metadata.upsertChunk(meta);
  }

  /** Insert / refresh a metadata record without touching the bytes */
  async upsertChunkMeta(meta: ChunkRecord): Promise<void> {
    await this.metadata.upsertChunk(meta);
  }

  /**
   * Update the replication state (state, confirmations, replicators, this
   * node's confirmation) of a stored chunk.
   */
  async updateReplicationState(chunkId: string, update: ChunkStateUpdate): Promise<void> {
    await this.metadata.updateChunkState(chunkId, update);
  }

  async deleteChunk(chunkId: string): Promise<void> {
    await this.chunks.deleteChunk(chunkId);
  }

  // ── Read path ───────────────────────────────────────────────────────────────

  /**
   * Retrieve raw chunk bytes (null when this node does not store them).
   */
  async getRawChunk(chunkId: string): Promise<Buffer | null> {
    return this.chunks.getChunk(chunkId);
  }

  /**
   * Retrieve chunk metadata.
   */
  async getChunkMeta(chunkId: string): Promise<ChunkRecord | null> {
    return this.metadata.getChunk(chunkId);
  }

  /**
   * JSON query interface — delegates to the metadata store.
   */
  async queryChunks(params: ChunkQuery): Promise<ChunkRecord[]> {
    return this.metadata.queryChunks(params);
  }

  /**
   * Check whether this node has a chunk's bytes.
   */
  async hasChunk(chunkId: string): Promise<boolean> {
    return this.chunks.hasChunk(chunkId);
  }

  async countChunks(): Promise<number> {
    return this.metadata.countChunks();
  }

  /** Configured drivers, for /status */
  get drivers(): { chunkStore: string; metadataStore: string } {
    return {
      chunkStore: this.config.get<string>('storage.chunkStore'),
      metadataStore: this.config.get<string>('storage.metadataStore'),
    };
  }
}
