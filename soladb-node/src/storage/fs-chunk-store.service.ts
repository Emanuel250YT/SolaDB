import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ChunkStore, isChunkId } from './chunk-store';

/**
 * FsChunkStore
 *
 * Development chunk store (CHUNK_STORE=fs): one file per chunk under
 * DATA_DIR/chunks, named after the chunk account address.  Needs no native
 * module, so the node runs anywhere Node does.
 *
 * Writes go to a temporary file that is fsync'ed and renamed into place, so
 * a crash never leaves a truncated chunk behind.  Keys are validated as
 * base58 addresses before they touch the filesystem.
 */
@Injectable()
export class FsChunkStore implements ChunkStore, OnModuleInit {
  private readonly logger = new Logger(FsChunkStore.name);
  private dir: string;

  constructor(private readonly config: ConfigService) { }

  async onModuleInit(): Promise<void> {
    this.dir = path.resolve(this.config.get<string>('storage.dataDir'), 'chunks');
    await fs.promises.mkdir(this.dir, { recursive: true });

    // Leftovers of writes interrupted by a crash
    for (const name of await fs.promises.readdir(this.dir)) {
      if (name.endsWith('.tmp')) await fs.promises.rm(path.join(this.dir, name), { force: true });
    }
    this.logger.log(`Chunk files in ${this.dir}`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async putChunk(chunkId: string, data: Buffer): Promise<void> {
    const file = this._file(chunkId);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

    const handle = await fs.promises.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.promises.rename(tmp, file);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      // Windows refuses to replace a file another request is reading.  The
      // key commits to the content hash, so the file there has the same bytes.
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && fs.existsSync(file)) return;
      throw err;
    }
  }

  async getChunk(chunkId: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this._file(chunkId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async hasChunk(chunkId: string): Promise<boolean> {
    try {
      await fs.promises.access(this._file(chunkId));
      return true;
    } catch {
      return false;
    }
  }

  async deleteChunk(chunkId: string): Promise<void> {
    await fs.promises.rm(this._file(chunkId), { force: true });
  }

  async listChunkIds(): Promise<string[]> {
    const names = await fs.promises.readdir(this.dir);
    return names.filter(isChunkId).sort();
  }

  /** Path of a chunk file; rejects anything that is not a base58 address */
  private _file(chunkId: string): string {
    if (!isChunkId(chunkId)) throw new Error(`Invalid chunk id "${chunkId}"`);
    return path.join(this.dir, chunkId);
  }
}
