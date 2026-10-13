import { PROGRAM_ADDRESS } from '@soladb/sdk';
import configuration from './configuration';

const STORAGE_ENV = [
  'CHUNK_STORE', 'METADATA_STORE', 'BLOB_STORE', 'DATA_DIR', 'ROCKSDB_PATH', 'BLOB_DIR', 'BLOB_STAGING_DIR',
  'S3_BUCKET', 'S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PREFIX',
  'S3_FORCE_PATH_STYLE', 'S3_CREATE_BUCKET', 'S3_MULTIPART_THRESHOLD', 'S3_PART_SIZE', 'S3_UPLOAD_CONCURRENCY',
  'DATABASE_URL', 'PG_SCHEMA', 'PG_POOL_MAX',
];

describe('configuration', () => {
  const saved = { ...process.env };
  // The machine's own storage settings must not leak into the expectations
  const clean = Object.fromEntries(Object.entries(saved).filter(([key]) => !STORAGE_ENV.includes(key)));
  const withEnv = (env: Record<string, string>) => {
    process.env = { ...clean, ...env };
    return configuration();
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to devnet, "finalized" reads and the production stores', () => {
    process.env = { ...clean };
    for (const key of ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'SOLADB_PROGRAM_ID', 'SOLANA_COMMITMENT']) {
      delete process.env[key];
    }
    const config = configuration();
    expect(config.solana).toMatchObject({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      programId: PROGRAM_ADDRESS,
      commitment: 'finalized',
      priorityFeeLamports: 0n,
    });
    expect(config.storage).toMatchObject({ chunkStore: 'rocksdb', metadataStore: 'oracle', blobStore: 'fs', dataDir: './data' });
    expect(config.blobs.dir.replace(/\\/g, '/')).toBe('data/blobs');
    expect(config.blobs.stagingDir.replace(/\\/g, '/')).toBe('data/blobs-staging');
    expect(config.s3).toMatchObject({
      bucket: '',
      endpoint: '',
      region: 'us-east-1',
      prefix: '',
      forcePathStyle: false,
      createBucket: false,
      multipartThreshold: 64 * 1024 * 1024,
      partSize: 16 * 1024 * 1024,
      uploadConcurrency: 4,
    });
    expect(config.postgres).toEqual({ url: '', schema: '', poolMax: 10 });
    expect(config.replication.owners).toEqual([]);
  });

  it('parses lamports, booleans and owner lists', () => {
    const config = withEnv({
      MIN_REWARD_LAMPORTS: '25000',
      PRIORITY_FEE_LAMPORTS: '1000',
      UPDATE_ENDPOINT_ON_START: 'true',
      REPLICATE_OWNERS: 'Dc7qDc12xMffFFDW7FjGP3zsNkQ9NNf4JHjXCPHMNM2T, 5Du7fs6YscdvgF49CDKjiAkbZjhSSfixjJ6jjxr2z5Py',
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      DATA_DIR: '/var/soladb',
    });
    expect(config.replication.minRewardLamports).toBe(25_000n);
    expect(config.solana.priorityFeeLamports).toBe(1_000n);
    expect(config.replication.updateEndpointOnStart).toBe(true);
    expect(config.replication.owners).toHaveLength(2);
    expect(config.storage).toMatchObject({ chunkStore: 'fs', metadataStore: 'file', blobStore: 'fs' });
    expect(config.rocksdb.path.replace(/\\/g, '/')).toBe('/var/soladb/rocksdb');
    expect(config.blobs.dir.replace(/\\/g, '/')).toBe('/var/soladb/blobs');
  });

  it('reads the S3 and Postgres settings; blobs follow CHUNK_STORE=s3', () => {
    const config = withEnv({
      CHUNK_STORE: 's3',
      METADATA_STORE: 'postgres',
      S3_BUCKET: 'soladb',
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'auto',
      S3_PREFIX: '/node-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_CREATE_BUCKET: '1',
      S3_PART_SIZE: String(8 * 1024 * 1024),
      DATABASE_URL: 'postgres://soladb@db/soladb',
      PG_SCHEMA: 'node_1',
      BLOB_DIR: '/mnt/big',
    });
    expect(config.storage).toMatchObject({ chunkStore: 's3', metadataStore: 'postgres', blobStore: 's3' });
    expect(config.s3).toMatchObject({
      bucket: 'soladb',
      endpoint: 'http://minio:9000',
      region: 'auto',
      prefix: 'node-1/',
      forcePathStyle: true,
      createBucket: true,
      partSize: 8 * 1024 * 1024,
    });
    expect(config.postgres).toMatchObject({ url: 'postgres://soladb@db/soladb', schema: 'node_1' });
    expect(config.blobs.dir).toBe('/mnt/big');

    expect(withEnv({ CHUNK_STORE: 's3', S3_BUCKET: 'b', BLOB_STORE: 'fs' }).storage.blobStore).toBe('fs');
    expect(withEnv({ BLOB_STORE: 's3', S3_BUCKET: 'b' }).storage).toMatchObject({ chunkStore: 'rocksdb', blobStore: 's3' });
  });

  it('fails fast on invalid values', () => {
    expect(() => withEnv({ SOLANA_COMMITMENT: 'processed' })).toThrow('SOLANA_COMMITMENT');
    expect(() => withEnv({ CHUNK_STORE: 'leveldb' })).toThrow('CHUNK_STORE');
    expect(() => withEnv({ METADATA_STORE: 'mysql' })).toThrow('METADATA_STORE');
    expect(() => withEnv({ BLOB_STORE: 'rocksdb' })).toThrow('BLOB_STORE');
    expect(() => withEnv({ CHUNK_STORE: 's3' })).toThrow('S3_BUCKET');
    expect(() => withEnv({ BLOB_STORE: 's3' })).toThrow('S3_BUCKET');
    expect(() => withEnv({ S3_PART_SIZE: '1048576' })).toThrow('S3_PART_SIZE');
    expect(() => withEnv({ PG_SCHEMA: 'Bad-Schema' })).toThrow('PG_SCHEMA');
    expect(() => withEnv({ POLL_INTERVAL_MS: 'soon' })).toThrow('POLL_INTERVAL_MS');
    expect(() => withEnv({ MIN_REWARD_LAMPORTS: '0.5' })).toThrow('MIN_REWARD_LAMPORTS');
    expect(() => withEnv({ REPLICATE_OWNERS: 'not-an-address' })).toThrow('REPLICATE_OWNERS');
  });
});
