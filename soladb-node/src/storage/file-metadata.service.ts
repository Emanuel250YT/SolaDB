import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  BLOB_SHARD_DATE_FIELDS,
  BLOB_SHARD_UPDATE_FIELDS,
  BlobShardQuery,
  BlobShardRecord,
  BlobShardUpdate,
  ChunkQuery,
  ChunkRecord,
  ChunkStateUpdate,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  MetadataStore,
  ORDER_BY_FIELDS,
  OrderByField,
} from './metadata-store';

const FILE_VERSION = 1;
const DATE_FIELDS = ['uploadedAt', 'storedAt', 'confirmedAt'] as const;

/**
 * FileMetadataService
 *
 * Development metadata store (METADATA_STORE=file): every record (chunks
 * and blob shards) lives in memory and is persisted to DATA_DIR/metadata.json.
 * Queries support the same filters, ordering and pagination as the Oracle
 * and Postgres stores.
 *
 * Saves are coalesced (one write per burst of updates) and atomic (temporary
 * file + rename); every mutation resolves once its change is on disk.
 */
@Injectable()
export class FileMetadataService implements MetadataStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileMetadataService.name);
  private readonly records = new Map<string, ChunkRecord>();
  /** Blob shards by `${blob}/${index}` */
  private readonly shards = new Map<string, BlobShardRecord>();
  private file: string;

  private saving: Promise<void> | null = null;
  private saveRequested = false;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const dataDir = path.resolve(this.config.get<string>('storage.dataDir'));
    this.file = path.join(dataDir, 'metadata.json');
    await fs.promises.mkdir(dataDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      let parsed: { version: number; chunks: Record<string, unknown>[]; blobShards?: Record<string, unknown>[] };
      try {
        parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      } catch (err) {
        throw new Error(`Cannot read ${this.file}: ${(err as Error).message}`);
      }
      for (const raw of parsed.chunks ?? []) {
        const record = reviveRecord(raw);
        this.records.set(record.chunkId, record);
      }
      for (const raw of parsed.blobShards ?? []) {
        const shard = reviveShard(raw);
        this.shards.set(shardKey(shard.blob, shard.index), shard);
      }
    }
    this.logger.log(
      `Chunk metadata in ${this.file} (${this.records.size} records, ${this.shards.size} blob shards)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.saving?.catch(() => undefined);
  }

  // ── Chunk CRUD ──────────────────────────────────────────────────────────────

  async upsertChunk(chunk: ChunkRecord): Promise<void> {
    const existing = this.records.get(chunk.chunkId);
    if (!existing) {
      this.records.set(chunk.chunkId, cloneRecord(chunk));
    } else {
      // Same rules as the Oracle MERGE: immutable fields and the first
      // storedAt stay, the chain-driven fields are refreshed
      existing.confirmedReplicas = chunk.confirmedReplicas;
      existing.state = chunk.state;
      existing.reclaimed = chunk.reclaimed;
      existing.replicators = [...chunk.replicators];
      existing.slot = chunk.slot ?? existing.slot;
      existing.confirmedAt = chunk.confirmedAt ?? existing.confirmedAt;
      existing.confirmSignature = chunk.confirmSignature ?? existing.confirmSignature;
    }
    await this._save();
  }

  async updateChunkState(chunkId: string, update: ChunkStateUpdate): Promise<void> {
    const record = this.records.get(chunkId);
    if (!record) return;
    record.state = update.state;
    if (update.confirmedReplicas !== undefined) record.confirmedReplicas = update.confirmedReplicas;
    if (update.reclaimed !== undefined) record.reclaimed = update.reclaimed;
    if (update.replicators !== undefined) record.replicators = [...update.replicators];
    if (update.confirmedAt !== undefined) record.confirmedAt = update.confirmedAt;
    if (update.confirmSignature !== undefined) record.confirmSignature = update.confirmSignature;
    await this._save();
  }

  async getChunk(chunkId: string): Promise<ChunkRecord | null> {
    const record = this.records.get(chunkId);
    return record ? cloneRecord(record) : null;
  }

  async countChunks(): Promise<number> {
    return this.records.size;
  }

  // ── Query API ───────────────────────────────────────────────────────────────

  /**
   * Structured JSON query over the records, in memory.
   *
   * Supported filter fields: owner, state, chunkId, contentHash
   * Supported orderBy: uploadedAt, storedAt, confirmedReplicas, size, slot, chunkId
   */
  async queryChunks(params: ChunkQuery): Promise<ChunkRecord[]> {
    const filter = params.filter ?? {};
    const orderBy: OrderByField = ORDER_BY_FIELDS.includes(params.orderBy as OrderByField)
      ? (params.orderBy as OrderByField)
      : 'uploadedAt';
    const direction = params.order === 'asc' ? 1 : -1;
    const limit = Math.min(params.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const offset = params.offset ?? 0;

    const matches = [...this.records.values()].filter(
      (r) =>
        (!filter.owner || r.owner === filter.owner) &&
        (filter.state === undefined || r.state === filter.state) &&
        (!filter.chunkId || r.chunkId === filter.chunkId) &&
        (!filter.contentHash || r.contentHash === filter.contentHash.toLowerCase()),
    );

    matches.sort((a, b) => {
      const primary = compare(sortValue(a, orderBy), sortValue(b, orderBy)) * direction;
      return primary !== 0 ? primary : compare(a.chunkId, b.chunkId);
    });

    return matches.slice(offset, offset + limit).map(cloneRecord);
  }

  // ── Blob shards ─────────────────────────────────────────────────────────────

  async upsertBlobShard(shard: BlobShardRecord): Promise<void> {
    const key = shardKey(shard.blob, shard.index);
    const existing = this.shards.get(key);
    if (!existing) {
      this.shards.set(key, cloneShard(shard));
    } else {
      // Same rules as the SQL upserts: identity fields stay, state is
      // replaced, nullable fields only by non-null values
      existing.state = shard.state;
      existing.fragmentSize = shard.fragmentSize ?? existing.fragmentSize;
      existing.confirmSignature = shard.confirmSignature ?? existing.confirmSignature;
      for (const field of BLOB_SHARD_DATE_FIELDS) {
        if (shard[field]) existing[field] = new Date(shard[field]);
      }
    }
    await this._save();
  }

  async getBlobShard(blob: string, index: number): Promise<BlobShardRecord | null> {
    const shard = this.shards.get(shardKey(blob, index));
    return shard ? cloneShard(shard) : null;
  }

  async listBlobShards(query: BlobShardQuery = {}): Promise<BlobShardRecord[]> {
    const limit = Math.min(query.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const offset = query.offset ?? 0;
    const matches = [...this.shards.values()].filter(
      (s) => (!query.blob || s.blob === query.blob) && (query.state === undefined || s.state === query.state),
    );
    matches.sort((a, b) => compare(a.blob, b.blob) || a.index - b.index);
    return matches.slice(offset, offset + limit).map(cloneShard);
  }

  async updateBlobShard(blob: string, index: number, update: BlobShardUpdate): Promise<void> {
    const shard = this.shards.get(shardKey(blob, index));
    if (!shard) return;
    for (const field of BLOB_SHARD_UPDATE_FIELDS) {
      const value = update[field];
      if (value === undefined) continue;
      (shard as any)[field] = value instanceof Date ? new Date(value) : value;
    }
    await this._save();
  }

  async deleteBlobShard(blob: string, index: number): Promise<void> {
    if (this.shards.delete(shardKey(blob, index))) await this._save();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Write the records to disk.  Calls made while a write is running are
   * folded into one follow-up write; each caller resolves after a write that
   * includes its change.
   */
  private _save(): Promise<void> {
    this.saveRequested = true;
    if (!this.saving) {
      this.saving = (async () => {
        try {
          while (this.saveRequested) {
            this.saveRequested = false;
            await this._writeSnapshot();
          }
        } finally {
          // Same tick as the last check: a later _save() starts a new loop
          this.saving = null;
        }
      })();
    }
    return this.saving;
  }

  private async _writeSnapshot(): Promise<void> {
    const body = JSON.stringify(
      { version: FILE_VERSION, chunks: [...this.records.values()], blobShards: [...this.shards.values()] },
      null,
      2,
    );
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, this.file);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sortValue(record: ChunkRecord, field: OrderByField): number | string {
  switch (field) {
    case 'uploadedAt':
    case 'storedAt':
      return record[field]?.getTime() ?? 0;
    case 'slot':
      return record.slot ?? -1;
    default:
      return record[field];
  }
}

function compare(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneRecord(record: ChunkRecord): ChunkRecord {
  return {
    ...record,
    replicators: [...record.replicators],
    uploadedAt: new Date(record.uploadedAt),
    storedAt: new Date(record.storedAt),
    confirmedAt: record.confirmedAt ? new Date(record.confirmedAt) : null,
  };
}

const shardKey = (blob: string, index: number) => `${blob}/${index}`;

function cloneShard(shard: BlobShardRecord): BlobShardRecord {
  const copy = { ...shard, fragmentSize: shard.fragmentSize ?? null, confirmSignature: shard.confirmSignature ?? null };
  for (const field of BLOB_SHARD_DATE_FIELDS) copy[field] = shard[field] ? new Date(shard[field]) : null;
  return copy;
}

/** JSON → BlobShardRecord */
function reviveShard(raw: Record<string, unknown>): BlobShardRecord {
  const shard = { fragmentSize: null, confirmSignature: null, ...raw } as unknown as BlobShardRecord;
  for (const field of BLOB_SHARD_DATE_FIELDS) {
    const value = raw[field];
    shard[field] = value ? new Date(value as string) : null;
  }
  return shard;
}

/** JSON → ChunkRecord (dates come back as ISO strings) */
function reviveRecord(raw: Record<string, unknown>): ChunkRecord {
  const record = { ...raw } as unknown as ChunkRecord;
  for (const field of DATE_FIELDS) {
    const value = raw[field];
    (record as any)[field] = value ? new Date(value as string) : null;
  }
  record.replicators = Array.isArray(raw.replicators) ? (raw.replicators as string[]) : [];
  return record;
}
