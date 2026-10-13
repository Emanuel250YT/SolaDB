import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { PostgresMetadataService } from './postgres-metadata.service';
import { chunkRecord, describeMetadataStore } from '../../test/metadata-store.contract';

beforeAll(() => Logger.overrideLogger(false));

/** An in-memory Postgres (pg-mem) speaking the node-postgres API */
function memoryDatabase() {
  // pg-mem flags clauses it ignores (a repeated CREATE TABLE IF NOT EXISTS)
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool: MemoryPool } = db.adapters.createPg();
  const pools: Pool[] = [];
  return {
    db,
    pool: (): Pool => {
      const pool = new MemoryPool() as Pool;
      pools.push(pool);
      return pool;
    },
    end: async () => {
      for (const pool of pools) await pool.end();
    },
  };
}

const config = (postgres: Record<string, unknown> = {}) => new ConfigService({ postgres });

// pg-mem runs the same SQL as a real server (the integration test runs this
// contract against one too); its numeric is a JS number, hence exactU64
describeMetadataStore(
  'PostgresMetadataService',
  async () => {
    const memory = memoryDatabase();
    const reopen = async () => {
      const store = new PostgresMetadataService(config(), memory.pool());
      await store.onModuleInit();
      return store;
    };
    return { store: await reopen(), reopen, cleanup: memory.end };
  },
  { exactU64: false },
);

describe('PostgresMetadataService', () => {
  it('creates the tables and the indexes for every filter and sort key', async () => {
    const memory = memoryDatabase();
    const store = new PostgresMetadataService(config(), memory.pool());
    await store.onModuleInit();

    const tables = memory.db.public.many(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(new Set(tables.map((t) => t.table_name))).toEqual(new Set(['chunks', 'blob_shards']));
    const indexed = memory.db.public
      .getTable('chunks')
      .listIndices()
      .map((index) => index.expressions.join(','));
    for (const column of ['owner', 'state', 'content_hash', 'uploaded_at', 'stored_at', 'confirmed_replicas', 'size_bytes', 'slot']) {
      expect(indexed.some((expressions) => expressions.split(',')[0] === column)).toBe(true);
    }
    await memory.end();
  });

  it('starts again over existing tables (restart)', async () => {
    const memory = memoryDatabase();
    const first = new PostgresMetadataService(config(), memory.pool());
    await first.onModuleInit();
    const r = chunkRecord();
    await first.upsertChunk(r);

    const second = new PostgresMetadataService(config(), memory.pool());
    await second.onModuleInit();
    expect(await second.getChunk(r.chunkId)).toEqual(r);
    await memory.end();
  });

  it('refuses a same-named table with another layout', async () => {
    const memory = memoryDatabase();
    memory.db.public.none(`CREATE TABLE chunks (chunk_id text PRIMARY KEY, bytes32 text)`);
    const store = new PostgresMetadataService(config(), memory.pool());
    await expect(store.onModuleInit()).rejects.toThrow('another layout');
    await memory.end();
  });

  it('puts the tables in PG_SCHEMA when set', async () => {
    const memory = memoryDatabase();
    const store = new PostgresMetadataService(config({ schema: 'node_one' }), memory.pool());
    await store.onModuleInit();
    const r = chunkRecord();
    await store.upsertChunk(r);

    expect(memory.db.getSchema('node_one').many('SELECT chunk_id FROM chunks')).toEqual([{ chunk_id: r.chunkId }]);
    expect(memory.db.public.getTable('chunks', true)).toBeNull();
    await memory.end();
  });

  it('rejects an unsafe schema name', async () => {
    const store = new PostgresMetadataService(config({ schema: 'x"; DROP TABLE chunks; --' }), {} as Pool);
    await expect(store.onModuleInit()).rejects.toThrow('Invalid PG_SCHEMA');
  });
});
