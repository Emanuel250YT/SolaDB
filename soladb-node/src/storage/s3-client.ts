import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

const MiB = 1024 * 1024;

/** The `s3.*` configuration, with the defaults of configuration.ts */
export interface S3Settings {
  bucket: string;
  /** Custom endpoint (MinIO, R2, B2); empty = AWS */
  endpoint: string;
  region: string;
  /** Empty = the AWS default credential chain */
  accessKeyId: string;
  secretAccessKey: string;
  /** "" or ending with "/" */
  prefix: string;
  forcePathStyle: boolean;
  createBucket: boolean;
  /** Blob objects above this size are committed with a multipart upload */
  multipartThreshold: number;
  partSize: number;
  uploadConcurrency: number;
  /** ListObjectsV2 page size (S3 caps it at 1000; smaller in tests) */
  listPageSize: number;
}

export function s3Settings(config: ConfigService): S3Settings {
  const s3 = config.get<Partial<S3Settings>>('s3') ?? {};
  const settings: S3Settings = {
    bucket: s3.bucket ?? '',
    endpoint: s3.endpoint ?? '',
    region: s3.region || 'us-east-1',
    accessKeyId: s3.accessKeyId ?? '',
    secretAccessKey: s3.secretAccessKey ?? '',
    prefix: s3.prefix ?? '',
    forcePathStyle: s3.forcePathStyle ?? false,
    createBucket: s3.createBucket ?? false,
    multipartThreshold: s3.multipartThreshold ?? 64 * MiB,
    partSize: s3.partSize ?? 16 * MiB,
    uploadConcurrency: Math.max(1, s3.uploadConcurrency ?? 4),
    listPageSize: Math.min(1000, Math.max(1, s3.listPageSize ?? 1000)),
  };
  if (!settings.bucket) throw new Error('S3_BUCKET is not set');
  return settings;
}

export function createS3Client(settings: S3Settings): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint || undefined,
    forcePathStyle: settings.forcePathStyle,
    credentials:
      settings.accessKeyId && settings.secretAccessKey
        ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
        : undefined,
    // Checksums only where an operation requires them: the CRC32 defaults of
    // recent SDKs (aws-chunked uploads) break several S3-compatible stores.
    // Content is verified against hashes / Merkle roots anyway.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Where objects of this node live, for logs (no credentials) */
export function describeLocation(settings: S3Settings, folder: string): string {
  const where = settings.endpoint ? ` at ${originOf(settings.endpoint)}` : '';
  return `s3://${settings.bucket}/${settings.prefix}${folder}${where}`;
}

/**
 * Check the bucket at boot: create it when missing and S3_CREATE_BUCKET is
 * set, refuse to start otherwise (fail fast on a typo or bad credentials).
 */
export async function ensureBucket(client: S3Client, settings: S3Settings, logger: Logger): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!settings.createBucket) {
    throw new Error(`S3 bucket "${settings.bucket}" does not exist (set S3_CREATE_BUCKET=true to create it)`);
  }
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: settings.bucket,
        // AWS outside us-east-1 wants the region spelled out; other stores do not
        ...(!settings.endpoint && settings.region !== 'us-east-1'
          ? { CreateBucketConfiguration: { LocationConstraint: settings.region as any } }
          : {}),
      }),
    );
    logger.log(`Created S3 bucket "${settings.bucket}"`);
  } catch (err) {
    // Another store of this node (or another node) won the race
    if (errorName(err) !== 'BucketAlreadyOwnedByYou') throw err;
  }
}

/** Every key under `prefix`, following ListObjectsV2 continuation tokens */
export async function listKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
  pageSize = 1000,
): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: pageSize, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** GetObject body → Buffer */
export async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A missing object (GetObject: NoSuchKey; HeadObject: NotFound / bare 404) */
export function isNotFound(err: unknown): boolean {
  const name = errorName(err);
  if (name === 'NoSuchKey' || name === 'NotFound') return true;
  return httpStatus(err) === 404 && name !== 'NoSuchBucket';
}

/** Worth another attempt: throttling, server errors, network failures */
export function isRetryable(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === undefined) return true; // no response at all
  return status >= 500 || status === 429 || status === 408 || errorName(err) === 'RequestTimeout';
}

export function errorName(err: unknown): string | undefined {
  return (err as { name?: string })?.name;
}

export function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'a custom endpoint';
  }
}
