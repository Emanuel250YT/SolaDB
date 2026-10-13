import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FsBlobStore } from './fs-blob-store.service';
import { blobShardKey } from './blob-store';
import { BAD_KEYS, BLOB, describeBlobStore } from '../../test/blob-store.contract';

beforeAll(() => Logger.overrideLogger(false));

const open = async (config: Record<string, unknown>) => {
  const store = new FsBlobStore(new ConfigService(config));
  await store.onModuleInit();
  return store;
};

describeBlobStore('FsBlobStore', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-blobs-'));
  return {
    store: await open({ storage: { dataDir } }),
    cleanup: async () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
});

describe('FsBlobStore', () => {
  let dataDir: string;
  let store: FsBlobStore;
  const key = blobShardKey(BLOB, 3);

  /** Every file under a directory, relative, with "/" separators */
  const files = (dir: string, relative = ''): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        return entry.isDirectory() ? files(path.join(dir, entry.name), name) : [name];
      })
      .sort();
  };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-blobs-'));
    store = await open({ storage: { dataDir } });
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('stages in DATA_DIR/blobs-staging and commits to DATA_DIR/blobs/<blob>/<index>', async () => {
    await store.stageAppend(key, 0, Buffer.from('shard bytes'));
    expect(files(path.join(dataDir, 'blobs-staging'))).toEqual([`${BLOB}~3`]);
    expect(files(path.join(dataDir, 'blobs'))).toEqual([]);

    await store.commit(key);
    expect(files(path.join(dataDir, 'blobs-staging'))).toEqual([]);
    expect(files(path.join(dataDir, 'blobs'))).toEqual([`${BLOB}/3`]);
    expect(fs.readFileSync(path.join(dataDir, 'blobs', BLOB, '3'))).toEqual(Buffer.from('shard bytes'));
  });

  it('resumes a staged upload after a restart and clears interrupted temporary files', async () => {
    await store.stageAppend(key, 0, Buffer.from('first half,'));
    fs.writeFileSync(path.join(dataDir, 'blobs', '.tmp', '123.abcd.tmp'), 'partial');

    const restarted = await open({ storage: { dataDir } });
    expect(await restarted.stagedSize(key)).toBe(11);
    expect(await restarted.stageAppend(key, 11, Buffer.from(' second half'))).toBe(23);
    expect(fs.readdirSync(path.join(dataDir, 'blobs', '.tmp'))).toEqual([]);
  });

  it('honours BLOB_DIR and BLOB_STAGING_DIR', async () => {
    const blobs = path.join(dataDir, 'big-volume');
    const staging = path.join(dataDir, 'fast-disk');
    const custom = await open({ storage: { dataDir }, blobs: { dir: blobs, stagingDir: staging } });
    await custom.stageAppend(key, 0, Buffer.from('x'));
    expect(files(staging)).toEqual([`${BLOB}~3`]);
    await custom.commit(key);
    expect(files(blobs)).toEqual([`${BLOB}/3`]);
  });

  it('removes the directories a delete leaves empty', async () => {
    await store.putObject(`${BLOB}/deep/er/x`, Buffer.from('x'));
    await store.putObject(`${BLOB}/roots`, Buffer.from('r'));
    await store.delete(`${BLOB}/deep/er/x`);
    expect(fs.existsSync(path.join(dataDir, 'blobs', BLOB, 'deep'))).toBe(false);
    await store.delete(`${BLOB}/roots`);
    expect(fs.existsSync(path.join(dataDir, 'blobs', BLOB))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'blobs'))).toBe(true);
  });

  it('treats a key that is the directory of other keys as missing', async () => {
    await store.putObject(`${BLOB}/roots`, Buffer.from('r'));
    expect(await store.getObject(BLOB)).toBeNull();
    expect(await store.size(BLOB)).toBeNull();
    expect(await store.readRange(BLOB, 0, 1)).toBeNull();
  });

  it('never writes outside its directories, whatever the key', async () => {
    for (const bad of BAD_KEYS) {
      await store.stageAppend(bad, 0, Buffer.from('x')).catch(() => undefined);
      await store.putObject(bad, Buffer.from('x')).catch(() => undefined);
    }
    expect(files(dataDir)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dataDir), 'escape'))).toBe(false);
  });
});
