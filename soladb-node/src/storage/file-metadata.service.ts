import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
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
 * Development metadata store (METADATA_STORE=file): every record lives in
 * memory and is persisted to DATA_DIR/metadata.json.  Queries support the
 * same filters, ordering and pagination as the Oracle store.
 *
 * Saves are coalesced (one write per burst of updates) and atomic (temporary
 * file + rename); every mutation resolves once its change is on disk.
 */
@Injectable()
export class FileMetadataService implements MetadataStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileMetadataService.name);
  private readonly records = new Map<string, ChunkRecord>();
  private file: string;

  private saving: Promise<void> | null = null;
  private saveRequested = false;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const dataDir = path.resolve(this.config.get<string>('storage.dataDir'));
    this.file = path.join(dataDir, 'metadata.json');
    await fs.promises.mkdir(dataDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      let parsed: { version: number; chunks: Record<string, unknown>[] };
      try {
        parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      } catch (err) {
        throw new Error(`Cannot read ${this.file}: ${(err as Error).message}`);
      }
      for (const raw of parsed.chunks ?? []) {
        const record = reviveRecord(raw);
        this.records.set(record.chunkId, record);
      }
    }
    this.logger.log(`Chunk metadata in ${this.file} (${this.records.size} records)`);
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
    const body = JSON.stringify({ version: FILE_VERSION, chunks: [...this.records.values()] }, null, 2);
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
