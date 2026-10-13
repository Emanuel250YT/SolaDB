import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { BLOB_STORE, blobShardKey } from './blob-store';
import { CHUNK_STORE } from './chunk-store';
import { METADATA_STORE } from './metadata-store';
import { FsBlobStore } from './fs-blob-store.service';
import { FsChunkStore } from './fs-chunk-store.service';
import { FileMetadataService } from './file-metadata.service';
import { S3BlobStore } from './s3-blob-store.service';
import { S3ChunkStore } from './s3-chunk-store.service';
import { PostgresMetadataService } from './postgres-metadata.service';
import { RocksDBService } from './rocksdb.service';
import { OracleService } from './oracle.service';
import { blobShard } from '../../test/metadata-store.contract';

describe('StorageModule / StorageService', () => {
  let dataDir: string;

  const compile = (storage: Record<string, unknown>) =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ storage: { dataDir, ...storage }, s3: { bucket: 'b' } })],
        }),
        StorageModule,
      ],
    }).compile();

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-storage-'));
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('instantiates only the configured drivers', async () => {
    // compile() builds the providers without running onModuleInit (no I/O)
    const s3 = await compile({ chunkStore: 's3', metadataStore: 'postgres', blobStore: 's3' });
    expect(s3.get(CHUNK_STORE)).toBeInstanceOf(S3ChunkStore);
    expect(s3.get(METADATA_STORE)).toBeInstanceOf(PostgresMetadataService);
    expect(s3.get(BLOB_STORE)).toBeInstanceOf(S3BlobStore);

    const defaults = await compile({ chunkStore: 'rocksdb', metadataStore: 'oracle', blobStore: 'fs' });
    expect(defaults.get(CHUNK_STORE)).toBeInstanceOf(RocksDBService);
    expect(defaults.get(METADATA_STORE)).toBeInstanceOf(OracleService);
    expect(defaults.get(BLOB_STORE)).toBeInstanceOf(FsBlobStore);
    expect(defaults.get(StorageService).drivers).toEqual({ chunkStore: 'rocksdb', metadataStore: 'oracle', blobStore: 'fs' });
  });

  it('exposes the blob store and the blob-shard records through the facade', async () => {
    const moduleRef = await compile({ chunkStore: 'fs', metadataStore: 'file', blobStore: 'fs' });
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    expect(storage.blobs).toBe(moduleRef.get(BLOB_STORE));

    const shard = blobShard({ index: 2 });
    const key = blobShardKey(shard.blob, shard.index);
    await storage.blobs.stageAppend(key, 0, Buffer.from('shard'));
    await storage.blobs.commit(key);
    await storage.upsertBlobShard(shard);
    await storage.updateBlobShard(shard.blob, shard.index, { state: 'Stored', storedAt: new Date('2026-05-01T00:00:00Z') });

    expect(await storage.blobs.readRange(key, 1, 3)).toEqual(Buffer.from('har'));
    expect(await storage.getBlobShard(shard.blob, shard.index)).toMatchObject({ state: 'Stored' });
    expect(await storage.listBlobShards({ state: 'Stored' })).toHaveLength(1);
    await storage.deleteBlobShard(shard.blob, shard.index);
    expect(await storage.listBlobShards()).toEqual([]);
    await moduleRef.close();
  });

  it('keeps the three-argument constructor; blobs throws without a BlobStore', async () => {
    const config = new ConfigService({ storage: { dataDir } });
    const storage = new StorageService(new FsChunkStore(config), new FileMetadataService(config), config);
    expect(() => storage.blobs).toThrow('No BlobStore configured');
  });
});
