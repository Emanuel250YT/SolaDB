import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import {
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
  OrderByField,
} from './metadata-store';

/** Whitelisted ORDER BY columns (never interpolate user input) */
const ORDER_BY_COLUMNS: Record<OrderByField, string> = {
  uploadedAt: 'uploaded_at',
  storedAt: 'stored_at',
  confirmedReplicas: 'confirmed_replicas',
  size: 'size_bytes',
  slot: 'slot',
  chunkId: 'chunk_id',
};

/** BlobShardRecord field → column (updateBlobShard builds its SET from it) */
const SHARD_COLUMNS: Record<(typeof BLOB_SHARD_UPDATE_FIELDS)[number], string> = {
  owner: 'owner',
  root: 'blob_root',
  shardRoot: 'shard_root',
  shardSize: 'shard_size',
  dataShards: 'data_shards',
  totalShards: 'total_shards',
  fragmentSize: 'fragment_size',
  state: 'state',
  storedAt: 'stored_at',
  confirmedAt: 'confirmed_at',
  confirmSignature: 'confirm_signature',
  provenAt: 'proven_at',
  claimedUntil: 'claimed_until',
  expiresAt: 'expires_at',
};

/** Columns a table must have, or it was left by something else */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  chunks: ['size_bytes', 'replicators', 'confirm_signature'],
  blob_shards: ['blob_address', 'shard_index', 'shard_root'],
};

/**
 * PostgresMetadataService
 *
 * Metadata store on PostgreSQL (METADATA_STORE=postgres), with the same
 * semantics as OracleService and FileMetadataService.  Connects with
 * DATABASE_URL, or the standard PG* variables when it is empty; PG_SCHEMA
 * puts the tables in their own schema (several nodes can share a database).
 *
 * Tables (created on start):
 *   chunks      — one row per stored chunk.  chunk_id / owner are base58
 *                 addresses (byte-order collation, like the JS sort of the
 *                 file store), content_hash the hex sha256, replicators a
 *                 JSON array, reward_per_replica a u64 (numeric, read back
 *                 as a string).
 *   blob_shards — one row per blob shard held, keyed by (blob, index).
 */
@Injectable()
export class PostgresMetadataService implements MetadataStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresMetadataService.name);
  private ownsPool = false;
  private chunks = 'chunks';
  private shards = 'blob_shards';

  /** `pool` replaces the one built from the configuration (tests: pg-mem) */
  constructor(
    private readonly config: ConfigService,
    private pool?: Pool,
  ) { }

  async onModuleInit(): Promise<void> {
    const schema = this.config.get<string>('postgres.schema') ?? '';
    if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid PG_SCHEMA "${schema}"`);
    const qualify = (table: string) => (schema ? `"${schema}".${table}` : table);
    this.chunks = qualify('chunks');
    this.shards = qualify('blob_shards');

    if (!this.pool) {
      const url = this.config.get<string>('postgres.url');
      this.pool = new Pool({
        connectionString: url || undefined,
        max: this.config.get<number>('postgres.poolMax') ?? 10,
      });
      this.ownsPool = true;
      // An idle client losing its connection must not crash the process
      this.pool.on('error', (err) => this.logger.warn(`Postgres connection error: ${err.message}`));
    }

    await this._ensureSchema(schema);
    this.logger.log(`Postgres metadata store ready (${this._describe()}${schema ? `, schema ${schema}` : ''})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) await this.pool?.end();
  }

  // ── Schema bootstrap ────────────────────────────────────────────────────────

  private async _ensureSchema(schema: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (schema) await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.chunks} (
          chunk_id           text COLLATE "C" PRIMARY KEY,
          owner              text           NOT NULL,
          content_hash       text           NOT NULL,
          size_bytes         bigint         NOT NULL,
          required_replicas  integer        NOT NULL,
          confirmed_replicas integer        NOT NULL DEFAULT 0,
          state              text           NOT NULL DEFAULT 'Hot',
          reclaimed          boolean        NOT NULL DEFAULT false,
          reward_per_replica numeric(20, 0) NOT NULL DEFAULT 0,
          replicators        jsonb          NOT NULL DEFAULT '[]',
          slot               bigint,
          uploaded_at        timestamptz    NOT NULL,
          stored_at          timestamptz    NOT NULL DEFAULT now(),
          confirmed_at       timestamptz,
          confirm_signature  text
        )
      `);
      await this._checkLayout(client, schema, 'chunks');
      // Filters and sort keys of queryChunks; (owner, uploaded_at) serves the
      // default "an owner's newest chunks", (state, chunk_id) the replicator's
      // reconciliation scan
      const indexes: [string, string][] = [
        ['chunks_owner_idx', 'owner, uploaded_at'],
        ['chunks_state_idx', 'state, chunk_id'],
        ['chunks_content_hash_idx', 'content_hash'],
        ['chunks_uploaded_at_idx', 'uploaded_at'],
        ['chunks_stored_at_idx', 'stored_at'],
        ['chunks_confirmed_replicas_idx', 'confirmed_replicas'],
        ['chunks_size_idx', 'size_bytes'],
        // NULLS FIRST: serves both null orders of queryChunks (backwards for desc)
        ['chunks_slot_idx', 'slot NULLS FIRST'],
      ];
      for (const [name, columns] of indexes) {
        await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${this.chunks} (${columns})`);
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.shards} (
          blob_address      text COLLATE "C" NOT NULL,
          shard_index       integer     NOT NULL,
          owner             text        NOT NULL,
          blob_root         text        NOT NULL,
          shard_root        text        NOT NULL,
          shard_size        bigint      NOT NULL,
          data_shards       integer     NOT NULL,
          total_shards      integer     NOT NULL,
          fragment_size     integer,
          state             text        NOT NULL,
          stored_at         timestamptz,
          confirmed_at      timestamptz,
          confirm_signature text,
          proven_at         timestamptz,
          claimed_until     timestamptz,
          expires_at        timestamptz,
          PRIMARY KEY (blob_address, shard_index)
        )
      `);
      await this._checkLayout(client, schema, 'blob_shards');
      await client.query(
        `CREATE INDEX IF NOT EXISTS blob_shards_state_idx ON ${this.shards} (state, blob_address, shard_index)`,
      );
    } finally {
      client.release();
    }
  }

  /** A same-named table left by another application: refuse to start */
  private async _checkLayout(client: PoolClient, schema: string, table: string): Promise<void> {
    const tableSchema = schema || (await client.query('SELECT current_schema() AS name')).rows[0]?.name;
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [tableSchema, table],
    );
    const columns = new Set(rows.map((row) => row.column_name));
    const missing = REQUIRED_COLUMNS[table].filter((column) => !columns.has(column));
    // (no columns at all = a catalog that cannot be introspected: trust CREATE)
    if (columns.size > 0 && missing.length > 0) {
      throw new Error(
        `Table ${table} exists with another layout (missing ${missing.join(', ')}). ` +
        'Use a fresh database / PG_SCHEMA or drop it.',
      );
    }
  }

  // ── Chunk CRUD ──────────────────────────────────────────────────────────────

  async upsertChunk(chunk: ChunkRecord): Promise<void> {
    // Same rules as the Oracle MERGE: immutable fields and the first
    // storedAt stay, the chain-driven fields are refreshed
    await this.pool.query(
      `INSERT INTO ${this.chunks} AS c (
         chunk_id, owner, content_hash, size_bytes, required_replicas,
         confirmed_replicas, state, reclaimed, reward_per_replica, replicators,
         slot, uploaded_at, stored_at, confirmed_at, confirm_signature
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (chunk_id) DO UPDATE SET
         confirmed_replicas = EXCLUDED.confirmed_replicas,
         state              = EXCLUDED.state,
         reclaimed          = EXCLUDED.reclaimed,
         replicators        = EXCLUDED.replicators,
         slot               = COALESCE(EXCLUDED.slot, c.slot),
         confirmed_at       = COALESCE(EXCLUDED.confirmed_at, c.confirmed_at),
         confirm_signature  = COALESCE(EXCLUDED.confirm_signature, c.confirm_signature)`,
      [
        chunk.chunkId,
        chunk.owner,
        chunk.contentHash,
        chunk.size,
        chunk.requiredReplicas,
        chunk.confirmedReplicas,
        chunk.state,
        chunk.reclaimed,
        chunk.rewardPerReplica,
        JSON.stringify(chunk.replicators ?? []),
        chunk.slot ?? null,
        chunk.uploadedAt,
        chunk.storedAt ?? new Date(),
        chunk.confirmedAt ?? null,
        chunk.confirmSignature ?? null,
      ],
    );
  }

  async updateChunkState(chunkId: string, update: ChunkStateUpdate): Promise<void> {
    // Typed parameters: COALESCE(null, column) must keep the column's type
    await this.pool.query(
      `UPDATE ${this.chunks} SET
         state              = $1,
         confirmed_replicas = COALESCE($2::integer, confirmed_replicas),
         reclaimed          = COALESCE($3::boolean, reclaimed),
         replicators        = COALESCE($4::jsonb, replicators),
         confirmed_at       = COALESCE($5::timestamptz, confirmed_at),
         confirm_signature  = COALESCE($6::text, confirm_signature)
       WHERE chunk_id = $7`,
      [
        update.state,
        update.confirmedReplicas ?? null,
        update.reclaimed ?? null,
        update.replicators ? JSON.stringify(update.replicators) : null,
        update.confirmedAt ?? null,
        update.confirmSignature ?? null,
        chunkId,
      ],
    );
  }

  async getChunk(chunkId: string): Promise<ChunkRecord | null> {
    const { rows } = await this.pool.query(`SELECT * FROM ${this.chunks} WHERE chunk_id = $1`, [chunkId]);
    return rows.length ? mapChunkRow(rows[0]) : null;
  }

  async countChunks(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM ${this.chunks}`);
    return Number(rows[0]?.n ?? 0);
  }

  // ── Query API ───────────────────────────────────────────────────────────────

  /**
   * Execute a structured JSON query against the chunks table.
   *
   * Supported filter fields: owner, state, chunkId, contentHash
   * Supported orderBy: uploadedAt, storedAt, confirmedReplicas, size, slot, chunkId
   */
  async queryChunks(params: ChunkQuery): Promise<ChunkRecord[]> {
    const conditions: string[] = ['TRUE'];
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };

    if (params.filter?.owner) conditions.push(`owner = ${bind(params.filter.owner)}`);
    if (params.filter?.state !== undefined) conditions.push(`state = ${bind(params.filter.state)}`);
    if (params.filter?.chunkId) conditions.push(`chunk_id = ${bind(params.filter.chunkId)}`);
    if (params.filter?.contentHash) {
      conditions.push(`content_hash = ${bind(params.filter.contentHash.toLowerCase())}`);
    }

    // Whitelist orderBy to prevent SQL injection
    const orderBy: OrderByField = ORDER_BY_COLUMNS[params.orderBy as OrderByField]
      ? (params.orderBy as OrderByField)
      : 'uploadedAt';
    const ascending = params.order === 'asc';
    // The file store sorts a null slot as -1: first ascending, last descending
    const nulls = orderBy === 'slot' ? (ascending ? ' NULLS FIRST' : ' NULLS LAST') : '';
    const { limit, offset } = page(params.limit, params.offset);

    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.chunks}
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${ORDER_BY_COLUMNS[orderBy]} ${ascending ? 'ASC' : 'DESC'}${nulls}, chunk_id ASC
       LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
      values,
    );
    return rows.map(mapChunkRow);
  }

  // ── Blob shards ─────────────────────────────────────────────────────────────

  async upsertBlobShard(shard: BlobShardRecord): Promise<void> {
    // Identity fields stay, state is replaced, nullable fields only by
    // non-null values (same rules as the file and Oracle stores)
    await this.pool.query(
      `INSERT INTO ${this.shards} AS s (
         blob_address, shard_index, owner, blob_root, shard_root, shard_size,
         data_shards, total_shards, fragment_size, state, stored_at,
         confirmed_at, confirm_signature, proven_at, claimed_until, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (blob_address, shard_index) DO UPDATE SET
         state             = EXCLUDED.state,
         fragment_size     = COALESCE(EXCLUDED.fragment_size, s.fragment_size),
         stored_at         = COALESCE(EXCLUDED.stored_at, s.stored_at),
         confirmed_at      = COALESCE(EXCLUDED.confirmed_at, s.confirmed_at),
         confirm_signature = COALESCE(EXCLUDED.confirm_signature, s.confirm_signature),
         proven_at         = COALESCE(EXCLUDED.proven_at, s.proven_at),
         claimed_until     = COALESCE(EXCLUDED.claimed_until, s.claimed_until),
         expires_at        = COALESCE(EXCLUDED.expires_at, s.expires_at)`,
      [
        shard.blob,
        shard.index,
        shard.owner,
        shard.root,
        shard.shardRoot,
        shard.shardSize,
        shard.dataShards,
        shard.totalShards,
        shard.fragmentSize ?? null,
        shard.state,
        shard.storedAt ?? null,
        shard.confirmedAt ?? null,
        shard.confirmSignature ?? null,
        shard.provenAt ?? null,
        shard.claimedUntil ?? null,
        shard.expiresAt ?? null,
      ],
    );
  }

  async getBlobShard(blob: string, index: number): Promise<BlobShardRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.shards} WHERE blob_address = $1 AND shard_index = $2`,
      [blob, index],
    );
    return rows.length ? mapShardRow(rows[0]) : null;
  }

  async listBlobShards(query: BlobShardQuery = {}): Promise<BlobShardRecord[]> {
    const conditions: string[] = ['TRUE'];
    const values: unknown[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (query.blob) conditions.push(`blob_address = ${bind(query.blob)}`);
    if (query.state !== undefined) conditions.push(`state = ${bind(query.state)}`);
    const { limit, offset } = page(query.limit, query.offset);

    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.shards}
       WHERE ${conditions.join(' AND ')}
       ORDER BY blob_address ASC, shard_index ASC
       LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
      values,
    );
    return rows.map(mapShardRow);
  }

  async updateBlobShard(blob: string, index: number, update: BlobShardUpdate): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of BLOB_SHARD_UPDATE_FIELDS) {
      if (update[field] === undefined) continue;
      values.push(update[field]);
      sets.push(`${SHARD_COLUMNS[field]} = $${values.length}`);
    }
    if (sets.length === 0) return;
    values.push(blob, index);
    await this.pool.query(
      `UPDATE ${this.shards} SET ${sets.join(', ')}
       WHERE blob_address = $${values.length - 1} AND shard_index = $${values.length}`,
      values,
    );
  }

  async deleteBlobShard(blob: string, index: number): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.shards} WHERE blob_address = $1 AND shard_index = $2`, [blob, index]);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** host:port/database for logs (never the password) */
  private _describe(): string {
    const url = this.config.get<string>('postgres.url');
    if (!url) return 'PG* environment';
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return 'DATABASE_URL';
    }
  }
}

/** Page bounds shared with the file store: default 50, at most 1000 */
function page(limit: number | undefined, offset: number | undefined): { limit: number; offset: number } {
  return {
    limit: Math.max(0, Math.floor(Math.min(limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT))),
    offset: Math.max(0, Math.floor(offset ?? 0)),
  };
}

/** node-postgres returns bigint / numeric as strings */
const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const toDate = (value: unknown): Date | null => (value ? new Date(value as string | Date) : null);

function mapChunkRow(row: any): ChunkRecord {
  return {
    chunkId: row.chunk_id,
    owner: row.owner,
    contentHash: row.content_hash,
    size: Number(row.size_bytes),
    requiredReplicas: row.required_replicas,
    confirmedReplicas: row.confirmed_replicas,
    state: row.state,
    reclaimed: row.reclaimed === true,
    rewardPerReplica: String(row.reward_per_replica ?? '0'),
    replicators: Array.isArray(row.replicators) ? row.replicators : [],
    slot: toNumber(row.slot),
    uploadedAt: toDate(row.uploaded_at),
    storedAt: toDate(row.stored_at),
    confirmedAt: toDate(row.confirmed_at),
    confirmSignature: row.confirm_signature ?? null,
  };
}

function mapShardRow(row: any): BlobShardRecord {
  return {
    blob: row.blob_address,
    index: row.shard_index,
    owner: row.owner,
    root: row.blob_root,
    shardRoot: row.shard_root,
    shardSize: Number(row.shard_size),
    dataShards: row.data_shards,
    totalShards: row.total_shards,
    fragmentSize: toNumber(row.fragment_size),
    state: row.state,
    storedAt: toDate(row.stored_at),
    confirmedAt: toDate(row.confirmed_at),
    confirmSignature: row.confirm_signature ?? null,
    provenAt: toDate(row.proven_at),
    claimedUntil: toDate(row.claimed_until),
    expiresAt: toDate(row.expires_at),
  };
}
