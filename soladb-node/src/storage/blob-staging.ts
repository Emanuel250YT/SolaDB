import * as fs from 'fs';
import * as path from 'path';
import { BlobOffsetError, assertBlobKey, isBlobKey } from './blob-store';

/** readStaged reads the disk in blocks of about this size */
const READ_BLOCK = 4 * 1024 * 1024;

/** "/" in keys becomes "~" in staged file names (keys never contain "~") */
const fileName = (key: string) => key.replace(/\//g, '~');
const keyOf = (name: string) => name.replace(/~/g, '/');

/**
 * LocalBlobStaging
 *
 * Incomplete blob objects on local disk, shared by FsBlobStore and
 * S3BlobStore: one file per key in a flat directory, written in order by
 * appends and kept across restarts so uploads resume where they stopped.
 *
 * Appends are not fsync'ed (the uploader learns the real staged size after a
 * crash and resumes from there, and the shard root is verified before
 * commit); commit() hands over a file that is synced first.  Appends, commit,
 * discard and pruning of one key are serialised; one process owns the
 * directory.
 */
export class LocalBlobStaging {
  private readonly locks = new KeyedMutex();

  constructor(readonly dir: string) { }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  /** Staged file of a key; rejects invalid keys */
  file(key: string): string {
    assertBlobKey(key);
    return path.join(this.dir, fileName(key));
  }

  async append(key: string, offset: number, data: Buffer): Promise<number> {
    const file = this.file(key);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(`Invalid offset ${offset} for "${key}"`);
    }
    return this.locks.run(key, async () => {
      const staged = await statSize(file);
      if (offset !== (staged ?? 0)) throw new BlobOffsetError(key, staged ?? 0, offset);

      // "a" creates the file and always writes at its end (= offset)
      const handle = await fs.promises.open(file, 'a');
      try {
        if (data.length > 0) await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return offset + data.length;
    });
  }

  async size(key: string): Promise<number> {
    return (await statSize(this.file(key))) ?? 0;
  }

  /** The staged bytes up to the size seen when reading starts */
  async *read(key: string, chunkSize: number): AsyncIterable<Buffer> {
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`Invalid chunk size ${chunkSize}`);
    }
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.file(key), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const size = (await handle.stat()).size;
      // Whole chunks per disk read; every block is a fresh buffer, so the
      // chunks handed out stay valid
      const block = Math.max(1, Math.floor(READ_BLOCK / chunkSize)) * chunkSize;
      for (let position = 0; position < size; position += block) {
        const buffer = await readExactly(handle, position, Math.min(block, size - position), key);
        for (let at = 0; at < buffer.length; at += chunkSize) {
          yield buffer.subarray(at, Math.min(at + chunkSize, buffer.length));
        }
      }
    } finally {
      await handle.close();
    }
  }

  async discard(key: string): Promise<void> {
    const file = this.file(key);
    await this.locks.run(key, () => fs.promises.rm(file, { force: true }));
  }

  /**
   * Under the key's lock, sync the staged file and hand it to `consume`
   * (which may move it away), then remove whatever is left.  Throws when
   * nothing is staged; when `consume` throws, the staged file stays.
   */
  async commit(key: string, consume: (file: string, size: number) => Promise<void>): Promise<void> {
    const file = this.file(key);
    await this.locks.run(key, async () => {
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(file, 'r+');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Nothing staged for "${key}"`);
        throw err;
      }
      let size: number;
      try {
        size = (await handle.stat()).size;
        await handle.sync();
      } finally {
        await handle.close();
      }
      await consume(file, size);
      await fs.promises.rm(file, { force: true });
    });
  }

  async prune(olderThanMs: number): Promise<string[]> {
    const cutoff = Date.now() - olderThanMs;
    const pruned: string[] = [];
    for (const name of await fs.promises.readdir(this.dir)) {
      const key = keyOf(name);
      if (name.startsWith('.') || !isBlobKey(key)) continue;
      const file = path.join(this.dir, name);
      const removed = await this.locks.run(key, async () => {
        // Re-check under the lock: an append may just have landed
        const stat = await fs.promises.stat(file).catch(() => null);
        if (!stat || stat.mtimeMs > cutoff) return false;
        await fs.promises.rm(file, { force: true });
        return true;
      });
      if (removed) pruned.push(key);
    }
    return pruned.sort();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** File size, or null when it does not exist */
export async function statSize(file: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Positional read of exactly `length` bytes (a short read means the file shrank) */
export async function readExactly(
  handle: fs.promises.FileHandle,
  position: number,
  length: number,
  key: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw new Error(`"${key}" shrank while being read`);
    filled += bytesRead;
  }
  return buffer;
}

/** Runs async sections one at a time per key */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, section: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    await previous;
    try {
      return await section();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
