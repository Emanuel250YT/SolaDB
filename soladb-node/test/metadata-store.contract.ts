import { BlobShardRecord, ChunkRecord, MetadataStore } from '../src/storage/metadata-store';

/**
 * Behaviour every MetadataStore must share (file, Postgres, and Oracle when
 * one is available): upsert rules, partial updates, the query language and
 * the blob-shard records.  Each driver's spec calls describeMetadataStore.
 */

export const OWNER_A = 'Dc7qDc12xMffFFDW7FjGP3zsNkQ9NNf4JHjXCPHMNM2T';
export const OWNER_B = '5Du7fs6YscdvgF49CDKjiAkbZjhSSfixjJ6jjxr2z5Py';

let n = 0;
export function chunkRecord(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
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

let b = 0;
export function blobShard(overrides: Partial<BlobShardRecord> = {}): BlobShardRecord {
  b++;
  return {
    // blobs sort in creation order
    blob: `Blob${String(b).padStart(6, '0')}`.padEnd(44, 'z'),
    index: 0,
    owner: OWNER_A,
    root: b.toString(16).padStart(64, 'b'),
    shardRoot: b.toString(16).padStart(64, 'c'),
    shardSize: 4 * 1024 * 1024,
    dataShards: 10,
    totalShards: 14,
    fragmentSize: 1024 * 1024,
    state: 'Staging',
    storedAt: null,
    confirmedAt: null,
    confirmSignature: null,
    provenAt: null,
    claimedUntil: null,
    expiresAt: null,
    ...overrides,
  };
}

export interface MetadataStoreHarness {
  store: MetadataStore;
  /** A new store over the same storage (a node restart) */
  reopen(): Promise<MetadataStore>;
  cleanup(): Promise<void>;
}

const ids = (list: ChunkRecord[]) => list.map((r) => r.chunkId);
const shardIds = (list: BlobShardRecord[]) => list.map((s) => `${s.blob}#${s.index}`);

export interface ContractOptions {
  /** u64 values above 2^53 survive (false for pg-mem, whose numeric is a JS number) */
  exactU64?: boolean;
}

export function describeMetadataStore(
  name: string,
  setup: () => Promise<MetadataStoreHarness>,
  options: ContractOptions = {},
): void {
  const { exactU64 = true } = options;

  describe(`${name} (MetadataStore contract)`, () => {
    let harness: MetadataStoreHarness;
    let store: MetadataStore;

    beforeEach(async () => {
      harness = await setup();
      store = harness.store;
    });

    afterEach(() => harness.cleanup());

    // ── Chunks ────────────────────────────────────────────────────────────────

    it('reloads records with real Dates after a restart', async () => {
      const r = chunkRecord({ confirmedAt: new Date('2026-03-01T10:00:00Z'), confirmSignature: 'sig1' });
      await store.upsertChunk(r);

      const reopened = await harness.reopen();
      const loaded = await reopened.getChunk(r.chunkId);
      expect(loaded).toEqual(r);
      expect(loaded.uploadedAt).toBeInstanceOf(Date);
      expect(loaded.confirmedAt).toBeInstanceOf(Date);
      expect(await reopened.countChunks()).toBe(1);
      expect(await reopened.getChunk('Missing111111111111111111111111111111111111')).toBeNull();
    });

    it('keeps u64 rewards and replicator lists intact', async () => {
      const r = chunkRecord({ rewardPerReplica: '9007199254740993', replicators: [OWNER_B, OWNER_A] });
      await store.upsertChunk(r);
      const loaded = await store.getChunk(r.chunkId);
      expect(loaded.replicators).toEqual([OWNER_B, OWNER_A]);
      expect(typeof loaded.rewardPerReplica).toBe('string');
      if (exactU64) expect(loaded.rewardPerReplica).toBe('9007199254740993');
    });

    it('upsert refreshes chain fields but keeps the first storedAt and this node\'s confirmation', async () => {
      const r = chunkRecord({ confirmSignature: 'sig1', confirmedAt: new Date('2026-03-01T00:00:00Z') });
      await store.upsertChunk(r);
      await store.upsertChunk({
        ...r,
        state: 'Cool',
        confirmedReplicas: 2,
        reclaimed: true,
        replicators: [OWNER_B, OWNER_A],
        storedAt: new Date(),
        slot: null,
        confirmSignature: null,
        confirmedAt: null,
        size: 1,
        rewardPerReplica: '1',
      });

      const loaded = await store.getChunk(r.chunkId);
      expect(loaded.state).toBe('Cool');
      expect(loaded.confirmedReplicas).toBe(2);
      expect(loaded.reclaimed).toBe(true);
      expect(loaded.replicators).toEqual([OWNER_B, OWNER_A]);
      expect(loaded.storedAt).toEqual(r.storedAt);
      expect(loaded.slot).toBe(r.slot);
      expect(loaded.confirmSignature).toBe('sig1');
      expect(loaded.confirmedAt).toEqual(r.confirmedAt);
      // immutable fields stay
      expect(loaded.size).toBe(r.size);
      expect(loaded.rewardPerReplica).toBe(r.rewardPerReplica);
    });

    it('updateChunkState applies partial updates and ignores unknown chunks', async () => {
      const r = chunkRecord();
      await store.upsertChunk(r);
      await store.updateChunkState(r.chunkId, { state: 'Cool', confirmedReplicas: 1 });
      await store.updateChunkState('UnknownChunk1111111111111111111111111111111', { state: 'Closed' });

      const loaded = await store.getChunk(r.chunkId);
      expect(loaded).toMatchObject({ state: 'Cool', confirmedReplicas: 1, reclaimed: false, replicators: [] });
      expect(await store.countChunks()).toBe(1);

      const confirmedAt = new Date('2026-04-01T12:00:00Z');
      await store.updateChunkState(r.chunkId, {
        state: 'Closed',
        reclaimed: true,
        replicators: [OWNER_A],
        confirmedAt,
        confirmSignature: 'sig2',
      });
      expect(await store.getChunk(r.chunkId)).toMatchObject({
        state: 'Closed',
        confirmedReplicas: 1,
        reclaimed: true,
        replicators: [OWNER_A],
        confirmedAt,
        confirmSignature: 'sig2',
      });
    });

    it('returns copies, so callers cannot mutate the store', async () => {
      const r = chunkRecord();
      await store.upsertChunk(r);
      const loaded = await store.getChunk(r.chunkId);
      loaded.replicators.push('x');
      loaded.state = 'Closed';
      expect((await store.getChunk(r.chunkId)).state).toBe('Hot');
      expect((await store.getChunk(r.chunkId)).replicators).toEqual([]);
    });

    it('keeps every one of many concurrent writes', async () => {
      const records = Array.from({ length: 40 }, () => chunkRecord());
      await Promise.all(records.map((r) => store.upsertChunk(r)));
      expect(await (await harness.reopen()).countChunks()).toBe(40);
    });

    describe('queryChunks', () => {
      let rs: ChunkRecord[];

      beforeEach(async () => {
        rs = [
          chunkRecord({ owner: OWNER_A, state: 'Hot', size: 300, confirmedReplicas: 0 }),
          chunkRecord({ owner: OWNER_A, state: 'Cool', size: 100, confirmedReplicas: 2 }),
          chunkRecord({ owner: OWNER_B, state: 'Cool', size: 200, confirmedReplicas: 1, slot: null }),
          chunkRecord({ owner: OWNER_B, state: 'Closed', size: 200, confirmedReplicas: 2 }),
        ];
        for (const r of rs) await store.upsertChunk(r);
      });

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
        expect(ids(await store.queryChunks({ orderBy: 'slot', order: 'desc' }))).toEqual(ids([rs[3], rs[1], rs[0], rs[2]])); // …and last
        expect(ids(await store.queryChunks({ orderBy: 'storedAt', order: 'asc' }))).toEqual(ids(rs));
        expect(ids(await store.queryChunks({ orderBy: 'chunkId', order: 'asc' }))).toEqual(ids(rs).sort());
        expect(ids(await store.queryChunks({ orderBy: 'chunkId', order: 'desc' }))).toEqual(ids(rs).sort().reverse());
      });

      it('sorts ids by code unit, like a JS sort (upper case before lower case)', async () => {
        const lower = chunkRecord({ chunkId: 'a'.repeat(43), size: 5 });
        const upper = chunkRecord({ chunkId: 'B'.repeat(43), size: 5 });
        await store.upsertChunk(lower);
        await store.upsertChunk(upper);
        const page = await store.queryChunks({ filter: { owner: OWNER_A }, orderBy: 'chunkId', order: 'asc' });
        expect(ids(page)).toEqual(ids([rs[0], rs[1], lower, upper]).sort());
        expect(ids(page).indexOf(upper.chunkId)).toBeLessThan(ids(page).indexOf(lower.chunkId));
      });

      it('falls back to uploadedAt for an unknown orderBy', async () => {
        expect(ids(await store.queryChunks({ orderBy: 'DROP TABLE' }))).toEqual(ids([...rs].reverse()));
      });

      it('paginates with limit / offset (limit capped at 1000)', async () => {
        const page = await store.queryChunks({ orderBy: 'storedAt', order: 'asc', limit: 2, offset: 1 });
        expect(ids(page)).toEqual(ids([rs[1], rs[2]]));
        expect(await store.queryChunks({ offset: 10 })).toEqual([]);

        for (let i = 0; i < 1001; i++) await store.upsertChunk(chunkRecord());
        expect(await store.queryChunks({ limit: 5000 })).toHaveLength(1000);
      }, 60_000);
    });

    // ── Blob shards ───────────────────────────────────────────────────────────

    it('keeps blob shard records apart from chunks and reloads them after a restart', async () => {
      const s = blobShard({
        index: 3,
        state: 'Confirmed',
        storedAt: new Date('2026-05-01T00:00:00Z'),
        confirmedAt: new Date('2026-05-01T00:01:00Z'),
        confirmSignature: 'sig-shard',
        provenAt: new Date('2026-05-02T00:00:00Z'),
        claimedUntil: new Date('2026-05-01T00:01:00Z'),
        expiresAt: new Date('2026-08-01T00:00:00Z'),
      });
      await store.upsertBlobShard(s);
      await store.upsertBlobShard(blobShard({ blob: s.blob, index: 4, fragmentSize: null }));

      const reopened = await harness.reopen();
      const loaded = await reopened.getBlobShard(s.blob, 3);
      expect(loaded).toEqual(s);
      expect(loaded.expiresAt).toBeInstanceOf(Date);
      expect(await reopened.getBlobShard(s.blob, 4)).toMatchObject({ fragmentSize: null, state: 'Staging', storedAt: null });
      expect(await reopened.getBlobShard(s.blob, 5)).toBeNull();
      expect(await reopened.countChunks()).toBe(0);
    });

    it('upsertBlobShard keeps identity fields, replaces state and only overwrites with non-null values', async () => {
      const storedAt = new Date('2026-05-01T00:00:00Z');
      const s = blobShard({ state: 'Stored', storedAt, fragmentSize: 4096 });
      await store.upsertBlobShard(s);

      const confirmedAt = new Date('2026-05-01T00:02:00Z');
      await store.upsertBlobShard({
        ...s,
        owner: OWNER_B,
        shardRoot: 'f'.repeat(64),
        shardSize: 1,
        state: 'Confirmed',
        fragmentSize: null,
        storedAt: null,
        confirmedAt,
        confirmSignature: 'sig1',
      });

      expect(await store.getBlobShard(s.blob, s.index)).toEqual({
        ...s,
        state: 'Confirmed',
        confirmedAt,
        confirmSignature: 'sig1',
      });
    });

    it('updateBlobShard sets exactly the given fields (null clears) and ignores unknown shards', async () => {
      const s = blobShard({ state: 'Confirmed', confirmSignature: 'sig1', provenAt: new Date('2026-05-02T00:00:00Z') });
      await store.upsertBlobShard(s);

      const claimedUntil = new Date('2026-06-01T00:00:00Z');
      await store.updateBlobShard(s.blob, s.index, { state: 'Lost', provenAt: null, claimedUntil });
      await store.updateBlobShard(s.blob, s.index, {});
      await store.updateBlobShard(s.blob, 9, { state: 'Lost' });

      expect(await store.getBlobShard(s.blob, s.index)).toEqual({ ...s, state: 'Lost', provenAt: null, claimedUntil });
      expect(await store.getBlobShard(s.blob, 9)).toBeNull();
    });

    it('listBlobShards orders by blob then index, filters by blob and state, and paginates', async () => {
      const first = blobShard({ index: 2, state: 'Confirmed' });
      const second = blobShard({ index: 0, state: 'Stored' });
      const shards = [
        second,
        { ...first, index: 7, state: 'Stored' as const },
        first,
        { ...first, index: 0, state: 'Staging' as const },
      ];
      for (const s of shards) await store.upsertBlobShard(s);

      const all = await store.listBlobShards();
      expect(shardIds(all)).toEqual([`${first.blob}#0`, `${first.blob}#2`, `${first.blob}#7`, `${second.blob}#0`]);
      expect(shardIds(await store.listBlobShards({ blob: first.blob, state: 'Stored' }))).toEqual([`${first.blob}#7`]);
      expect(shardIds(await store.listBlobShards({ state: 'Stored' }))).toEqual([`${first.blob}#7`, `${second.blob}#0`]);
      expect(shardIds(await store.listBlobShards({ limit: 2, offset: 1 }))).toEqual([`${first.blob}#2`, `${first.blob}#7`]);
      expect(await store.listBlobShards({ state: 'Expired' })).toEqual([]);
      expect(await store.listBlobShards({ offset: 10 })).toEqual([]);
    });

    it('deleteBlobShard removes one record; deleting twice is fine', async () => {
      const s = blobShard();
      await store.upsertBlobShard(s);
      await store.upsertBlobShard({ ...s, index: 1 });
      await store.deleteBlobShard(s.blob, 0);
      await store.deleteBlobShard(s.blob, 0);

      expect(await store.getBlobShard(s.blob, 0)).toBeNull();
      expect(shardIds(await store.listBlobShards({ blob: s.blob }))).toEqual([`${s.blob}#1`]);
    });

    it('returns copies of blob shard records', async () => {
      const s = blobShard({ storedAt: new Date('2026-05-01T00:00:00Z') });
      await store.upsertBlobShard(s);
      const loaded = await store.getBlobShard(s.blob, s.index);
      loaded.state = 'Lost';
      loaded.storedAt.setTime(0);
      expect(await store.getBlobShard(s.blob, s.index)).toEqual(s);
    });
  });
}
