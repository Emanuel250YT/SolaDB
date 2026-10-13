import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { CreateMultipartUploadCommand, DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import configuration from '../src/config/configuration';
import { S3ChunkStore } from '../src/storage/s3-chunk-store.service';
import { S3BlobStore } from '../src/storage/s3-blob-store.service';
import { PostgresMetadataService } from '../src/storage/postgres-metadata.service';
import { blobShardKey } from '../src/storage/blob-store';
import { createS3Client, listKeys, s3Settings } from '../src/storage/s3-client';
import { BLOB, describeBlobStore } from './blob-store.contract';
import { describeMetadataStore } from './metadata-store.contract';

/**
 * The S3 and Postgres drivers against real servers (CI job "node-storage":
 * MinIO + Postgres).  Skipped unless S3_ENDPOINT and DATABASE_URL are set,
 * e.g. against `docker compose up minio postgres`:
 *
 *   S3_ENDPOINT=http://localhost:9000 S3_FORCE_PATH_STYLE=true S3_BUCKET=soladb-it \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   DATABASE_URL=postgres://soladb:...@localhost:5432/soladb npx jest storage-integration
 *
 * Every test works under its own S3 prefix / Postgres schema (removed
 * afterwards); the bucket is created when missing.
 */
const enabled = Boolean(process.env.S3_ENDPOINT && process.env.DATABASE_URL);
const MiB = 1024 * 1024;

(enabled ? describe : describe.skip)('storage integration (real S3 + Postgres)', () => {
  const run = `it-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const dataDirs: string[] = [];
  const schemas: string[] = [];
  let counter = 0;

  /** The node's configuration from the environment, isolated under a fresh prefix / schema */
  const isolated = (s3: Record<string, unknown> = {}) => {
    const env = configuration();
    counter++;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-it-'));
    dataDirs.push(dataDir);
    const schema = `soladb_${run.replace(/-/g, '_')}_${counter}`;
    schemas.push(schema);
    return {
      schema,
      config: new ConfigService({
        ...env,
        storage: { ...env.storage, dataDir },
        blobs: { dir: path.join(dataDir, 'blobs'), stagingDir: path.join(dataDir, 'blobs-staging') },
        s3: {
          ...env.s3,
          bucket: env.s3.bucket || 'soladb-it',
          prefix: `${env.s3.prefix}${run}/${counter}/`,
          createBucket: true,
          // real S3 rules: parts of at least 5 MiB
          multipartThreshold: 6 * MiB,
          partSize: 5 * MiB,
          ...s3,
        },
        postgres: { ...env.postgres, schema },
      }),
    };
  };

  beforeAll(() => Logger.overrideLogger(false));

  afterAll(async () => {
    const env = configuration();
    const settings = s3Settings(new ConfigService({ s3: { ...env.s3, bucket: env.s3.bucket || 'soladb-it' } }));
    const client = createS3Client(settings);
    for (const key of await listKeys(client, settings.bucket, `${env.s3.prefix}${run}/`)) {
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }));
    }
    client.destroy();

    const pool = new Pool({ connectionString: env.postgres.url || undefined, max: 1 });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describeBlobStore(
    'S3BlobStore on a real S3 endpoint',
    async () => {
      const store = new S3BlobStore(isolated({ listPageSize: 2 }).config);
      await store.onModuleInit();
      return { store, cleanup: async () => undefined };
    },
    { largeObjectSize: 12 * MiB + 123 },
  );

  describeMetadataStore('PostgresMetadataService on a real server', async () => {
    const { config } = isolated();
    const opened: PostgresMetadataService[] = [];
    const reopen = async () => {
      const store = new PostgresMetadataService(config);
      await store.onModuleInit();
      opened.push(store);
      return store;
    };
    return {
      store: await reopen(),
      reopen,
      cleanup: async () => {
        for (const store of opened) await store.onModuleDestroy();
      },
    };
  });

  it('S3ChunkStore round-trips and lists chunks across pages', async () => {
    const store = new S3ChunkStore(isolated({ listPageSize: 2 }).config);
    await store.onModuleInit();
    const ids = [
      '3Nk1x9Wd5gUWvkR8f5zXfWgL8Wb7mEyW6jJtTK3hz3qA',
      '4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA',
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      'E2fDdT3enSsrzgEfKkYhc6zSQ1fNDZmKZpkLToD9igK1',
      'SysvarRent111111111111111111111111111111111',
    ];
    for (const id of ids) await store.putChunk(id, Buffer.from(`bytes of ${id}`));

    expect(await store.getChunk(ids[2])).toEqual(Buffer.from(`bytes of ${ids[2]}`));
    expect(await store.getChunk(BLOB)).toBeNull();
    expect(await store.hasChunk(ids[0])).toBe(true);
    expect(await store.hasChunk(BLOB)).toBe(false);
    expect(await store.listChunkIds()).toEqual([...ids].sort());
    await store.deleteChunk(ids[0]);
    await store.deleteChunk(ids[0]);
    expect(await store.listChunkIds()).toEqual(ids.slice(1).sort());
  });

  it('S3BlobStore commits large shards as a multipart upload and small ones in one PUT', async () => {
    const { config } = isolated();
    const client = createS3Client(s3Settings(config));
    const send = jest.spyOn(client, 'send');
    const store = new S3BlobStore(config, client);
    await store.onModuleInit();

    const large = randomBytes(11 * MiB);
    const key = blobShardKey(BLOB, 0);
    for (let offset = 0; offset < large.length; offset += 4 * MiB) {
      await store.stageAppend(key, offset, large.subarray(offset, offset + 4 * MiB));
    }
    await store.commit(key);
    const small = blobShardKey(BLOB, 1);
    await store.stageAppend(small, 0, Buffer.from('small shard'));
    await store.commit(small);

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.filter((c) => c instanceof CreateMultipartUploadCommand)).toHaveLength(1);
    expect(commands.filter((c) => c instanceof PutObjectCommand)).toHaveLength(1);
    expect(await store.size(key)).toBe(large.length);
    expect(await store.readRange(key, 5 * MiB - 512, 1024)).toEqual(large.subarray(5 * MiB - 512, 5 * MiB + 512));
    expect(await store.readRange(small, 6, 5)).toEqual(Buffer.from('shard'));
    client.destroy();
  }, 120_000);
});
