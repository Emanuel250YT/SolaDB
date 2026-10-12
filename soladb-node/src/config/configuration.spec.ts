import { PROGRAM_ADDRESS } from '@soladb/sdk';
import configuration from './configuration';

describe('configuration', () => {
  const saved = { ...process.env };
  const withEnv = (env: Record<string, string>) => {
    process.env = { ...saved, ...env };
    return configuration();
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to devnet, "finalized" reads and the production stores', () => {
    for (const key of ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'SOLADB_PROGRAM_ID', 'SOLANA_COMMITMENT', 'CHUNK_STORE', 'METADATA_STORE', 'DATA_DIR', 'ROCKSDB_PATH']) {
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
    expect(config.storage).toMatchObject({ chunkStore: 'rocksdb', metadataStore: 'oracle', dataDir: './data' });
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
    expect(config.storage).toMatchObject({ chunkStore: 'fs', metadataStore: 'file' });
    expect(config.rocksdb.path.replace(/\\/g, '/')).toBe('/var/soladb/rocksdb');
  });

  it('fails fast on invalid values', () => {
    expect(() => withEnv({ SOLANA_COMMITMENT: 'processed' })).toThrow('SOLANA_COMMITMENT');
    expect(() => withEnv({ CHUNK_STORE: 'leveldb' })).toThrow('CHUNK_STORE');
    expect(() => withEnv({ METADATA_STORE: 'postgres' })).toThrow('METADATA_STORE');
    expect(() => withEnv({ POLL_INTERVAL_MS: 'soon' })).toThrow('POLL_INTERVAL_MS');
    expect(() => withEnv({ MIN_REWARD_LAMPORTS: '0.5' })).toThrow('MIN_REWARD_LAMPORTS');
    expect(() => withEnv({ REPLICATE_OWNERS: 'not-an-address' })).toThrow('REPLICATE_OWNERS');
  });
});
