/**
 * Blob shard bytes (docs/blob-protocol.md §3, §7).  A node keeps one shard
 * per blob: up to 1 GiB, received in resumable appends, verified, committed,
 * then read in small ranges for months (1 KiB segments for storage proofs,
 * F-byte fragments for downloads).  No method holds a whole shard in memory.
 *
 * Objects are addressed by keys: "/"-separated segments of letters, digits,
 * ".", "_" and "-" (see isBlobKey), e.g. `${blob}/${index}`.  A key cannot
 * also be the prefix directory of another key ("a" and "a/b").
 *
 * Implemented by FsBlobStore (BLOB_STORE=fs: DATA_DIR/blobs) and S3BlobStore
 * (BLOB_STORE=s3).  Both stage incomplete objects on local disk
 * (DATA_DIR/blobs-staging), where they survive restarts so uploads resume.
 */
export interface BlobStore {
  /**
   * Append `data` at `offset` to the staged (incomplete) object `key`;
   * `offset` must equal the staged size, otherwise BlobOffsetError (whose
   * `expected` tells the uploader where to resume).  Returns the new staged
   * size.  Appends to one key are serialised.
   */
  stageAppend(key: string, offset: number, data: Buffer): Promise<number>;
  /** Staged size (0 when nothing is staged) */
  stagedSize(key: string): Promise<number>;
  /**
   * Stream the staged bytes in order, `chunkSize` at a time (the last chunk
   * may be shorter), for hashing before commit.  Yields nothing when nothing
   * is staged.
   */
  readStaged(key: string, chunkSize: number): AsyncIterable<Buffer>;
  /**
   * Make the staged object durable under `key`, replacing any committed
   * object (fs: fsync + rename; s3: PutObject or multipart upload streamed
   * from the staged file, which is then deleted).  Throws when nothing is
   * staged; on failure the staged object is kept, so commit can be retried.
   */
  commit(key: string): Promise<void>;
  /** Drop a staged object (no-op when nothing is staged) */
  discardStaged(key: string): Promise<void>;
  /**
   * Drop staged objects not appended to for `olderThanMs` (abandoned
   * uploads) and return their keys.
   */
  pruneStaged(olderThanMs: number): Promise<string[]>;
  /**
   * `length` bytes of a committed object from `offset`.  Throws a RangeError
   * when `offset + length` exceeds its size; null when the object is missing.
   */
  readRange(key: string, offset: number, length: number): Promise<Buffer | null>;
  /** Committed object size, or null when missing */
  size(key: string): Promise<number | null>;
  /** Small whole objects (a shard's segment hashes, a blob's shard roots) */
  putObject(key: string, data: Buffer): Promise<void>;
  /** null when missing */
  getObject(key: string): Promise<Buffer | null>;
  /** Delete a committed object (no-op when missing; staged objects stay) */
  delete(key: string): Promise<void>;
  /** Committed keys starting with `prefix` ("" = all), sorted */
  list(prefix: string): Promise<string[]>;
}

/** Nest injection token for the configured BlobStore (BLOB_STORE) */
export const BLOB_STORE = Symbol('BLOB_STORE');

/** stageAppend at an offset other than the staged size */
export class BlobOffsetError extends Error {
  constructor(
    readonly key: string,
    /** The staged size: where the next append must start */
    readonly expected: number,
    readonly offset: number,
  ) {
    super(`Append to "${key}" at offset ${offset}, but ${expected} bytes are staged`);
    this.name = 'BlobOffsetError';
  }
}

// ── Key conventions ──────────────────────────────────────────────────────────

/** A shard's bytes */
export const blobShardKey = (blob: string, index: number) => `${blob}/${index}`;
/** A shard's segment hashes (32 bytes per 1 KiB segment, for proofs) */
export const blobSegmentHashesKey = (blob: string, index: number) => `${blob}/${index}.leaves`;
/** A blob's n shard roots (x-soladb-shard-roots, served by GET /blob/:blob/roots) */
export const blobRootsKey = (blob: string) => `${blob}/roots`;

// ── Validation ───────────────────────────────────────────────────────────────

export const MAX_BLOB_KEY_LENGTH = 512;

/** One key segment; never "." / ".." (no leading dot) nor a trailing dot */
const KEY_SEGMENT = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
/** Device names Windows refuses as file names, with any extension */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Keys map directly to file paths (FsBlobStore) and object names (S3), so
 * only a small alphabet is allowed: no path traversal, absolute paths,
 * backslashes, empty segments or names Windows cannot store.
 */
export function isBlobKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_BLOB_KEY_LENGTH) return false;
  return key.split('/').every((segment) => KEY_SEGMENT.test(segment) && !WINDOWS_DEVICE.test(segment));
}

export function assertBlobKey(key: string): void {
  if (!isBlobKey(key)) throw new Error(`Invalid blob key "${key}"`);
}

/** A list() prefix: "", a key, a key followed by "/", or a key's beginning */
export function assertBlobPrefix(prefix: string): void {
  const valid =
    typeof prefix === 'string' &&
    prefix.length <= MAX_BLOB_KEY_LENGTH &&
    /^[A-Za-z0-9._/-]*$/.test(prefix) &&
    !prefix.startsWith('/') &&
    !prefix.includes('//') &&
    prefix.split('/').every((segment) => segment !== '.' && segment !== '..');
  if (!valid) throw new Error(`Invalid blob key prefix "${prefix}"`);
}

/** offset / length of a range read: non-negative safe integers */
export function assertRange(key: string, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`Invalid range ${offset}+${length} of "${key}"`);
  }
}

export function outOfRange(key: string, offset: number, length: number, size?: number): RangeError {
  const of = size === undefined ? '' : ` (size ${size})`;
  return new RangeError(`Range ${offset}+${length} is outside "${key}"${of}`);
}
