/** Schema tag stored next to every file record */
export const FILE_SCHEMA = 'soladb.file.v2';

const VERSION = 2;
const FLAG_INDEX = 1;
/** Chunks went straight to replicators: no ledger copy to fall back on */
const FLAG_DIRECT = 2;
/** The plaintext was gzip-compressed before encryption */
const FLAG_GZIP = 4;
const MAX_NAME_BYTES = 200;
const MAX_MIME_BYTES = 100;

/**
 * Describes a stored file.  It holds the data-encryption key, so it is only
 * ever stored sealed for each reader (owner and grantees).
 *
 * Binary layout (little endian), kept compact because every byte of a record
 * costs rent and must fit in one transaction:
 *
 *   u8 version | u8 flags (INDEX 1, DIRECT 2, GZIP 4) | u64 size | u32 createdAt | u32 chunkSize
 *   [32] sha256 | [32] dek | u8 nameLen | name | u8 mimeLen | mime
 *   u16 chunkCount | flags & INDEX ? [32] indexHash : chunkCount × [32] chunkHash
 */
export interface FileManifest {
  v: 2;
  name: string;
  mime: string;
  /** Plaintext size in bytes (before compression) */
  size: number;
  /** Bytes per chunk before encryption (after compression) */
  chunkSize: number;
  /** sha256 of the plaintext */
  sha256: Uint8Array;
  /** Data-encryption key (AES-256-GCM) */
  dek: Uint8Array;
  /** Unix seconds */
  createdAt: number;
  /** Number of data chunks */
  chunkCount: number;
  /** sha256 of each encrypted chunk, in order (empty when `index` is set) */
  chunks: Uint8Array[];
  /** sha256 of the encrypted chunk that lists the chunk hashes (large files) */
  index?: Uint8Array;
  /** Chunks were sent straight to replicators (no ledger copy) */
  direct?: boolean;
  /** The plaintext was compressed before encryption */
  compression?: 'gzip';
}

function utf8Truncate(value: string, max: number): Uint8Array {
  let bytes = new TextEncoder().encode(value);
  while (bytes.length > max) {
    value = value.slice(0, -1);
    bytes = new TextEncoder().encode(value);
  }
  return bytes;
}

export function encodeManifest(m: FileManifest): Uint8Array {
  const name = utf8Truncate(m.name, MAX_NAME_BYTES);
  const mime = utf8Truncate(m.mime, MAX_MIME_BYTES);
  const hashes = m.index ? [m.index] : m.chunks;
  const out = new Uint8Array(1 + 1 + 8 + 4 + 4 + 32 + 32 + 1 + name.length + 1 + mime.length + 2 + 32 * hashes.length);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = VERSION;
  out[o++] = (m.index ? FLAG_INDEX : 0) | (m.direct ? FLAG_DIRECT : 0) | (m.compression === 'gzip' ? FLAG_GZIP : 0);
  view.setBigUint64(o, BigInt(m.size), true);
  o += 8;
  view.setUint32(o, m.createdAt, true);
  o += 4;
  view.setUint32(o, m.chunkSize, true);
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
  view.setUint16(o, m.chunkCount, true);
  o += 2;
  for (const h of hashes) {
    if (h.length !== 32) throw new Error('chunk hashes are 32 bytes');
    out.set(h, o);
    o += 32;
  }
  return out;
}

export function decodeManifest(bytes: Uint8Array): FileManifest {
  if (bytes[0] !== VERSION) throw new Error('Unsupported SolaDB file manifest');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 1;
  const flags = bytes[o++];
  const size = Number(view.getBigUint64(o, true));
  o += 8;
  const createdAt = view.getUint32(o, true);
  o += 4;
  const chunkSize = view.getUint32(o, true);
  o += 4;
  const sha256 = bytes.slice(o, o + 32);
  o += 32;
  const dek = bytes.slice(o, o + 32);
  o += 32;
  const nameLength = bytes[o++];
  const name = new TextDecoder().decode(bytes.subarray(o, o + nameLength));
  o += nameLength;
  const mimeLength = bytes[o++];
  const mime = new TextDecoder().decode(bytes.subarray(o, o + mimeLength));
  o += mimeLength;
  const chunkCount = view.getUint16(o, true);
  o += 2;
  const hasIndex = (flags & FLAG_INDEX) !== 0;
  const count = hasIndex ? 1 : chunkCount;
  if (bytes.length !== o + 32 * count) throw new Error('Corrupted SolaDB file manifest');
  const hashes = Array.from({ length: count }, (_, i) => bytes.slice(o + 32 * i, o + 32 * (i + 1)));
  return {
    v: 2,
    name,
    mime,
    size,
    chunkSize,
    sha256,
    dek,
    createdAt,
    chunkCount,
    chunks: hasIndex ? [] : hashes,
    ...(hasIndex ? { index: hashes[0] } : {}),
    ...(flags & FLAG_DIRECT ? { direct: true } : {}),
    ...(flags & FLAG_GZIP ? { compression: 'gzip' as const } : {}),
  };
}

/** Encrypted chunk list used by large files: concatenated 32-byte hashes */
export function encodeIndex(hashes: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(32 * hashes.length);
  hashes.forEach((h, i) => out.set(h, 32 * i));
  return out;
}

export function decodeIndex(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length % 32 !== 0) throw new Error('Corrupted chunk index');
  return Array.from({ length: bytes.length / 32 }, (_, i) => bytes.slice(32 * i, 32 * (i + 1)));
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => HEX[b]).join('');
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error(`Invalid hex: ${hex}`);
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => parseInt(clean.slice(2 * i, 2 * i + 2), 16));
}
