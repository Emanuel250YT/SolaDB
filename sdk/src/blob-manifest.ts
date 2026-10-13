import { SEAL_OVERHEAD } from './crypto';
import { MAX_BLOBS_PER_FILE, MAX_FRAGMENT, MAX_SHARDS, MIN_FRAGMENT, stripeCount } from './blob-layout';

/** Schema tag of records holding a v3 (blob) manifest */
export const BLOB_FILE_SCHEMA = 'soladb.file.v3';

const VERSION = 3;
/** The payload is the gzip-compressed plaintext */
const FLAG_GZIP = 4;
/** The payload is a bundle of files (§6) */
const FLAG_BUNDLE = 8;
const MAX_NAME_BYTES = 200;
const MAX_MIME_BYTES = 100;
/** Sealed manifests must fit in a record */
const MAX_RECORD_CONTENT = 2048;
/** version, flags, size, createdAt, sha256, dek, nameLen, mimeLen, payloadSize, k, m, fragmentSize, blobCount */
const FIXED_BYTES = 1 + 1 + 8 + 4 + 32 + 32 + 1 + 1 + 8 + 1 + 1 + 4 + 2;
const BLOB_BYTES = 32 + 4;

export interface BlobRef {
  /** Blob root R (the Blob account is the PDA ["blob", owner, R]) */
  root: Uint8Array;
  /** Stripes in this blob */
  stripes: number;
}

/**
 * Describes a file stored as erasure-coded blobs.  Holds the DEK, so it is
 * only ever stored sealed for each reader.
 *
 * Binary layout (little endian):
 *
 *   u8 version = 3 | u8 flags (GZIP 4, BUNDLE 8) | u64 size | u32 createdAt
 *   [32] sha256 | [32] dek | u8 nameLen | name | u8 mimeLen | mime
 *   u64 payloadSize | u8 k | u8 m | u32 fragmentSize | u16 blobCount
 *   blobCount × ([32] root | u32 stripes)
 */
export interface BlobManifest {
  v: 3;
  /** File name (bundle: the bundle's name) */
  name: string;
  mime: string;
  /** Plaintext size (bundle: payload size before compression) */
  size: number;
  /** Unix seconds */
  createdAt: number;
  /** sha256 of the plaintext (bundle: of the uncompressed bundle payload) */
  sha256: Uint8Array;
  /** Data-encryption key (AES-256-GCM) */
  dek: Uint8Array;
  /** Bytes after compression, before encryption */
  payloadSize: number;
  k: number;
  m: number;
  fragmentSize: number;
  /** In payload order */
  blobs: BlobRef[];
  /** The payload is gzip-compressed */
  compression?: 'gzip';
  /** The payload is a bundle of files */
  bundle?: true;
}

function utf8Truncate(value: string, max: number): Uint8Array {
  let bytes = new TextEncoder().encode(value);
  while (bytes.length > max) {
    value = value.slice(0, -1);
    bytes = new TextEncoder().encode(value);
  }
  return bytes;
}

function checkFields(m: Pick<BlobManifest, 'k' | 'm' | 'fragmentSize' | 'payloadSize' | 'size' | 'blobs'>): void {
  const fail = (why: string) => {
    throw new Error(`Invalid SolaDB blob manifest: ${why}`);
  };
  if (!Number.isInteger(m.k) || !Number.isInteger(m.m) || m.k < 1 || m.m < 0 || m.k + m.m > MAX_SHARDS) fail(`code ${m.k}+${m.m}`);
  const f = m.fragmentSize;
  if (!Number.isInteger(f) || f < MIN_FRAGMENT || f > MAX_FRAGMENT || (f & (f - 1)) !== 0) fail(`fragment size ${f}`);
  if (!Number.isSafeInteger(m.size) || m.size < 0) fail(`size ${m.size}`);
  if (!Number.isSafeInteger(m.payloadSize) || m.payloadSize < 0) fail(`payload size ${m.payloadSize}`);
  if (m.blobs.length < 1 || m.blobs.length > MAX_BLOBS_PER_FILE) fail(`${m.blobs.length} blobs (1..${MAX_BLOBS_PER_FILE})`);
  let stripes = 0;
  for (const b of m.blobs) {
    if (b.root.length !== 32) fail('blob roots are 32 bytes');
    if (!Number.isInteger(b.stripes) || b.stripes < 1 || b.stripes > 0xffffffff) fail(`${b.stripes} stripes`);
    stripes += b.stripes;
  }
  const expected = stripeCount(m.payloadSize, m.k, f);
  if (stripes !== expected) fail(`${stripes} stripes for a ${m.payloadSize}-byte payload (expected ${expected})`);
}

export function encodeBlobManifest(m: BlobManifest): Uint8Array {
  checkFields(m);
  if (m.sha256.length !== 32 || m.dek.length !== 32) throw new Error('sha256 and dek are 32 bytes');
  const name = utf8Truncate(m.name, MAX_NAME_BYTES);
  const mime = utf8Truncate(m.mime, MAX_MIME_BYTES);
  const out = new Uint8Array(FIXED_BYTES + name.length + mime.length + BLOB_BYTES * m.blobs.length);
  if (out.length + SEAL_OVERHEAD > MAX_RECORD_CONTENT) {
    throw new Error(`The sealed manifest would take ${out.length + SEAL_OVERHEAD} bytes, records hold ${MAX_RECORD_CONTENT}`);
  }
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = VERSION;
  out[o++] = (m.compression === 'gzip' ? FLAG_GZIP : 0) | (m.bundle ? FLAG_BUNDLE : 0);
  view.setBigUint64(o, BigInt(m.size), true);
  o += 8;
  view.setUint32(o, m.createdAt, true);
  o += 4;
  out.set(m.sha256, o);
  o += 32;
  out.set(m.dek, o);
  o += 32;
  out[o++] = name.length;
  out.set(name, o);
  o += name.length;
  out[o++] = mime.length;
  out.set(mime, o);
  o += mime.length;
  view.setBigUint64(o, BigInt(m.payloadSize), true);
  o += 8;
  out[o++] = m.k;
  out[o++] = m.m;
  view.setUint32(o, m.fragmentSize, true);
  o += 4;
  view.setUint16(o, m.blobs.length, true);
  o += 2;
  for (const b of m.blobs) {
    out.set(b.root, o);
    view.setUint32(o + 32, b.stripes, true);
    o += BLOB_BYTES;
  }
  return out;
}

export function decodeBlobManifest(bytes: Uint8Array): BlobManifest {
  if (bytes[0] !== VERSION) throw new Error('Unsupported SolaDB file manifest');
  const corrupted = () => new Error('Corrupted SolaDB blob manifest');
  if (bytes.length < FIXED_BYTES) throw corrupted();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const flags = bytes[o++];
  const size = view.getBigUint64(o, true);
  o += 8;
  const createdAt = view.getUint32(o, true);
  o += 4;
  const sha256 = bytes.slice(o, o + 32);
  o += 32;
  const dek = bytes.slice(o, o + 32);
  o += 32;
  const nameLength = bytes[o++];
  if (nameLength > MAX_NAME_BYTES || o + nameLength + 1 > bytes.length) throw corrupted();
  const name = new TextDecoder().decode(bytes.subarray(o, o + nameLength));
  o += nameLength;
  const mimeLength = bytes[o++];
  if (mimeLength > MAX_MIME_BYTES || o + mimeLength + 16 > bytes.length) throw corrupted();
  const mime = new TextDecoder().decode(bytes.subarray(o, o + mimeLength));
  o += mimeLength;
  const payloadSize = view.getBigUint64(o, true);
  o += 8;
  const k = bytes[o++];
  const m = bytes[o++];
  const fragmentSize = view.getUint32(o, true);
  o += 4;
  const blobCount = view.getUint16(o, true);
  o += 2;
  if (blobCount > MAX_BLOBS_PER_FILE || bytes.length !== o + BLOB_BYTES * blobCount) throw corrupted();
  if (size > BigInt(Number.MAX_SAFE_INTEGER) || payloadSize > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupted();
  const blobs = Array.from({ length: blobCount }, (_, i) => ({
    root: bytes.slice(o + BLOB_BYTES * i, o + BLOB_BYTES * i + 32),
    stripes: view.getUint32(o + BLOB_BYTES * i + 32, true),
  }));
  const manifest: BlobManifest = {
    v: 3,
    name,
    mime,
    size: Number(size),
    createdAt,
    sha256,
    dek,
    payloadSize: Number(payloadSize),
    k,
    m,
    fragmentSize,
    blobs,
    ...(flags & FLAG_GZIP ? { compression: 'gzip' as const } : {}),
    ...(flags & FLAG_BUNDLE ? { bundle: true as const } : {}),
  };
  checkFields(manifest);
  return manifest;
}

/** True when `bytes` (a decrypted record) starts with the v3 version byte */
export function isBlobManifest(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === VERSION;
}
