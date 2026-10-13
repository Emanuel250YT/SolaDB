import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BLOB_STORE, BlobStore } from './blob-store';
import { CHUNK_STORE, ChunkStore } from './chunk-store';
import {
  BlobShardQuery,
  BlobShardRecord,
  BlobShardUpdate,
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
 *   • binary chunk data     → ChunkStore    (RocksDB; files with CHUNK_STORE=fs; S3 with CHUNK_STORE=s3)
 *   • blob shard bytes      → BlobStore     (files with BLOB_STORE=fs; S3 with BLOB_STORE=s3)
 *   • structured metadata   → MetadataStore (Oracle; Postgres with METADATA_STORE=postgres;
 *                                            JSON with METADATA_STORE=file)
 *
 * Callers should always use this service rather than touching the stores
 * directly (shard bytes go through `blobs`, whose API is already minimal).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(CHUNK_STORE) private readonly chunks: ChunkStore,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStore,
    private readonly config: ConfigService,
    @Optional() @Inject(BLOB_STORE) private readonly blobStore?: BlobStore,
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

  // ── Blobs ───────────────────────────────────────────────────────────────────

  /**
   * Shard bytes: staged appends, commit, range reads, small objects (keys:
   * blobShardKey / blobSegmentHashesKey / blobRootsKey in blob-store.ts).
   */
  get blobs(): BlobStore {
    if (!this.blobStore) throw new Error('No BlobStore configured');
    return this.blobStore;
  }

  /** Insert, or merge into an existing record (rules on BlobShardRecord) */
  async upsertBlobShard(shard: BlobShardRecord): Promise<void> {
    await this.metadata.upsertBlobShard(shard);
  }

  async getBlobShard(blob: string, index: number): Promise<BlobShardRecord | null> {
    return this.metadata.getBlobShard(blob, index);
  }

  /** Ordered by blob, then index; default 50 per page, at most 1000 */
  async listBlobShards(query: BlobShardQuery = {}): Promise<BlobShardRecord[]> {
    return this.metadata.listBlobShards(query);
  }

  /** Set the given fields (null clears); no-op when the shard has no record */
  async updateBlobShard(blob: string, index: number, update: BlobShardUpdate): Promise<void> {
    await this.metadata.updateBlobShard(blob, index, update);
  }

  /** Forget a shard's record (its bytes are deleted through `blobs`) */
  async deleteBlobShard(blob: string, index: number): Promise<void> {
    await this.metadata.deleteBlobShard(blob, index);
  }

  /** Configured drivers, for /status */
  get drivers(): { chunkStore: string; metadataStore: string; blobStore: string } {
    return {
      chunkStore: this.config.get<string>('storage.chunkStore'),
      metadataStore: this.config.get<string>('storage.metadataStore'),
      blobStore: this.config.get<string>('storage.blobStore'),
    };
  }
}
