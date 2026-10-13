import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LocalBlobStaging, readExactly, statSize } from './blob-staging';
import {
  BlobStore,
  assertBlobKey,
  assertBlobPrefix,
  assertRange,
  isBlobKey,
  outOfRange,
} from './blob-store';

/** Temporary files of putObject / cross-device commits, inside the blob dir */
const TMP_DIR = '.tmp';

/**
 * FsBlobStore
 *
 * Blob store on the local filesystem (BLOB_STORE=fs): committed objects are
 * files under DATA_DIR/blobs (BLOB_DIR), at their key's path
 * (`${blob}/${index}` → blobs/<blob>/<index>); staged objects live in
 * DATA_DIR/blobs-staging (BLOB_STAGING_DIR).
 *
 * commit() fsyncs the staged file and renames it into place (a copy when
 * the two directories are on different volumes), putObject() writes a
 * temporary file and renames it, so readers never see a partial object.
 * Range reads are positional reads: a 1 KiB proof segment costs one read
 * whatever the shard size.  Keys are validated before they touch the disk.
 */
@Injectable()
export class FsBlobStore implements BlobStore, OnModuleInit {
  private readonly logger = new Logger(FsBlobStore.name);
  private dir: string;
  private tmpDir: string;
  private staging: LocalBlobStaging;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    const dataDir = this.config.get<string>('storage.dataDir');
    this.dir = path.resolve(this.config.get<string>('blobs.dir') ?? path.join(dataDir, 'blobs'));
    this.tmpDir = path.join(this.dir, TMP_DIR);
    this.staging = new LocalBlobStaging(
      path.resolve(this.config.get<string>('blobs.stagingDir') ?? path.join(dataDir, 'blobs-staging')),
    );

    // Leftovers of writes interrupted by a crash
    await fs.promises.rm(this.tmpDir, { recursive: true, force: true });
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    await this.staging.init();
    this.logger.log(`Blob shards in ${this.dir} (staging in ${this.staging.dir})`);
  }

  // ── Staging ─────────────────────────────────────────────────────────────────

  stageAppend(key: string, offset: number, data: Buffer): Promise<number> {
    return this.staging.append(key, offset, data);
  }

  stagedSize(key: string): Promise<number> {
    return this.staging.size(key);
  }

  readStaged(key: string, chunkSize: number): AsyncIterable<Buffer> {
    return this.staging.read(key, chunkSize);
  }

  async commit(key: string): Promise<void> {
    const target = this._path(key);
    await this.staging.commit(key, async (file) => {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.promises.rename(file, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // BLOB_DIR and BLOB_STAGING_DIR on different volumes
        const tmp = this._tmpFile();
        try {
          await fs.promises.copyFile(file, tmp);
          await syncFile(tmp);
          await fs.promises.rename(tmp, target);
        } finally {
          await fs.promises.rm(tmp, { force: true });
        }
      }
    });
  }

  discardStaged(key: string): Promise<void> {
    return this.staging.discard(key);
  }

  pruneStaged(olderThanMs: number): Promise<string[]> {
    return this.staging.prune(olderThanMs);
  }

  // ── Committed objects ───────────────────────────────────────────────────────

  async readRange(key: string, offset: number, length: number): Promise<Buffer | null> {
    const file = this._path(key);
    assertRange(key, offset, length);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, 'r');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null; // a directory: the prefix of other keys
      if (offset + length > stat.size) throw outOfRange(key, offset, length, stat.size);
      return await readExactly(handle, offset, length, key);
    } finally {
      await handle.close();
    }
  }

  async size(key: string): Promise<number | null> {
    return statSize(this._path(key));
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    const target = this._path(key);
    const tmp = this._tmpFile();
    try {
      const handle = await fs.promises.open(tmp, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.rename(tmp, target);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  async getObject(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this._path(key));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this._path(key);
    if ((await statSize(file)) === null) return;
    await fs.promises.rm(file, { force: true });

    // Drop the directories left empty (a deleted blob leaves nothing behind)
    for (let dir = path.dirname(file); dir !== this.dir && dir.startsWith(this.dir); dir = path.dirname(dir)) {
      try {
        await fs.promises.rmdir(dir);
      } catch {
        break; // not empty (or already gone)
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    assertBlobPrefix(prefix);
    // Walk only the deepest directory the prefix names
    const slash = prefix.lastIndexOf('/');
    const base = slash > 0 ? prefix.slice(0, slash) : '';
    if (base && !isBlobKey(base)) return [];
    const root = base ? this._path(base) : this.dir;

    const keys: string[] = [];
    const walk = async (dir: string, relative: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // .tmp
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) await walk(path.join(dir, entry.name), key);
        } else if (entry.isFile() && key.startsWith(prefix)) {
          keys.push(key);
        }
      }
    };
    await walk(root, base);
    return keys.sort();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Path of a committed object; rejects keys outside the alphabet */
  private _path(key: string): string {
    assertBlobKey(key);
    const file = path.resolve(this.dir, ...key.split('/'));
    // isBlobKey already rules out traversal; belt and braces
    if (!file.startsWith(this.dir + path.sep)) throw new Error(`Invalid blob key "${key}"`);
    return file;
  }

  private _tmpFile(): string {
    return path.join(this.tmpDir, `${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
