import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { LocalBlobStaging, readExactly } from './blob-staging';
import {
  BlobStore,
  assertBlobKey,
  assertBlobPrefix,
  assertRange,
  isBlobKey,
  outOfRange,
} from './blob-store';
import {
  S3Settings,
  bodyToBuffer,
  createS3Client,
  describeLocation,
  ensureBucket,
  errorName,
  httpStatus,
  isNotFound,
  isRetryable,
  listKeys,
  s3Settings,
} from './s3-client';

/** S3 allows at most 10 000 parts per multipart upload */
const MAX_PARTS = 10_000;
/** Attempts of a single-request upload (the SDK never retries a streamed body) */
const PUT_ATTEMPTS = 3;
const PUT_RETRY_DELAY_MS = 250;

/**
 * S3BlobStore
 *
 * Blob store on any S3-compatible object store (BLOB_STORE=s3).  Committed
 * objects live at `${S3_PREFIX}blobs/${key}`; incomplete objects are staged
 * on local disk (DATA_DIR/blobs-staging), since S3 objects cannot be
 * appended to and multipart parts must be ≥ 5 MiB.
 *
 * commit() streams the staged file to S3 — one PutObject up to
 * S3_MULTIPART_THRESHOLD (64 MiB), a multipart upload of S3_PART_SIZE parts
 * (S3_UPLOAD_CONCURRENCY in flight) above it — then deletes the staged file.
 * Memory stays bounded by concurrency × part size whatever the shard size.
 * Range reads are ranged GETs (`Range: bytes=a-b`), so a storage proof or a
 * fragment download never fetches the whole shard.
 */
@Injectable()
export class S3BlobStore implements BlobStore, OnModuleInit {
  private readonly logger = new Logger(S3BlobStore.name);
  private settings: S3Settings;
  private base: string;
  private staging: LocalBlobStaging;

  /** `client` replaces the one built from the configuration (tests) */
  constructor(
    private readonly config: ConfigService,
    private client?: S3Client,
  ) { }

  async onModuleInit(): Promise<void> {
    this.settings = s3Settings(this.config);
    this.base = `${this.settings.prefix}blobs/`;
    this.client ??= createS3Client(this.settings);
    const dataDir = this.config.get<string>('storage.dataDir');
    this.staging = new LocalBlobStaging(
      path.resolve(this.config.get<string>('blobs.stagingDir') ?? path.join(dataDir, 'blobs-staging')),
    );
    await this.staging.init();
    await ensureBucket(this.client, this.settings, this.logger);
    this.logger.log(`Blob shards in ${describeLocation(this.settings, 'blobs/')} (staging in ${this.staging.dir})`);
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
    const objectKey = this._key(key);
    await this.staging.commit(key, async (file, size) => {
      if (size > this.settings.multipartThreshold) {
        await this._multipartUpload(objectKey, file, size);
      } else {
        await this._putFile(objectKey, file, size);
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
    const objectKey = this._key(key);
    assertRange(key, offset, length);
    if (length === 0) {
      // No such thing as an empty Range header: check the bounds with HEAD
      const size = await this.size(key);
      if (size === null) return null;
      if (offset > size) throw outOfRange(key, offset, length, size);
      return Buffer.alloc(0);
    }

    let data: Buffer;
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: objectKey,
          Range: `bytes=${offset}-${offset + length - 1}`,
        }),
      );
      data = await bodyToBuffer(object.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      // offset at or past the end of the object
      if (errorName(err) === 'InvalidRange' || httpStatus(err) === 416) throw outOfRange(key, offset, length);
      throw err;
    }
    // S3 truncates a range that runs past the end
    if (data.length !== length) throw outOfRange(key, offset, length);
    return data;
  }

  async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: this._key(key) }));
      return Number(head.ContentLength ?? 0);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putObject(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.settings.bucket, Key: this._key(key), Body: data, ContentLength: data.length }),
    );
  }

  async getObject(key: string): Promise<Buffer | null> {
    try {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: this._key(key) }));
      return await bodyToBuffer(object.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this._key(key) }));
  }

  async list(prefix: string): Promise<string[]> {
    assertBlobPrefix(prefix);
    const keys = await listKeys(this.client, this.settings.bucket, this.base + prefix, this.settings.listPageSize);
    return keys
      .map((key) => key.slice(this.base.length))
      .filter(isBlobKey)
      .sort();
  }

  // ── Uploads ─────────────────────────────────────────────────────────────────

  /** One PutObject streamed from the staged file */
  private async _putFile(objectKey: string, file: string, size: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const body = fs.createReadStream(file);
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.settings.bucket, Key: objectKey, Body: body, ContentLength: size }),
        );
        return;
      } catch (err) {
        // The SDK refuses to retry a consumed stream: retry with a fresh one
        if (attempt >= PUT_ATTEMPTS || !isRetryable(err)) throw err;
        this.logger.warn(`Upload of ${objectKey} failed (${(err as Error).message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, PUT_RETRY_DELAY_MS * attempt));
      } finally {
        body.destroy();
      }
    }
  }

  /**
   * Multipart upload, parts read from the staged file with positional reads
   * (each part is a Buffer, so the SDK can retry it).  Aborted on failure,
   * so no orphan parts are billed.
   */
  private async _multipartUpload(objectKey: string, file: string, size: number): Promise<void> {
    const partSize = Math.max(this.settings.partSize, Math.ceil(size / MAX_PARTS));
    const partCount = Math.ceil(size / partSize);
    const target = { Bucket: this.settings.bucket, Key: objectKey };

    const { UploadId } = await this.client.send(new CreateMultipartUploadCommand(target));
    const handle = await fs.promises.open(file, 'r');
    try {
      const etags: string[] = new Array(partCount);
      let next = 0;
      let failure: unknown;
      const worker = async () => {
        while (failure === undefined && next < partCount) {
          const part = next++;
          try {
            const start = part * partSize;
            const length = Math.min(partSize, size - start);
            const body = await readExactly(handle, start, length, objectKey);
            const { ETag } = await this.client.send(
              new UploadPartCommand({ ...target, UploadId, PartNumber: part + 1, Body: body, ContentLength: length }),
            );
            etags[part] = ETag;
          } catch (err) {
            failure ??= err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.settings.uploadConcurrency, partCount) }, worker));
      if (failure !== undefined) throw failure;

      await this.client.send(
        new CompleteMultipartUploadCommand({
          ...target,
          UploadId,
          MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
        }),
      );
    } catch (err) {
      await this.client
        .send(new AbortMultipartUploadCommand({ ...target, UploadId }))
        .catch((abortErr) => this.logger.warn(`Could not abort upload ${UploadId}: ${(abortErr as Error).message}`));
      throw err;
    } finally {
      await handle.close();
    }
  }

  /** Object key of a blob key; rejects keys outside the alphabet */
  private _key(key: string): string {
    assertBlobKey(key);
    return `${this.base}${key}`;
  }
}
