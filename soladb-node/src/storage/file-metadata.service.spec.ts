import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileMetadataService } from './file-metadata.service';
import { blobShard, chunkRecord, describeMetadataStore } from '../../test/metadata-store.contract';

beforeAll(() => Logger.overrideLogger(false));

const open = async (dataDir: string) => {
  const store = new FileMetadataService(new ConfigService({ storage: { dataDir } }));
  await store.onModuleInit();
  return store;
};

// Upserts, partial updates, the query language and blob shards: the
// behaviour shared with the Postgres and Oracle stores
describeMetadataStore('FileMetadataService', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-meta-'));
  const opened: FileMetadataService[] = [];
  const reopen = async () => {
    const store = await open(dataDir);
    opened.push(store);
    return store;
  };
  return {
    store: await reopen(),
    reopen,
    cleanup: async () => {
      for (const store of opened) await store.onModuleDestroy();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
});

describe('FileMetadataService', () => {
  let dataDir: string;
  let store: FileMetadataService;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-meta-'));
    store = await open(dataDir);
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('persists chunks and blob shards to DATA_DIR/metadata.json', async () => {
    const r = chunkRecord({ confirmedAt: new Date('2026-03-01T10:00:00Z'), confirmSignature: 'sig1' });
    const s = blobShard({ storedAt: new Date('2026-05-01T00:00:00Z'), state: 'Stored' });
    await store.upsertChunk(r);
    await store.upsertBlobShard(s);

    expect(fs.readdirSync(dataDir)).toEqual(['metadata.json']);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'metadata.json'), 'utf8'));
    expect(saved.chunks.map((c) => c.chunkId)).toEqual([r.chunkId]);
    expect(saved.blobShards).toEqual([{ ...s, storedAt: '2026-05-01T00:00:00.000Z' }]);
  });

  it('reads a metadata.json written before blob shards existed', async () => {
    const r = chunkRecord();
    fs.writeFileSync(path.join(dataDir, 'metadata.json'), JSON.stringify({ version: 1, chunks: [r] }));
    const reopened = await open(dataDir);
    expect(await reopened.getChunk(r.chunkId)).toEqual(r);
    expect(await reopened.listBlobShards()).toEqual([]);
  });
});
