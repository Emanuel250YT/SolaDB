import { createHash, randomBytes } from 'crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

const COMMANDS: [new (...args: any[]) => unknown, string][] = [
  [HeadBucketCommand, 'HeadBucket'],
  [CreateBucketCommand, 'CreateBucket'],
  [PutObjectCommand, 'PutObject'],
  [GetObjectCommand, 'GetObject'],
  [HeadObjectCommand, 'HeadObject'],
  [DeleteObjectCommand, 'DeleteObject'],
  [ListObjectsV2Command, 'ListObjectsV2'],
  [CreateMultipartUploadCommand, 'CreateMultipartUpload'],
  [UploadPartCommand, 'UploadPart'],
  [CompleteMultipartUploadCommand, 'CompleteMultipartUpload'],
  [AbortMultipartUploadCommand, 'AbortMultipartUpload'],
];

/** An error shaped like the SDK's S3ServiceException */
export function s3Error(name: string, status: number): Error {
  const error = new Error(name) as Error & { $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * In-process S3: buckets, objects, ranged GETs, paginated listings and
 * multipart uploads, with S3's error names and status codes.  Every command
 * is recorded in `sent`; `failNext` injects failures.
 */
export class FakeS3 {
  readonly buckets = new Set<string>();
  /** `${bucket}/${key}` → bytes */
  readonly objects = new Map<string, Buffer>();
  readonly uploads = new Map<string, { bucket: string; key: string; parts: Map<number, { etag: string; data: Buffer }> }>();
  readonly sent: { name: string; input: any }[] = [];
  /** S3 rejects parts below 5 MiB except the last one; 0 = no check */
  minPartSize = 0;
  private readonly failures: { name: string; error: Error }[] = [];

  constructor(...buckets: string[]) {
    for (const bucket of buckets) this.buckets.add(bucket);
  }

  get client(): S3Client {
    return this as unknown as S3Client;
  }

  /** The next `name` command (e.g. "PutObject") fails with `error` */
  failNext(name: string, error: Error): void {
    this.failures.push({ name, error });
  }

  count(name: string): number {
    return this.sent.filter((call) => call.name === name).length;
  }

  inputs(name: string): any[] {
    return this.sent.filter((call) => call.name === name).map((call) => call.input);
  }

  /** Keys of a bucket, sorted */
  keys(bucket: string): string[] {
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(`${bucket}/`))
      .map((k) => k.slice(bucket.length + 1))
      .sort();
  }

  async send(command: { input: any }): Promise<any> {
    const name = COMMANDS.find(([type]) => command instanceof type)?.[1];
    if (!name) throw new Error(`FakeS3: unsupported command ${command.constructor.name}`);
    const input = command.input;
    this.sent.push({ name, input });

    const failure = this.failures.findIndex((f) => f.name === name);
    if (failure >= 0) throw this.failures.splice(failure, 1)[0].error;

    if (name === 'HeadBucket') {
      if (!this.buckets.has(input.Bucket)) throw s3Error('NotFound', 404);
      return {};
    }
    if (name === 'CreateBucket') {
      if (this.buckets.has(input.Bucket)) throw s3Error('BucketAlreadyOwnedByYou', 409);
      this.buckets.add(input.Bucket);
      return {};
    }
    if (!this.buckets.has(input.Bucket)) throw s3Error('NoSuchBucket', 404);
    const id = `${input.Bucket}/${input.Key}`;

    switch (name) {
      case 'PutObject': {
        const data = await toBuffer(input.Body);
        if (input.ContentLength !== undefined && input.ContentLength !== data.length) {
          throw s3Error('IncompleteBody', 400);
        }
        this.objects.set(id, data);
        return { ETag: etag(data) };
      }
      case 'GetObject': {
        const data = this.objects.get(id);
        if (!data) throw s3Error('NoSuchKey', 404);
        let slice = data;
        if (input.Range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
          if (!match) throw s3Error('InvalidArgument', 400);
          const start = Number(match[1]);
          if (start >= data.length) throw s3Error('InvalidRange', 416);
          slice = data.subarray(start, Math.min(Number(match[2]), data.length - 1) + 1);
        }
        const copy = new Uint8Array(slice);
        return { ContentLength: copy.length, Body: { transformToByteArray: async () => copy } };
      }
      case 'HeadObject': {
        const data = this.objects.get(id);
        if (!data) throw s3Error('NotFound', 404);
        return { ContentLength: data.length, ETag: etag(data) };
      }
      case 'DeleteObject':
        this.objects.delete(id);
        return {};
      case 'ListObjectsV2': {
        const max = Math.min(input.MaxKeys ?? 1000, 1000);
        const all = this.keys(input.Bucket).filter(
          (key) => key.startsWith(input.Prefix ?? '') && (!input.ContinuationToken || key > input.ContinuationToken),
        );
        const page = all.slice(0, max);
        const truncated = all.length > page.length;
        return {
          Contents: page.map((Key) => ({ Key, Size: this.objects.get(`${input.Bucket}/${Key}`).length })),
          KeyCount: page.length,
          IsTruncated: truncated,
          NextContinuationToken: truncated ? page[page.length - 1] : undefined,
        };
      }
      case 'CreateMultipartUpload': {
        const uploadId = randomBytes(8).toString('hex');
        this.uploads.set(uploadId, { bucket: input.Bucket, key: input.Key, parts: new Map() });
        return { UploadId: uploadId };
      }
      case 'UploadPart': {
        const upload = this.uploads.get(input.UploadId);
        if (!upload) throw s3Error('NoSuchUpload', 404);
        const data = await toBuffer(input.Body);
        if (input.ContentLength !== undefined && input.ContentLength !== data.length) {
          throw s3Error('IncompleteBody', 400);
        }
        const tag = etag(data);
        upload.parts.set(input.PartNumber, { etag: tag, data });
        return { ETag: tag };
      }
      case 'CompleteMultipartUpload': {
        const upload = this.uploads.get(input.UploadId);
        if (!upload) throw s3Error('NoSuchUpload', 404);
        const listed: { ETag: string; PartNumber: number }[] = input.MultipartUpload?.Parts ?? [];
        const pieces: Buffer[] = [];
        listed.forEach((part, i) => {
          const stored = upload.parts.get(part.PartNumber);
          if (!stored || stored.etag !== part.ETag) throw s3Error('InvalidPart', 400);
          if (i > 0 && part.PartNumber <= listed[i - 1].PartNumber) throw s3Error('InvalidPartOrder', 400);
          if (i < listed.length - 1 && stored.data.length < this.minPartSize) throw s3Error('EntityTooSmall', 400);
          pieces.push(stored.data);
        });
        this.objects.set(id, Buffer.concat(pieces));
        this.uploads.delete(input.UploadId);
        return { ETag: `"multipart-${listed.length}"` };
      }
      case 'AbortMultipartUpload':
        if (!this.uploads.delete(input.UploadId)) throw s3Error('NoSuchUpload', 404);
        return {};
    }
  }
}

const etag = (data: Buffer) => `"${createHash('md5').update(data).digest('hex')}"`;
