import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as oracledb from 'oracledb';
import {
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
  uploadedAt: 'UPLOADED_AT',
  storedAt: 'STORED_AT',
  confirmedReplicas: 'CONFIRMED_REPLICAS',
  size: 'SIZE_BYTES',
  slot: 'SLOT',
  chunkId: 'CHUNK_ID',
};

/** u64 lamports exceed 2^53: fetch them as strings */
const FETCH_INFO = { REWARD_PER_REPLICA: { type: oracledb.STRING } };

/**
 * OracleService
 *
 * Manages structured metadata for stored chunks.  Oracle is used because
 * it supports rich SQL queries, JSON columns, and can be exported easily.
 *
 * Table:
 *   CHUNKS — one row per stored chunk (metadata + replication state).
 *            CHUNK_ID / OWNER are base58 addresses, CONTENT_HASH is the
 *            hex sha256, REPLICATORS a JSON array of base58 addresses.
 */
@Injectable()
export class OracleService implements MetadataStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleService.name);
  private pool: oracledb.Pool;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const user = this.config.get<string>('oracle.user');
    const password = this.config.get<string>('oracle.password');
    const connectionString = this.config.get<string>('oracle.connectionString');

    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

    this.pool = await oracledb.createPool({
      user,
      password,
      connectString: connectionString,
      poolMin: 2,
      poolMax: 10,
      poolIncrement: 1,
    });

    await this._ensureSchema();
    this.logger.log(`Oracle connection pool created (${connectionString})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.close(0);
  }

  // ── Schema bootstrap ────────────────────────────────────────────────────────

  private async _ensureSchema(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      // CHUNKS table
      await conn.execute(`
        BEGIN
          EXECUTE IMMEDIATE 'CREATE TABLE CHUNKS (
            CHUNK_ID           VARCHAR2(44)   PRIMARY KEY,
            OWNER              VARCHAR2(44)   NOT NULL,
            CONTENT_HASH       VARCHAR2(64)   NOT NULL,
            SIZE_BYTES         NUMBER(10)     NOT NULL,
            REQUIRED_REPLICAS  NUMBER(3)      NOT NULL,
            CONFIRMED_REPLICAS NUMBER(3)      DEFAULT 0,
            STATE              VARCHAR2(8)    DEFAULT ''Hot'',
            RECLAIMED          NUMBER(1)      DEFAULT 0,
            REWARD_PER_REPLICA NUMBER(20)     DEFAULT 0,
            REPLICATORS        VARCHAR2(1024) DEFAULT ''[]'',
            SLOT               NUMBER(20),
            UPLOADED_AT        TIMESTAMP      NOT NULL,
            STORED_AT          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
            CONFIRMED_AT       TIMESTAMP,
            CONFIRM_SIGNATURE  VARCHAR2(88)
          )';
        EXCEPTION WHEN OTHERS THEN
          IF SQLCODE != -955 THEN RAISE; END IF;
        END;
      `);

      // Lookups by uploader
      await conn.execute(`
        BEGIN
          EXECUTE IMMEDIATE 'CREATE INDEX CHUNKS_OWNER_IDX ON CHUNKS (OWNER)';
        EXCEPTION WHEN OTHERS THEN
          IF SQLCODE NOT IN (-955, -1408) THEN RAISE; END IF;
        END;
      `);

      // A CHUNKS table left by the Monad node (bytes32 ids, no SIZE_BYTES)
      // would make every insert fail later: refuse to start instead
      const columns = await conn.execute<any>(
        `SELECT COUNT(*) AS N FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = 'CHUNKS' AND COLUMN_NAME IN ('SIZE_BYTES', 'REPLICATORS', 'CONFIRM_SIGNATURE')`,
      );
      if (Number(columns.rows?.[0]?.N ?? 0) !== 3) {
        throw new Error(
          'Table CHUNKS exists with another layout (Monad node?). Use a fresh Oracle schema or drop it.',
        );
      }

      await conn.commit();
    } finally {
      await conn.close();
    }
  }

  // ── Chunk CRUD ──────────────────────────────────────────────────────────────

  async upsertChunk(chunk: ChunkRecord): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.execute(
        `MERGE INTO CHUNKS c
         USING DUAL
         ON (c.CHUNK_ID = :chunkId)
         WHEN MATCHED THEN UPDATE SET
           CONFIRMED_REPLICAS = :confirmedReplicas,
           STATE              = :state,
           RECLAIMED          = :reclaimed,
           REPLICATORS        = :replicators,
           SLOT               = NVL(:slot, SLOT),
           CONFIRMED_AT       = NVL(:confirmedAt, CONFIRMED_AT),
           CONFIRM_SIGNATURE  = NVL(:confirmSignature, CONFIRM_SIGNATURE)
         WHEN NOT MATCHED THEN INSERT (
           CHUNK_ID, OWNER, CONTENT_HASH, SIZE_BYTES, REQUIRED_REPLICAS,
           CONFIRMED_REPLICAS, STATE, RECLAIMED, REWARD_PER_REPLICA, REPLICATORS,
           SLOT, UPLOADED_AT, STORED_AT, CONFIRMED_AT, CONFIRM_SIGNATURE
         ) VALUES (
           :chunkId, :owner, :contentHash, :sizeBytes, :requiredReplicas,
           :confirmedReplicas, :state, :reclaimed, :rewardPerReplica, :replicators,
           :slot, :uploadedAt, :storedAt, :confirmedAt, :confirmSignature
         )`,
        {
          chunkId: chunk.chunkId,
          owner: chunk.owner,
          contentHash: chunk.contentHash,
          sizeBytes: chunk.size,
          requiredReplicas: chunk.requiredReplicas,
          confirmedReplicas: chunk.confirmedReplicas,
          state: chunk.state,
          reclaimed: chunk.reclaimed ? 1 : 0,
          rewardPerReplica: chunk.rewardPerReplica,
          replicators: JSON.stringify(chunk.replicators ?? []),
          slot: { val: chunk.slot ?? null, type: oracledb.NUMBER },
          uploadedAt: { val: chunk.uploadedAt, type: oracledb.DB_TYPE_TIMESTAMP },
          storedAt: { val: chunk.storedAt, type: oracledb.DB_TYPE_TIMESTAMP },
          confirmedAt: { val: chunk.confirmedAt ?? null, type: oracledb.DB_TYPE_TIMESTAMP },
          confirmSignature: { val: chunk.confirmSignature ?? null, type: oracledb.STRING },
        },
      );
      await conn.commit();
    } finally {
      await conn.close();
    }
  }

  async updateChunkState(chunkId: string, update: ChunkStateUpdate): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      // Typed binds: NVL(null, column) must keep the column's type
      await conn.execute(
        `UPDATE CHUNKS SET
           STATE              = :state,
           CONFIRMED_REPLICAS = NVL(:confirmedReplicas, CONFIRMED_REPLICAS),
           RECLAIMED          = NVL(:reclaimed, RECLAIMED),
           REPLICATORS        = NVL(:replicators, REPLICATORS),
           CONFIRMED_AT       = NVL(:confirmedAt, CONFIRMED_AT),
           CONFIRM_SIGNATURE  = NVL(:confirmSignature, CONFIRM_SIGNATURE)
         WHERE CHUNK_ID = :chunkId`,
        {
          state: update.state,
          confirmedReplicas: { val: update.confirmedReplicas ?? null, type: oracledb.NUMBER },
          reclaimed: {
            val: update.reclaimed === undefined ? null : update.reclaimed ? 1 : 0,
            type: oracledb.NUMBER,
          },
          replicators: {
            val: update.replicators ? JSON.stringify(update.replicators) : null,
            type: oracledb.STRING,
          },
          confirmedAt: { val: update.confirmedAt ?? null, type: oracledb.DB_TYPE_TIMESTAMP },
          confirmSignature: { val: update.confirmSignature ?? null, type: oracledb.STRING },
          chunkId,
        },
      );
      await conn.commit();
    } finally {
      await conn.close();
    }
  }

  async getChunk(chunkId: string): Promise<ChunkRecord | null> {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute<any>(
        `SELECT * FROM CHUNKS WHERE CHUNK_ID = :chunkId`,
        { chunkId },
        { fetchInfo: FETCH_INFO },
      );
      if (!result.rows || result.rows.length === 0) return null;
      return this._mapRow(result.rows[0]);
    } finally {
      await conn.close();
    }
  }

  async countChunks(): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute<any>(`SELECT COUNT(*) AS N FROM CHUNKS`);
      return Number(result.rows?.[0]?.N ?? 0);
    } finally {
      await conn.close();
    }
  }

  // ── Query API ───────────────────────────────────────────────────────────────

  /**
   * Execute a structured JSON query against the CHUNKS table.
   *
   * Supported filter fields: owner, state, chunkId, contentHash
   * Supported orderBy: uploadedAt, storedAt, confirmedReplicas, size, slot, chunkId
   */
  async queryChunks(params: ChunkQuery): Promise<ChunkRecord[]> {
    const conditions: string[] = ['1=1'];
    const binds: Record<string, any> = {};

    if (params.filter?.owner) {
      conditions.push('OWNER = :owner');
      binds.owner = params.filter.owner;
    }
    if (params.filter?.state !== undefined) {
      conditions.push('STATE = :state');
      binds.state = params.filter.state;
    }
    if (params.filter?.chunkId) {
      conditions.push('CHUNK_ID = :chunkId');
      binds.chunkId = params.filter.chunkId;
    }
    if (params.filter?.contentHash) {
      conditions.push('CONTENT_HASH = :contentHash');
      binds.contentHash = params.filter.contentHash.toLowerCase();
    }

    // Whitelist orderBy to prevent SQL injection
    const safeOrderBy =
      ORDER_BY_COLUMNS[params.orderBy as OrderByField] ?? ORDER_BY_COLUMNS.uploadedAt;
    const safeOrder = params.order === 'asc' ? 'ASC' : 'DESC';

    // Row-limiting clause (12c+): ordering happens before the page is cut
    binds.skipRows = params.offset ?? 0;
    binds.maxRows = Math.min(params.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT);

    const sql = `
      SELECT * FROM CHUNKS
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${safeOrderBy} ${safeOrder}, CHUNK_ID ASC
      OFFSET :skipRows ROWS FETCH NEXT :maxRows ROWS ONLY
    `;

    const conn = await this.pool.getConnection();
    try {
      const result = await conn.execute<any>(sql, binds, { fetchInfo: FETCH_INFO });
      return (result.rows ?? []).map((row) => this._mapRow(row));
    } finally {
      await conn.close();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _mapRow(row: any): ChunkRecord {
    let replicators: string[] = [];
    try {
      replicators = JSON.parse(row.REPLICATORS ?? '[]');
    } catch {
      // keep [] for a corrupt value
    }
    return {
      chunkId: row.CHUNK_ID,
      owner: row.OWNER,
      contentHash: row.CONTENT_HASH,
      size: row.SIZE_BYTES,
      requiredReplicas: row.REQUIRED_REPLICAS,
      confirmedReplicas: row.CONFIRMED_REPLICAS,
      state: row.STATE,
      reclaimed: row.RECLAIMED === 1,
      rewardPerReplica: row.REWARD_PER_REPLICA ?? '0',
      replicators,
      slot: row.SLOT ?? null,
      uploadedAt: row.UPLOADED_AT,
      storedAt: row.STORED_AT,
      confirmedAt: row.CONFIRMED_AT ?? null,
      confirmSignature: row.CONFIRM_SIGNATURE ?? null,
    };
  }
}
