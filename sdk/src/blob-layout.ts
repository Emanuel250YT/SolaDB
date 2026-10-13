import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { decryptBytes, encryptBytes, ENCRYPTION_OVERHEAD, sha256 } from './crypto';
import { encodeParity, rebuildFragments } from './erasure';
import { blobRoot, SEGMENT_SIZE, ShardHasher, shardRoot } from './merkle';

/**
 * Payload → stripes → fragments → shards (docs/blob-protocol.md §3) and
 * bundles (§6).  Pure functions: no RPC, no HTTP.
 *
 * A stripe holds `C = k·F − 28` payload bytes, encrypted with the file's DEK
 * (AES-256-GCM, `encryptBytes` layout) and right-padded with zeros to `k·F`
 * bytes, then split into `k` data fragments of `F` bytes plus `m` parity
 * fragments.  Shard `j` is fragment `j` of every stripe, in order.
 */

/** n = k + m ≤ 32 */
export const MAX_SHARDS = 32;
/** Smallest fragment (one Merkle segment) */
export const MIN_FRAGMENT = SEGMENT_SIZE;
/** Largest fragment */
export const MAX_FRAGMENT = 1024 * 1024;
/** Stripes per blob: with 1 MiB fragments, shards ≤ 1 GiB */
export const MAX_STRIPES_PER_BLOB = 1024;
/** A v3 manifest lists at most this many blobs (records ≤ 2048 bytes) */
export const MAX_BLOBS_PER_FILE = 48;

/** How a payload is erasure coded */
export interface BlobLayout {
  /** Data fragments per stripe */
  k: number;
  /** Parity fragments per stripe */
  m: number;
  /** Fragment size F: a power of two between 1 KiB and 1 MiB */
  fragmentSize: number;
  /** Stripes per blob at most (larger payloads are split over several blobs) */
  stripesPerBlob: number;
}

export type ErasureCode = Pick<BlobLayout, 'k' | 'm' | 'fragmentSize'>;

const isPowerOfTwo = (x: number) => Number.isInteger(x) && x > 0 && (x & (x - 1)) === 0;

function checkCode(k: number, m: number, fragmentSize: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > MAX_SHARDS) {
    throw new Error(`Invalid erasure code ${k}+${m} (k ≥ 1, m ≥ 0, k + m ≤ ${MAX_SHARDS})`);
  }
  if (!isPowerOfTwo(fragmentSize) || fragmentSize < MIN_FRAGMENT || fragmentSize > MAX_FRAGMENT) {
    throw new Error(`Fragment size must be a power of two between ${MIN_FRAGMENT} and ${MAX_FRAGMENT} (got ${fragmentSize})`);
  }
}

/** Throws unless the layout is valid */
export function checkLayout(layout: BlobLayout): void {
  checkCode(layout.k, layout.m, layout.fragmentSize);
  const s = layout.stripesPerBlob;
  if (!Number.isInteger(s) || s < 1 || s > MAX_STRIPES_PER_BLOB) {
    throw new Error(`stripesPerBlob must be between 1 and ${MAX_STRIPES_PER_BLOB} (got ${s})`);
  }
}

function checkSize(payloadSize: number): void {
  if (!Number.isSafeInteger(payloadSize) || payloadSize < 0) throw new Error(`Invalid payload size ${payloadSize}`);
}

// ---------------------------------------------------------------------------
// Layout choice

/** Default codes by available nodes: [minimum nodes, k, m] */
const DEFAULT_CODES: readonly [number, number, number][] = [
  [14, 10, 4],
  [9, 6, 3],
  [6, 4, 2],
  [3, 2, 1],
  [2, 1, 1],
  [1, 1, 0],
];

export interface LayoutOptions {
  /** Bytes to store (after compression, before encryption) */
  payloadSize: number;
  /** Replicator nodes available (each shard needs its own node) */
  nodes: number;
  /**
   * Parity shards wanted (= node losses tolerated).  Without an explicit `k`,
   * `k = min(10, nodes − redundancy)`.
   */
  redundancy?: number;
  /** Overrides */
  k?: number;
  m?: number;
  fragmentSize?: number;
  stripesPerBlob?: number;
}

export interface ChosenLayout extends BlobLayout {
  /** Stripes of the whole payload */
  stripes: number;
  /** Blobs the payload is split into */
  blobCount: number;
  /** Shard size of the first (largest) blob */
  shardSize: number;
  /** Bytes stored over all shards of all blobs: n · F · stripes */
  storedBytes: number;
}

/**
 * The largest power-of-two fragment (1 KiB … 1 MiB) whose padding wastes at
 * most ~5 % over the ideal `payload · n / k` stored bytes.  Larger fragments
 * mean fewer stripes (fewer requests, shallower proofs); smaller ones pad
 * less.  A 300 KB payload on 2+1 gets 8 KiB fragments (1.04× the ideal)
 * instead of one 256 KiB stripe (1.75×).
 */
function leastWastefulFragment(payloadSize: number, k: number, m: number): number {
  const n = k + m;
  const stored = (f: number) => n * f * stripeCount(payloadSize, k, f);
  const ideal = (payloadSize * n) / k;
  let best = MIN_FRAGMENT;
  for (let f = MIN_FRAGMENT; f <= MAX_FRAGMENT; f *= 2) {
    if (stored(f) < stored(best)) best = f;
  }
  const limit = Math.max(stored(best), ideal * 1.05);
  for (let f = MAX_FRAGMENT; f >= MIN_FRAGMENT; f /= 2) {
    if (stored(f) <= limit) return f;
  }
  return best;
}

/**
 * Sensible defaults: the code by node count (≥ 14 → 10+4, ≥ 9 → 6+3, ≥ 6 →
 * 4+2, ≥ 3 → 2+1, 2 → 1+1, 1 → 1+0); the largest power-of-two fragment
 * (≥ 1 KiB, ≤ 1 MiB) that pads at most ~5 % (`leastWastefulFragment`); and,
 * when the payload needs several blobs, stripes spread evenly over the
 * fewest blobs of ≤ 1024 stripes.
 */
export function chooseLayout(options: LayoutOptions): ChosenLayout {
  const { payloadSize, nodes, redundancy } = options;
  checkSize(payloadSize);
  if (!Number.isInteger(nodes) || nodes < 1) throw new Error('At least one replicator node is needed');
  let k: number;
  let m: number;
  if (redundancy !== undefined) {
    if (!Number.isInteger(redundancy) || redundancy < 0) throw new Error(`Invalid redundancy ${redundancy}`);
    m = options.m ?? redundancy;
    k = options.k ?? Math.min(10, nodes - m);
    if (k < 1) throw new Error(`${nodes} node(s) cannot hold ${m} parity shard(s) plus data`);
  } else {
    const [, dk, dm] = DEFAULT_CODES.find(([min]) => nodes >= min)!;
    k = options.k ?? dk;
    m = options.m ?? dm;
  }

  let fragmentSize = options.fragmentSize ?? MIN_FRAGMENT;
  if (options.fragmentSize === undefined) {
    checkCode(k, m, fragmentSize);
    fragmentSize = leastWastefulFragment(payloadSize, k, m);
  }
  checkCode(k, m, fragmentSize);

  const stripes = stripeCount(payloadSize, k, fragmentSize);
  const stripesPerBlob = options.stripesPerBlob ?? Math.ceil(stripes / Math.ceil(stripes / MAX_STRIPES_PER_BLOB));
  const layout = { k, m, fragmentSize, stripesPerBlob };
  checkLayout(layout);
  const blobCount = Math.ceil(stripes / stripesPerBlob);
  if (blobCount > MAX_BLOBS_PER_FILE) {
    throw new Error(`The payload needs ${blobCount} blobs, a file holds at most ${MAX_BLOBS_PER_FILE}`);
  }
  return {
    ...layout,
    stripes,
    blobCount,
    shardSize: Math.min(stripes, stripesPerBlob) * fragmentSize,
    storedBytes: (k + m) * fragmentSize * stripes,
  };
}

// ---------------------------------------------------------------------------
// Stripes

/** Payload bytes per stripe: `k·F − 28` */
export function stripeCapacity(k: number, fragmentSize: number): number {
  checkCode(k, 0, fragmentSize);
  return k * fragmentSize - ENCRYPTION_OVERHEAD;
}

/** Stripes of a payload (an empty payload is one empty stripe) */
export function stripeCount(payloadSize: number, k: number, fragmentSize: number): number {
  checkSize(payloadSize);
  return payloadSize === 0 ? 1 : Math.ceil(payloadSize / stripeCapacity(k, fragmentSize));
}

/** Plaintext length of every stripe: `C` each, the last one shorter (≥ 1 byte, or 0 for an empty payload) */
export function stripePlainLengths(payloadSize: number, k: number, fragmentSize: number): number[] {
  const capacity = stripeCapacity(k, fragmentSize);
  const count = stripeCount(payloadSize, k, fragmentSize);
  return Array.from({ length: count }, (_, s) => Math.min(capacity, payloadSize - s * capacity));
}

export interface EncryptStripeOptions {
  /**
   * 12-byte nonce instead of a random one.  Never encrypt two different
   * plaintexts under the same DEK and nonce: use `syntheticNonce`.
   */
  nonce?: Uint8Array;
}

/** `encryptBytes(dek, plain)` right-padded with zeros to exactly `k·F` bytes */
export function encryptStripe(
  dek: Uint8Array,
  plain: Uint8Array,
  k: number,
  fragmentSize: number,
  options: EncryptStripeOptions = {},
): Uint8Array {
  const capacity = stripeCapacity(k, fragmentSize);
  if (plain.length > capacity) throw new Error(`A stripe holds at most ${capacity} bytes (got ${plain.length})`);
  let cipher: Uint8Array;
  if (options.nonce) {
    if (options.nonce.length !== 12) throw new Error('AES-GCM nonces are 12 bytes');
    cipher = concatBytes(options.nonce, gcm(dek, options.nonce).encrypt(plain));
  } else {
    cipher = encryptBytes(dek, plain);
  }
  const out = new Uint8Array(k * fragmentSize);
  out.set(cipher);
  return out;
}

/** Inverse of `encryptStripe` (the padding after `plainLength + 28` bytes is ignored) */
export function decryptStripe(dek: Uint8Array, cipherPadded: Uint8Array, plainLength: number): Uint8Array {
  const length = plainLength + ENCRYPTION_OVERHEAD;
  if (!Number.isInteger(plainLength) || plainLength < 0 || length > cipherPadded.length) {
    throw new Error(`Stripe of ${cipherPadded.length} bytes cannot hold ${plainLength} plaintext bytes`);
  }
  return decryptBytes(dek, cipherPadded.subarray(0, length));
}

/** The `k` data fragments of a padded stripe ciphertext (views, no copy) */
export function splitStripe(cipher: Uint8Array, k: number, fragmentSize: number): Uint8Array[] {
  if (cipher.length !== k * fragmentSize) throw new Error(`A stripe is ${k * fragmentSize} bytes (got ${cipher.length})`);
  return Array.from({ length: k }, (_, j) => cipher.subarray(j * fragmentSize, (j + 1) * fragmentSize));
}

const NONCE_INFO = utf8ToBytes('soladb/blob-nonce/v1');

/** Key for `syntheticNonce`, derived from the DEK */
export function nonceKey(dek: Uint8Array): Uint8Array {
  return hkdf(sha256, dek, undefined, NONCE_INFO, 32);
}

/**
 * Deterministic nonce: `HMAC-SHA256(HKDF(dek, "soladb/blob-nonce/v1"),
 * u32 blob ‖ u32 stripe ‖ plain)[0..12]`.  Encrypting the same file twice
 * then yields the same shards (so a client can compute the roots in a first
 * pass and upload in a second without keeping the shards), while different
 * plaintexts still get different nonces.  Readers need nothing: the nonce is
 * stored in the stripe like a random one.
 */
export function syntheticNonce(key: Uint8Array, blobIndex: number, stripe: number, plain: Uint8Array): Uint8Array {
  const position = new Uint8Array(8);
  const view = new DataView(position.buffer);
  view.setUint32(0, blobIndex, true);
  view.setUint32(4, stripe, true);
  return hmac.create(sha256, key).update(position).update(plain).digest().slice(0, 12);
}

// ---------------------------------------------------------------------------
// Blobs

export interface BlobPlan {
  /** Blob index within the file */
  index: number;
  /** Payload range of the blob */
  offset: number;
  length: number;
  stripes: number;
  /** stripes · F */
  shardSize: number;
}

/** How the payload is consumed, blob after blob */
export function planBlobs(payloadSize: number, layout: BlobLayout): BlobPlan[] {
  checkLayout(layout);
  const { k, fragmentSize, stripesPerBlob } = layout;
  const capacity = stripeCapacity(k, fragmentSize);
  const total = stripeCount(payloadSize, k, fragmentSize);
  const plans: BlobPlan[] = [];
  for (let first = 0; first < total; first += stripesPerBlob) {
    const stripes = Math.min(stripesPerBlob, total - first);
    const offset = first * capacity;
    plans.push({
      index: plans.length,
      offset,
      length: Math.min(stripes * capacity, payloadSize - offset),
      stripes,
      shardSize: stripes * fragmentSize,
    });
  }
  return plans;
}

export interface EncodedStripe {
  /** Stripe index within the blob */
  stripe: number;
  /** Payload bytes in this stripe */
  plainLength: number;
  /** `n` fragments of `F` bytes: data `0..k-1`, parity `k..n-1` */
  fragments: Uint8Array[];
}

export interface BlobEncoderOptions {
  /** Keep each shard's leaf hashes (32 bytes per KiB of shard) for `leafHashes(j)`; default false */
  keepLeafHashes?: boolean;
  /** 'random' (default) or 'synthetic' (deterministic, see `syntheticNonce`) */
  nonces?: 'random' | 'synthetic';
  /** Index of this blob in the file, mixed into synthetic nonces; default 0 */
  blobIndex?: number;
}

/**
 * Encodes one blob from payload bytes pushed in pieces of any size, stripe by
 * stripe, hashing every shard on the way.  `push` and `finish` return the
 * stripes completed by that call; `encode` wraps them in an async iterator.
 * At most `stripesPerBlob · C` bytes fit (see `planBlobs` for larger payloads).
 */
export class BlobEncoder {
  readonly k: number;
  readonly m: number;
  readonly fragmentSize: number;
  readonly stripesPerBlob: number;
  private readonly capacity: number;
  private readonly hashers: ShardHasher[];
  private readonly buffer: Uint8Array;
  private filled = 0;
  private count = 0;
  private consumed = 0;
  private done = false;
  private roots: Uint8Array[] | null = null;
  private readonly key: Uint8Array | null;
  private readonly blobIndex: number;

  constructor(layout: Partial<Pick<BlobLayout, 'stripesPerBlob'>> & ErasureCode, private readonly dek: Uint8Array, options: BlobEncoderOptions = {}) {
    const full = { ...layout, stripesPerBlob: layout.stripesPerBlob ?? MAX_STRIPES_PER_BLOB };
    checkLayout(full);
    if (dek.length !== 32) throw new Error('The DEK is 32 bytes');
    this.k = full.k;
    this.m = full.m;
    this.fragmentSize = full.fragmentSize;
    this.stripesPerBlob = full.stripesPerBlob;
    this.capacity = stripeCapacity(this.k, this.fragmentSize);
    this.buffer = new Uint8Array(this.capacity);
    this.hashers = Array.from({ length: this.k + this.m }, () => new ShardHasher({ keepLeafHashes: options.keepLeafHashes ?? false }));
    this.key = options.nonces === 'synthetic' ? nonceKey(dek) : null;
    this.blobIndex = options.blobIndex ?? 0;
  }

  /** Total shards n */
  get n(): number {
    return this.k + this.m;
  }

  /** Payload bytes consumed so far */
  get payloadLength(): number {
    return this.consumed;
  }

  push(bytes: Uint8Array): EncodedStripe[] {
    if (this.done) throw new Error('BlobEncoder already finished');
    const out: EncodedStripe[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.filled === this.capacity) {
        // more bytes follow a full stripe: it cannot be the blob's last one
        if (this.count + 1 >= this.stripesPerBlob) {
          throw new Error(`The payload exceeds the blob capacity (${this.stripesPerBlob} stripes)`);
        }
        out.push(this.encodeStripe(this.buffer));
        this.filled = 0;
      }
      const take = Math.min(this.capacity - this.filled, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
    }
    this.consumed += bytes.length;
    return out;
  }

  /** Encodes the last stripe (or the single empty stripe of an empty payload) */
  finish(): EncodedStripe[] {
    if (this.done) throw new Error('BlobEncoder already finished');
    const out: EncodedStripe[] = [];
    if (this.filled > 0 || this.count === 0) out.push(this.encodeStripe(this.buffer.subarray(0, this.filled)));
    this.filled = 0;
    this.done = true;
    this.roots = this.hashers.map((h) => h.root());
    return out;
  }

  /** Feeds `source` and yields every stripe, at most one stripe of payload buffered */
  async *encode(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<EncodedStripe> {
    for await (const piece of source) {
      for (let offset = 0; offset < piece.length; offset += this.capacity) {
        yield* this.push(piece.subarray(offset, offset + this.capacity));
      }
    }
    yield* this.finish();
  }

  private encodeStripe(plain: Uint8Array): EncodedStripe {
    if (this.count >= this.stripesPerBlob) {
      throw new Error(`The payload exceeds the blob capacity (${this.stripesPerBlob} stripes)`);
    }
    const nonce = this.key ? syntheticNonce(this.key, this.blobIndex, this.count, plain) : undefined;
    const cipher = encryptStripe(this.dek, plain, this.k, this.fragmentSize, { nonce });
    const data = splitStripe(cipher, this.k, this.fragmentSize);
    const fragments = [...data, ...encodeParity(data, this.m)];
    fragments.forEach((f, j) => this.hashers[j].update(f));
    return { stripe: this.count++, plainLength: plain.length, fragments };
  }

  private finished(): Uint8Array[] {
    if (!this.roots) throw new Error('BlobEncoder not finished yet');
    return this.roots;
  }

  /** `r_0 … r_{n-1}` */
  get shardRoots(): Uint8Array[] {
    return this.finished().map((r) => r.slice());
  }

  /** Blob root R */
  get root(): Uint8Array {
    return blobRoot(this.finished());
  }

  /** Stripes in the blob */
  get stripes(): number {
    this.finished();
    return this.count;
  }

  /** stripes · F */
  get shardSize(): number {
    return this.stripes * this.fragmentSize;
  }

  /** Packed leaf hashes of shard `j` (needs `keepLeafHashes`) */
  leafHashes(j: number): Uint8Array {
    this.finished();
    return this.hashers[j].leafHashes();
  }
}

export interface EncodedBlob {
  index: number;
  root: Uint8Array;
  shardRoots: Uint8Array[];
  stripes: number;
  shardSize: number;
  /** `n` shards of `shardSize` bytes */
  shards: Uint8Array[];
  /** Payload range held by the blob */
  payloadOffset: number;
  payloadLength: number;
}

/** Whole payload → blobs, in memory */
export function encodeBlobs(
  payload: Uint8Array,
  layout: BlobLayout,
  dek: Uint8Array,
  options: Pick<BlobEncoderOptions, 'nonces'> = {},
): EncodedBlob[] {
  return planBlobs(payload.length, layout).map((plan) => {
    const encoder = new BlobEncoder(layout, dek, { nonces: options.nonces, blobIndex: plan.index });
    const shards = Array.from({ length: encoder.n }, () => new Uint8Array(plan.shardSize));
    const place = (stripes: EncodedStripe[]) => {
      for (const s of stripes) s.fragments.forEach((f, j) => shards[j].set(f, s.stripe * layout.fragmentSize));
    };
    place(encoder.push(payload.subarray(plan.offset, plan.offset + plan.length)));
    place(encoder.finish());
    if (encoder.stripes !== plan.stripes) throw new Error('Stripe count mismatch');
    return {
      index: plan.index,
      root: encoder.root,
      shardRoots: encoder.shardRoots,
      stripes: encoder.stripes,
      shardSize: encoder.shardSize,
      shards,
      payloadOffset: plan.offset,
      payloadLength: plan.length,
    };
  });
}

/**
 * Plaintext of one stripe from its `n` fragments (`null` = missing).  Only the
 * data fragments that hold ciphertext are used; missing ones are rebuilt from
 * any `k` present fragments.
 */
export function decodeStripe(
  fragments: readonly (Uint8Array | null | undefined)[],
  k: number,
  m: number,
  fragmentSize: number,
  dek: Uint8Array,
  plainLength: number,
): Uint8Array {
  checkCode(k, m, fragmentSize);
  if (fragments.length !== k + m) throw new Error(`Expected ${k + m} fragment slots, got ${fragments.length}`);
  for (const f of fragments) {
    if (f && f.length !== fragmentSize) throw new Error(`Fragments are ${fragmentSize} bytes (got ${f.length})`);
  }
  const length = plainLength + ENCRYPTION_OVERHEAD;
  if (!Number.isInteger(plainLength) || plainLength < 0 || length > k * fragmentSize) {
    throw new Error(`Invalid stripe plaintext length ${plainLength}`);
  }
  const needed = Array.from({ length: Math.ceil(length / fragmentSize) }, (_, j) => j);
  const data = needed.every((j) => fragments[j]) ? needed.map((j) => fragments[j]!) : rebuildFragments(fragments, k, m, needed);
  const cipher = new Uint8Array(length);
  data.forEach((f, j) => cipher.set(f.subarray(0, Math.min(fragmentSize, length - j * fragmentSize)), j * fragmentSize));
  return decryptBytes(dek, cipher);
}

export interface StoredBlob {
  /** `n` shards; `null` = missing */
  shards: readonly (Uint8Array | null | undefined)[];
  /** When given, shards with another root are treated as missing */
  shardRoots?: readonly Uint8Array[];
  /** When given with `shardRoots`, the roots must hash to it */
  root?: Uint8Array;
}

/** Blobs (in payload order) → payload, in memory */
export function decodeBlobs(blobs: readonly StoredBlob[], code: ErasureCode, dek: Uint8Array, payloadSize: number): Uint8Array {
  const { k, m, fragmentSize } = code;
  checkCode(k, m, fragmentSize);
  const lengths = stripePlainLengths(payloadSize, k, fragmentSize);
  const payload = new Uint8Array(payloadSize);
  let global = 0;
  let offset = 0;
  for (const [b, blob] of blobs.entries()) {
    if (blob.shards.length !== k + m) throw new Error(`Blob ${b}: expected ${k + m} shards`);
    if (blob.shardRoots && blob.shardRoots.length !== k + m) throw new Error(`Blob ${b}: expected ${k + m} shard roots`);
    if (blob.root && blob.shardRoots && !equal(blobRoot(blob.shardRoots), blob.root)) {
      throw new Error(`Blob ${b}: shard roots do not match the blob root`);
    }
    const shards = blob.shards.map((s, j) => (s && (!blob.shardRoots || equal(shardRoot(s), blob.shardRoots[j])) ? s : null));
    const present = shards.filter((s): s is Uint8Array => s !== null);
    if (present.length < k) throw new Error(`Blob ${b}: only ${present.length} valid shards, ${k} needed`);
    const shardSize = present[0].length;
    if (shardSize === 0 || shardSize % fragmentSize !== 0 || present.some((s) => s.length !== shardSize)) {
      throw new Error(`Blob ${b}: shards must all be the same whole number of fragments`);
    }
    for (let s = 0; s < shardSize / fragmentSize; s++, global++) {
      if (global >= lengths.length) throw new Error('More stripes than the payload size allows');
      const fragments = shards.map((shard) => (shard ? shard.subarray(s * fragmentSize, (s + 1) * fragmentSize) : null));
      const plain = decodeStripe(fragments, k, m, fragmentSize, dek, lengths[global]);
      payload.set(plain, offset);
      offset += plain.length;
    }
  }
  if (global !== lengths.length) throw new Error(`Expected ${lengths.length} stripes, got ${global}`);
  return payload;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// Bundles (§6): u32 entryCount | entries | file bytes…
// entry: u8 nameLen, name | u8 mimeLen, mime | u64 offset | u64 length | [32] sha256

export interface BundleFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface BundleIndexEntry {
  name: string;
  mime: string;
  /** Relative to the start of the file bytes */
  offset: number;
  length: number;
  sha256: Uint8Array;
}

export interface BundleEntry extends BundleIndexEntry {
  /** View into the payload */
  data: Uint8Array;
}

const MAX_BUNDLE_NAME_BYTES = 255;
const MAX_BUNDLE_MIME_BYTES = 255;

function utf8Truncate(value: string, max: number): Uint8Array {
  let bytes = new TextEncoder().encode(value);
  while (bytes.length > max) {
    value = value.slice(0, -1);
    bytes = new TextEncoder().encode(value);
  }
  return bytes;
}

/** Many small files → one payload (names and MIME types truncated to 255 UTF-8 bytes) */
export function encodeBundle(files: readonly BundleFile[]): Uint8Array {
  const entries = files.map((f) => ({
    name: utf8Truncate(f.name, MAX_BUNDLE_NAME_BYTES),
    mime: utf8Truncate(f.mime, MAX_BUNDLE_MIME_BYTES),
    data: f.data,
  }));
  const header = 4 + entries.reduce((sum, e) => sum + 1 + e.name.length + 1 + e.mime.length + 8 + 8 + 32, 0);
  const body = entries.reduce((sum, e) => sum + e.data.length, 0);
  const out = new Uint8Array(header + body);
  const view = new DataView(out.buffer);
  view.setUint32(0, entries.length, true);
  let o = 4;
  let data = 0;
  for (const e of entries) {
    out[o++] = e.name.length;
    out.set(e.name, o);
    o += e.name.length;
    out[o++] = e.mime.length;
    out.set(e.mime, o);
    o += e.mime.length;
    view.setBigUint64(o, BigInt(data), true);
    view.setBigUint64(o + 8, BigInt(e.data.length), true);
    out.set(sha256(e.data), o + 16);
    o += 48;
    out.set(e.data, header + data);
    data += e.data.length;
  }
  return out;
}

/** The entries of a bundle and where its file bytes start (no hashing) */
export function readBundleIndex(payload: Uint8Array): { entries: BundleIndexEntry[]; dataOffset: number } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fail = () => {
    throw new Error('Corrupted SolaDB bundle');
  };
  if (payload.length < 4) fail();
  const count = view.getUint32(0, true);
  // every entry takes at least 50 bytes
  if (count > (payload.length - 4) / 50) fail();
  const decoder = new TextDecoder();
  const entries: BundleIndexEntry[] = [];
  let o = 4;
  const need = (n: number) => {
    if (o + n > payload.length) fail();
  };
  for (let i = 0; i < count; i++) {
    need(1);
    const nameLength = payload[o++];
    need(nameLength + 1);
    const name = decoder.decode(payload.subarray(o, o + nameLength));
    o += nameLength;
    const mimeLength = payload[o++];
    need(mimeLength + 48);
    const mime = decoder.decode(payload.subarray(o, o + mimeLength));
    o += mimeLength;
    const offset = view.getBigUint64(o, true);
    const length = view.getBigUint64(o + 8, true);
    if (offset > BigInt(Number.MAX_SAFE_INTEGER) || length > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    entries.push({ name, mime, offset: Number(offset), length: Number(length), sha256: payload.slice(o + 16, o + 48) });
    o += 48;
  }
  const available = payload.length - o;
  if (entries.some((e) => e.offset + e.length > available)) fail();
  return { entries, dataOffset: o };
}

/** Bundle payload → files (views into `payload`), each checked against its sha256 */
export function decodeBundle(payload: Uint8Array): BundleEntry[] {
  const { entries, dataOffset } = readBundleIndex(payload);
  return entries.map((e) => {
    const data = payload.subarray(dataOffset + e.offset, dataOffset + e.offset + e.length);
    if (!equal(sha256(data), e.sha256)) throw new Error(`Bundle entry "${e.name}" does not match its sha256`);
    return { ...e, data };
  });
}
