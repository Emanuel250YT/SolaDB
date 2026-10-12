import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileMetadataService } from './file-metadata.service';
import { ChunkRecord } from './metadata-store';

const OWNER_A = 'Dc7qDc12xMffFFDW7FjGP3zsNkQ9NNf4JHjXCPHMNM2T';
const OWNER_B = '5Du7fs6YscdvgF49CDKjiAkbZjhSSfixjJ6jjxr2z5Py';

let n = 0;
function record(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  n++;
  return {
    // ids sort in creation order (the store does not validate them)
    chunkId: `Chunk${String(n).padStart(6, '0')}`.padEnd(43, 'z'),
    owner: OWNER_A,
    contentHash: n.toString(16).padStart(64, 'a'),
    size: 1000 * n,
    requiredReplicas: 2,
    confirmedReplicas: 0,
    state: 'Hot',
    reclaimed: false,
    rewardPerReplica: '50000',
    replicators: [],
    slot: 100 + n,
    uploadedAt: new Date(Date.UTC(2026, 0, n)),
    storedAt: new Date(Date.UTC(2026, 1, n)),
    confirmedAt: null,
    confirmSignature: null,
    ...overrides,
  };
}

describe('FileMetadataService', () => {
  let dataDir: string;
  let store: FileMetadataService;
  const open = async () => {
    const s = new FileMetadataService(new ConfigService({ storage: { dataDir } }));
    await s.onModuleInit();
    return s;
  };

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-meta-'));
    store = await open();
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('persists records to DATA_DIR/metadata.json and reloads them with real Dates', async () => {
    const r = record({ confirmedAt: new Date('2026-03-01T10:00:00Z'), confirmSignature: 'sig1' });
    await store.upsertChunk(r);

    const reopened = await open();
    const loaded = await reopened.getChunk(r.chunkId);
    expect(loaded).toEqual(r);
    expect(loaded.uploadedAt).toBeInstanceOf(Date);
    expect(loaded.confirmedAt).toBeInstanceOf(Date);
    expect(await reopened.countChunks()).toBe(1);
    expect(fs.readdirSync(dataDir)).toEqual(['metadata.json']);
  });

  it('upsert refreshes chain fields but keeps the first storedAt and this node\'s confirmation', async () => {
    const r = record({ confirmSignature: 'sig1', confirmedAt: new Date('2026-03-01T00:00:00Z') });
    await store.upsertChunk(r);
    await store.upsertChunk({
      ...r,
      state: 'Cool',
      confirmedReplicas: 2,
      replicators: [OWNER_B, OWNER_A],
      storedAt: new Date(),
      slot: null,
      confirmSignature: null,
      confirmedAt: null,
    });

    const loaded = await store.getChunk(r.chunkId);
    expect(loaded.state).toBe('Cool');
    expect(loaded.confirmedReplicas).toBe(2);
    expect(loaded.replicators).toEqual([OWNER_B, OWNER_A]);
    expect(loaded.storedAt).toEqual(r.storedAt);
    expect(loaded.slot).toBe(r.slot);
    expect(loaded.confirmSignature).toBe('sig1');
  });

  it('updateChunkState applies partial updates and ignores unknown chunks', async () => {
    const r = record();
    await store.upsertChunk(r);
    await store.updateChunkState(r.chunkId, { state: 'Cool', confirmedReplicas: 1 });
    await store.updateChunkState('UnknownChunk1111111111111111111111111111111', { state: 'Closed' });

    const loaded = await store.getChunk(r.chunkId);
    expect(loaded).toMatchObject({ state: 'Cool', confirmedReplicas: 1, reclaimed: false, replicators: [] });
    expect(await store.countChunks()).toBe(1);
  });

  it('returns copies, so callers cannot mutate the store', async () => {
    const r = record();
    await store.upsertChunk(r);
    const loaded = await store.getChunk(r.chunkId);
    loaded.replicators.push('x');
    loaded.state = 'Closed';
    expect((await store.getChunk(r.chunkId)).state).toBe('Hot');
    expect((await store.getChunk(r.chunkId)).replicators).toEqual([]);
  });

  it('coalesces concurrent writes without losing any', async () => {
    const records = Array.from({ length: 40 }, () => record());
    await Promise.all(records.map((r) => store.upsertChunk(r)));
    expect(await (await open()).countChunks()).toBe(40);
  });

  describe('queryChunks', () => {
    let rs: ChunkRecord[];

    beforeEach(async () => {
      rs = [
        record({ owner: OWNER_A, state: 'Hot', size: 300, confirmedReplicas: 0 }),
        record({ owner: OWNER_A, state: 'Cool', size: 100, confirmedReplicas: 2 }),
        record({ owner: OWNER_B, state: 'Cool', size: 200, confirmedReplicas: 1, slot: null }),
        record({ owner: OWNER_B, state: 'Closed', size: 200, confirmedReplicas: 2 }),
      ];
      for (const r of rs) await store.upsertChunk(r);
    });

    const ids = (list: ChunkRecord[]) => list.map((r) => r.chunkId);

    it('defaults to newest upload first, 50 per page', async () => {
      expect(ids(await store.queryChunks({}))).toEqual(ids([...rs].reverse()));
    });

    it('filters by owner, state, chunkId and contentHash (any case)', async () => {
      expect(ids(await store.queryChunks({ filter: { owner: OWNER_B } }))).toEqual(ids([rs[3], rs[2]]));
      expect(ids(await store.queryChunks({ filter: { state: 'Cool' } }))).toEqual(ids([rs[2], rs[1]]));
      expect(ids(await store.queryChunks({ filter: { owner: OWNER_A, state: 'Cool' } }))).toEqual(ids([rs[1]]));
      expect(ids(await store.queryChunks({ filter: { chunkId: rs[0].chunkId } }))).toEqual(ids([rs[0]]));
      expect(ids(await store.queryChunks({ filter: { contentHash: rs[2].contentHash.toUpperCase() } }))).toEqual(ids([rs[2]]));
      expect(await store.queryChunks({ filter: { state: 'Pending' } })).toEqual([]);
    });

    it('orders by any whitelisted field, ties broken by chunkId', async () => {
      expect(ids(await store.queryChunks({ orderBy: 'size', order: 'asc' }))).toEqual(ids([rs[1], rs[2], rs[3], rs[0]]));
      expect(ids(await store.queryChunks({ orderBy: 'size', order: 'desc' }))).toEqual(ids([rs[0], rs[2], rs[3], rs[1]]));
      expect(ids(await store.queryChunks({ orderBy: 'confirmedReplicas', order: 'asc' }))).toEqual(ids([rs[0], rs[2], rs[1], rs[3]]));
      expect(ids(await store.queryChunks({ orderBy: 'slot', order: 'asc' }))[0]).toBe(rs[2].chunkId); // null slot first
      expect(ids(await store.queryChunks({ orderBy: 'storedAt', order: 'asc' }))).toEqual(ids(rs));
      expect(ids(await store.queryChunks({ orderBy: 'chunkId', order: 'asc' }))).toEqual(ids(rs).sort());
    });

    it('falls back to uploadedAt for an unknown orderBy', async () => {
      expect(ids(await store.queryChunks({ orderBy: 'DROP TABLE' }))).toEqual(ids([...rs].reverse()));
    });

    it('paginates with limit / offset (limit capped at 1000)', async () => {
      const page = await store.queryChunks({ orderBy: 'storedAt', order: 'asc', limit: 2, offset: 1 });
      expect(ids(page)).toEqual(ids([rs[1], rs[2]]));
      expect(await store.queryChunks({ offset: 10 })).toEqual([]);

      for (let i = 0; i < 1001; i++) await store.upsertChunk(record());
      expect(await store.queryChunks({ limit: 5000 })).toHaveLength(1000);
    });
  });
});
