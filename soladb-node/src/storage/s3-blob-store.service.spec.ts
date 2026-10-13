import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3BlobStore } from './s3-blob-store.service';
import { blobShardKey } from './blob-store';
import { FakeS3, s3Error } from '../../test/fake-s3';
import { BLOB, describeBlobStore } from '../../test/blob-store.contract';

beforeAll(() => Logger.overrideLogger(false));

const BUCKET = 'soladb-test';

async function open(dataDir: string, fake: FakeS3, s3: Record<string, unknown> = {}) {
  const store = new S3BlobStore(
    new ConfigService({
      storage: { dataDir },
      s3: { bucket: BUCKET, prefix: 'node-1/', multipartThreshold: 1024 * 1024, partSize: 256 * 1024, ...s3 },
    }),
    fake.client,
  );
  await store.onModuleInit();
  return store;
}

// Small threshold and parts: the large round trip goes through multipart
describeBlobStore('S3BlobStore', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-s3-blobs-'));
  return {
    store: await open(dataDir, new FakeS3(BUCKET), { listPageSize: 2 }),
    cleanup: async () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
});

describe('S3BlobStore', () => {
  let dataDir: string;
  let fake: FakeS3;
  const key = blobShardKey(BLOB, 3);
  const staged = () => path.join(dataDir, 'blobs-staging', `${BLOB}~3`);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-s3-blobs-'));
    fake = new FakeS3(BUCKET);
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('stages on local disk and commits small objects with one streamed PutObject', async () => {
    const store = await open(dataDir, fake);
    const data = randomBytes(5000);
    await store.stageAppend(key, 0, data);
    expect(fs.readFileSync(staged())).toEqual(data);
    expect(fake.count('PutObject')).toBe(0);

    await store.commit(key);
    expect(fake.count('PutObject')).toBe(1);
    expect(fake.count('CreateMultipartUpload')).toBe(0);
    expect(fake.inputs('PutObject')[0]).toMatchObject({ Key: `node-1/blobs/${key}`, ContentLength: 5000 });
    expect(fake.inputs('PutObject')[0].Body).toBeInstanceOf(fs.ReadStream);
    expect(fake.objects.get(`${BUCKET}/node-1/blobs/${key}`)).toEqual(data);
    expect(fs.existsSync(staged())).toBe(false);
  });

  it('commits objects above S3_MULTIPART_THRESHOLD as S3_PART_SIZE parts', async () => {
    const store = await open(dataDir, fake, { multipartThreshold: 1000, partSize: 300, uploadConcurrency: 3 });
    const data = randomBytes(2500);
    await store.stageAppend(key, 0, data);
    await store.commit(key);

    const parts = fake.inputs('UploadPart');
    expect(parts.map((p) => p.PartNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parts.map((p) => p.ContentLength).sort((a, b) => b - a)).toEqual([300, 300, 300, 300, 300, 300, 300, 300, 100]);
    expect(fake.count('PutObject')).toBe(0);
    expect(fake.inputs('CompleteMultipartUpload')[0].MultipartUpload.Parts.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fake.objects.get(`${BUCKET}/node-1/blobs/${key}`)).toEqual(data);
    expect(fake.uploads.size).toBe(0);
    expect(fs.existsSync(staged())).toBe(false);
  });

  it('keeps the commit at or under 1000 bytes in one PutObject (threshold is inclusive)', async () => {
    const store = await open(dataDir, fake, { multipartThreshold: 1000, partSize: 300 });
    await store.stageAppend(key, 0, randomBytes(1000));
    await store.commit(key);
    expect(fake.count('PutObject')).toBe(1);
    expect(fake.count('CreateMultipartUpload')).toBe(0);
  });

  it('aborts the multipart upload and keeps the staged file when a part fails', async () => {
    const store = await open(dataDir, fake, { multipartThreshold: 1000, partSize: 300, uploadConcurrency: 2 });
    const data = randomBytes(2500);
    await store.stageAppend(key, 0, data);
    fake.failNext('UploadPart', s3Error('AccessDenied', 403));

    await expect(store.commit(key)).rejects.toThrow('AccessDenied');
    expect(fake.count('AbortMultipartUpload')).toBe(1);
    expect(fake.uploads.size).toBe(0);
    expect(fake.count('CompleteMultipartUpload')).toBe(0);
    expect(await store.size(key)).toBeNull();
    expect(await store.stagedSize(key)).toBe(2500);

    // the staged file is intact: commit again
    await store.commit(key);
    expect(await store.readRange(key, 0, 2500)).toEqual(data);
  });

  it('retries a failed single PutObject with a fresh stream', async () => {
    const store = await open(dataDir, fake);
    const data = randomBytes(3000);
    await store.stageAppend(key, 0, data);
    fake.failNext('PutObject', s3Error('InternalError', 500));

    await store.commit(key);
    expect(fake.count('PutObject')).toBe(2);
    const [first, second] = fake.inputs('PutObject');
    expect(second.Body).not.toBe(first.Body);
    expect(await store.getObject(key)).toEqual(data);
  });

  it('does not retry client errors and keeps the staged file', async () => {
    const store = await open(dataDir, fake);
    await store.stageAppend(key, 0, randomBytes(3000));
    fake.failNext('PutObject', s3Error('AccessDenied', 403));

    await expect(store.commit(key)).rejects.toThrow('AccessDenied');
    expect(fake.count('PutObject')).toBe(1);
    expect(await store.stagedSize(key)).toBe(3000);
  });

  it('reads byte ranges with ranged GETs', async () => {
    const store = await open(dataDir, fake);
    const data = randomBytes(4096);
    await store.putObject(key, data);

    expect(await store.readRange(key, 1024, 1024)).toEqual(data.subarray(1024, 2048));
    expect(fake.inputs('GetObject').at(-1)).toMatchObject({ Key: `node-1/blobs/${key}`, Range: 'bytes=1024-2047' });
  });

  it('ignores objects outside the key alphabet when listing', async () => {
    const store = await open(dataDir, fake);
    await store.putObject(key, Buffer.from('x'));
    fake.objects.set(`${BUCKET}/node-1/blobs/${BLOB}/bad key`, Buffer.from('foreign'));
    fake.objects.set(`${BUCKET}/node-1/chunks/${BLOB}`, Buffer.from('a chunk'));
    expect(await store.list('')).toEqual([key]);
  });

  it('refuses to start without the bucket unless S3_CREATE_BUCKET is set', async () => {
    const empty = new FakeS3();
    await expect(open(dataDir, empty)).rejects.toThrow(`S3 bucket "${BUCKET}" does not exist`);
    await open(dataDir, empty, { createBucket: true });
    expect([...empty.buckets]).toEqual([BUCKET]);
    expect(empty.count('CreateBucket')).toBe(1);
  });

  it('surfaces errors other than "not found"', async () => {
    const store = await open(dataDir, fake);
    await store.putObject(key, Buffer.from('x'));
    fake.failNext('GetObject', s3Error('SlowDown', 503));
    await expect(store.readRange(key, 0, 1)).rejects.toThrow('SlowDown');
    fake.failNext('HeadObject', s3Error('Forbidden', 403));
    await expect(store.size(key)).rejects.toThrow('Forbidden');
  });
});
