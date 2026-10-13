import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ChunkStore, isChunkId } from './chunk-store';
import {
  S3Settings,
  bodyToBuffer,
  createS3Client,
  describeLocation,
  ensureBucket,
  isNotFound,
  listKeys,
  s3Settings,
} from './s3-client';

/**
 * S3ChunkStore
 *
 * Chunk store on any S3-compatible object store (CHUNK_STORE=s3): AWS S3,
 * Cloudflare R2, Backblaze B2, MinIO.  One object per chunk, at
 * `${S3_PREFIX}chunks/${chunkId}`.  Object stores cost a fraction of block
 * storage per GiB and grow without resizing volumes, so a node's capacity is
 * no longer bounded by its disk.
 *
 * Keys are validated as base58 addresses, like FsChunkStore.
 */
@Injectable()
export class S3ChunkStore implements ChunkStore, OnModuleInit {
  private readonly logger = new Logger(S3ChunkStore.name);
  private settings: S3Settings;
  private base: string;

  /** `client` replaces the one built from the configuration (tests) */
  constructor(
    private readonly config: ConfigService,
    private client?: S3Client,
  ) { }

  async onModuleInit(): Promise<void> {
    this.settings = s3Settings(this.config);
    this.base = `${this.settings.prefix}chunks/`;
    this.client ??= createS3Client(this.settings);
    await ensureBucket(this.client, this.settings, this.logger);
    this.logger.log(`Chunk objects in ${describeLocation(this.settings, 'chunks/')}`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async putChunk(chunkId: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: this._key(chunkId),
        Body: data,
        ContentLength: data.length,
      }),
    );
  }

  async getChunk(chunkId: string): Promise<Buffer | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.settings.bucket, Key: this._key(chunkId) }),
      );
      return await bodyToBuffer(object.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async hasChunk(chunkId: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: this._key(chunkId) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async deleteChunk(chunkId: string): Promise<void> {
    // Deleting a missing object succeeds on S3
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this._key(chunkId) }));
  }

  /** Every stored chunk id, sorted (ListObjectsV2 pages of up to 1000 keys) */
  async listChunkIds(): Promise<string[]> {
    const keys = await listKeys(this.client, this.settings.bucket, this.base, this.settings.listPageSize);
    return keys
      .map((key) => key.slice(this.base.length))
      .filter(isChunkId)
      .sort();
  }

  /** Object key of a chunk; rejects anything that is not a base58 address */
  private _key(chunkId: string): string {
    if (!isChunkId(chunkId)) throw new Error(`Invalid chunk id "${chunkId}"`);
    return `${this.base}${chunkId}`;
  }
}
