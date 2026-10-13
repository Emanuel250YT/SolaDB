import { createHash, randomBytes } from 'crypto';
import {
  BlobOffsetError,
  BlobStore,
  blobRootsKey,
  blobSegmentHashesKey,
  blobShardKey,
} from '../src/storage/blob-store';

/**
 * Behaviour every BlobStore must share (fs, S3 against a fake, S3 against
 * MinIO): resumable staging, commit, bounds-checked range reads, small
 * objects, listing and key validation.  Each driver's spec calls
 * describeBlobStore.
 */

export const BLOB = '7qinSLNiY9z55KPHLXa9TJFwsUMJrqotwMu4ZXBaiNv';
export const OTHER_BLOB = 'E2fDdT3enSsrzgEfKkYhc6zSQ1fNDZmKZpkLToD9igK1';

export const BAD_KEYS = [
  '',
  '../escape',
  'a/../../escape',
  '/absolute',
  'a//b',
  'a/',
  './a',
  '.hidden',
  'trailing.',
  'back\\slash',
  'C:\\Windows',
  'with space',
  'CON',
  'blob/nul.txt',
  'x'.repeat(513),
];

export interface BlobStoreHarness {
  store: BlobStore;
  cleanup(): Promise<void>;
}

export interface BlobContractOptions {
  /** Size of the byte-for-byte round trip (big enough for multipart where it applies) */
  largeObjectSize?: number;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export async function collect(chunks: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of chunks) out.push(Buffer.from(chunk));
  return out;
}

export function describeBlobStore(
  name: string,
  setup: () => Promise<BlobStoreHarness>,
  options: BlobContractOptions = {},
): void {
  const largeObjectSize = options.largeObjectSize ?? 5 * 1024 * 1024 + 123;

  describe(`${name} (BlobStore contract)`, () => {
    let harness: BlobStoreHarness;
    let store: BlobStore;
    const key = blobShardKey(BLOB, 3);

    beforeEach(async () => {
      harness = await setup();
      store = harness.store;
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await harness.cleanup();
    });

    it('stages appends in order and rejects a wrong offset, telling where to resume', async () => {
      const a = randomBytes(1500);
      const b = randomBytes(700);
      expect(await store.stagedSize(key)).toBe(0);
      expect(await store.stageAppend(key, 0, a)).toBe(1500);

      for (const offset of [0, 1499, 1501, 9999]) {
        const error = await store.stageAppend(key, offset, b).catch((e) => e);
        expect(error).toBeInstanceOf(BlobOffsetError);
        expect(error).toMatchObject({ expected: 1500, offset });
      }
      await expect(store.stageAppend(key, -1, b)).rejects.toThrow(RangeError);

      expect(await store.stageAppend(key, 1500, b)).toBe(2200);
      expect(await store.stagedSize(key)).toBe(2200);
      expect(Buffer.concat(await collect(store.readStaged(key, 1 << 20)))).toEqual(Buffer.concat([a, b]));

      // staged bytes are not an object yet
      expect(await store.size(key)).toBeNull();
      expect(await store.list('')).toEqual([]);
    });

    it('streams staged bytes chunkSize at a time, the last chunk shorter', async () => {
      const data = randomBytes(1024 * 5 + 100);
      await store.stageAppend(key, 0, data);
      const chunks = await collect(store.readStaged(key, 1024));
      expect(chunks.map((c) => c.length)).toEqual([1024, 1024, 1024, 1024, 1024, 100]);
      expect(Buffer.concat(chunks)).toEqual(data);
      expect(await collect(store.readStaged(blobShardKey(BLOB, 9), 1024))).toEqual([]);
      await expect(collect(store.readStaged(key, 0))).rejects.toThrow(RangeError);
    });

    it('commits the staged object and serves bounds-checked byte ranges', async () => {
      const data = randomBytes(10_000);
      await store.stageAppend(key, 0, data.subarray(0, 4096));
      await store.stageAppend(key, 4096, data.subarray(4096));
      await store.commit(key);

      expect(await store.stagedSize(key)).toBe(0);
      expect(await store.size(key)).toBe(10_000);
      expect(await store.readRange(key, 0, 1024)).toEqual(data.subarray(0, 1024));
      expect(await store.readRange(key, 4096, 1024)).toEqual(data.subarray(4096, 5120));
      expect(await store.readRange(key, 9_990, 10)).toEqual(data.subarray(9_990));
      expect(await store.readRange(key, 0, 10_000)).toEqual(data);
      expect(await store.readRange(key, 10_000, 0)).toEqual(Buffer.alloc(0));

      await expect(store.readRange(key, 9_995, 10)).rejects.toThrow(RangeError);
      await expect(store.readRange(key, 10_000, 1)).rejects.toThrow(RangeError);
      await expect(store.readRange(key, 20_000, 1)).rejects.toThrow(RangeError);
      await expect(store.readRange(key, 10_001, 0)).rejects.toThrow(RangeError);
      await expect(store.readRange(key, -1, 4)).rejects.toThrow(RangeError);
      await expect(store.readRange(key, 0, 1.5)).rejects.toThrow(RangeError);
    });

    it('returns null for missing objects', async () => {
      const missing = blobShardKey(OTHER_BLOB, 0);
      expect(await store.readRange(missing, 0, 1024)).toBeNull();
      expect(await store.readRange(missing, 0, 0)).toBeNull();
      expect(await store.size(missing)).toBeNull();
      expect(await store.getObject(missing)).toBeNull();
    });

    it('commit replaces an existing object and fails when nothing is staged', async () => {
      await store.stageAppend(key, 0, Buffer.from('first version'));
      await store.commit(key);
      await store.stageAppend(key, 0, Buffer.from('second'));
      await store.commit(key);
      expect(await store.getObject(key)).toEqual(Buffer.from('second'));

      await expect(store.commit(key)).rejects.toThrow('Nothing staged');
      expect(await store.getObject(key)).toEqual(Buffer.from('second'));
    });

    it('discardStaged drops a staged object and leaves the committed one', async () => {
      await store.stageAppend(key, 0, Buffer.from('committed'));
      await store.commit(key);
      await store.stageAppend(key, 0, Buffer.from('abandoned upload'));
      await store.discardStaged(key);
      await store.discardStaged(key); // twice is fine

      expect(await store.stagedSize(key)).toBe(0);
      expect(await store.getObject(key)).toEqual(Buffer.from('committed'));
      expect(await store.stageAppend(key, 0, Buffer.from('fresh start'))).toBe(11);
    });

    it('pruneStaged drops uploads idle for longer than the limit', async () => {
      const other = blobShardKey(OTHER_BLOB, 1);
      await store.stageAppend(key, 0, Buffer.from('a'));
      await store.stageAppend(other, 0, Buffer.from('b'));
      expect(await store.pruneStaged(60_000)).toEqual([]);

      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 120_000);
      expect(await store.pruneStaged(60_000)).toEqual([key, other].sort());
      expect(await store.stagedSize(key)).toBe(0);
      expect(await store.stagedSize(other)).toBe(0);
    });

    it('stores small whole objects and lists committed keys by prefix, sorted', async () => {
      const roots = Buffer.from('roots list');
      const leaves = randomBytes(64);
      await store.putObject(blobRootsKey(BLOB), roots);
      await store.putObject(blobSegmentHashesKey(BLOB, 3), leaves);
      await store.putObject(blobShardKey(OTHER_BLOB, 0), Buffer.from('other'));
      await store.stageAppend(key, 0, Buffer.from('shard'));
      await store.commit(key);
      await store.stageAppend(blobShardKey(BLOB, 4), 0, Buffer.from('still staged'));

      expect(await store.getObject(blobRootsKey(BLOB))).toEqual(roots);
      expect(await store.getObject(blobSegmentHashesKey(BLOB, 3))).toEqual(leaves);
      await store.putObject(blobRootsKey(BLOB), Buffer.from('replaced'));
      expect(await store.getObject(blobRootsKey(BLOB))).toEqual(Buffer.from('replaced'));
      expect(await store.size(blobRootsKey(BLOB))).toBe(8);

      expect(await store.list(`${BLOB}/`)).toEqual([`${BLOB}/3`, `${BLOB}/3.leaves`, `${BLOB}/roots`]);
      expect(await store.list(`${BLOB}/3`)).toEqual([`${BLOB}/3`, `${BLOB}/3.leaves`]);
      expect(await store.list(BLOB.slice(0, 5))).toEqual([`${BLOB}/3`, `${BLOB}/3.leaves`, `${BLOB}/roots`]);
      expect(await store.list('')).toEqual(
        [`${BLOB}/3`, `${BLOB}/3.leaves`, `${BLOB}/roots`, `${OTHER_BLOB}/0`].sort(),
      );
      expect(await store.list('Nothing/')).toEqual([]);
    });

    it('deletes committed objects; deleting twice is fine', async () => {
      await store.putObject(blobRootsKey(BLOB), Buffer.from('r'));
      await store.stageAppend(key, 0, Buffer.from('shard'));
      await store.commit(key);

      await store.delete(key);
      await store.delete(key);
      expect(await store.size(key)).toBeNull();
      expect(await store.list('')).toEqual([blobRootsKey(BLOB)]);
      await store.delete(blobRootsKey(BLOB));
      expect(await store.list('')).toEqual([]);
    });

    it('rejects invalid keys and prefixes (no path traversal)', async () => {
      for (const bad of BAD_KEYS) {
        await expect(store.stageAppend(bad, 0, Buffer.from('x'))).rejects.toThrow('Invalid blob key');
        await expect(store.stagedSize(bad)).rejects.toThrow('Invalid blob key');
        await expect(store.commit(bad)).rejects.toThrow('Invalid blob key');
        await expect(store.readRange(bad, 0, 1)).rejects.toThrow('Invalid blob key');
        await expect(store.size(bad)).rejects.toThrow('Invalid blob key');
        await expect(store.putObject(bad, Buffer.from('x'))).rejects.toThrow('Invalid blob key');
        await expect(store.getObject(bad)).rejects.toThrow('Invalid blob key');
        await expect(store.delete(bad)).rejects.toThrow('Invalid blob key');
      }
      for (const bad of ['../', '/abs', 'a//b', 'a/../b', 'back\\slash']) {
        await expect(store.list(bad)).rejects.toThrow('Invalid blob key prefix');
      }
    });

    it('serialises concurrent appends: one wins at an offset, the others learn where to resume', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => store.stageAppend(key, 0, Buffer.alloc(100, i))),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ name: 'BlobOffsetError', expected: 100 });
      }
      expect(await store.stagedSize(key)).toBe(100);
    });

    it(`round-trips ${largeObjectSize} bytes byte for byte`, async () => {
      const data = randomBytes(largeObjectSize);
      const step = 1024 * 1024 + 7;
      for (let offset = 0; offset < data.length; offset += step) {
        await store.stageAppend(key, offset, data.subarray(offset, offset + step));
      }

      const hash = createHash('sha256');
      let segments = 0;
      for await (const segment of store.readStaged(key, 1024)) {
        hash.update(segment);
        segments++;
      }
      expect(hash.digest('hex')).toBe(sha256(data));
      expect(segments).toBe(Math.ceil(data.length / 1024));

      await store.commit(key);
      expect(await store.size(key)).toBe(data.length);
      for (const offset of [0, 1024 * 1023, data.length - 1024, Math.floor(data.length / 2)]) {
        expect(await store.readRange(key, offset, 1024)).toEqual(data.subarray(offset, offset + 1024));
      }
      const all: Buffer[] = [];
      for (let offset = 0; offset < data.length; offset += step) {
        all.push(await store.readRange(key, offset, Math.min(step, data.length - offset)));
      }
      expect(sha256(Buffer.concat(all))).toBe(sha256(data));
    }, 120_000);
  });
}
