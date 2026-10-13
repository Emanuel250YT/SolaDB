import { sha256 } from '@noble/hashes/sha256';

/**
 * Merkle trees of the blob format (docs/blob-protocol.md §2).
 *
 *   leafHash(segment) = sha256(0x00 ‖ segment)        segment = 1024 bytes
 *   nodeHash(l, r)    = sha256(0x01 ‖ l ‖ r)
 *
 * A tree over `N` nodes is padded once, at the input level, with `EMPTY` up to
 * the next power of two, so a subtree made only of padding at height `h`
 * hashes to `Z_h` (`Z_0 = EMPTY`, `Z_{h+1} = nodeHash(Z_h, Z_h)`) and is never
 * materialised.
 *
 * Large lists of hashes (a 1 GiB shard has 2^20 leaves) are kept *packed*: one
 * `Uint8Array` of `32 · count` bytes.  Functions that take "nodes" accept
 * either a packed array or an array of 32-byte hashes.
 */

/** Bytes per Merkle leaf (and per storage-proof answer) */
export const SEGMENT_SIZE = 1024;
/** Bytes per hash */
export const HASH_SIZE = 32;
/** Padding node: 32 zero bytes (do not mutate) */
export const EMPTY: Uint8Array = new Uint8Array(HASH_SIZE);

/** A packed list (`32 · count` bytes) or an array of 32-byte hashes */
export type Nodes = Uint8Array | readonly Uint8Array[];

const LEAF_PREFIX = Uint8Array.of(0);
const NODE_PREFIX = Uint8Array.of(1);

function leafInto(segment: Uint8Array, out: Uint8Array, at: number): void {
  sha256.create().update(LEAF_PREFIX).update(segment).digestInto(out.subarray(at, at + HASH_SIZE));
}

/** sha256(0x01 ‖ pair) where `pair` is two adjacent hashes (64 bytes) */
function pairInto(pair: Uint8Array, out: Uint8Array, at: number): void {
  sha256.create().update(NODE_PREFIX).update(pair).digestInto(out.subarray(at, at + HASH_SIZE));
}

function twoInto(left: Uint8Array, right: Uint8Array, out: Uint8Array, at: number): void {
  sha256.create().update(NODE_PREFIX).update(left).update(right).digestInto(out.subarray(at, at + HASH_SIZE));
}

function assertHash(h: Uint8Array, what = 'hash'): void {
  if (!(h instanceof Uint8Array) || h.length !== HASH_SIZE) throw new Error(`${what} must be 32 bytes`);
}

function assertIndex(index: number, count: number, what = 'index'): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`${what} ${index} out of range (0..${count - 1})`);
  }
}

/** Hash of one 1024-byte segment */
export function leafHash(segment: Uint8Array): Uint8Array {
  if (segment.length !== SEGMENT_SIZE) throw new Error(`Merkle segments are exactly ${SEGMENT_SIZE} bytes`);
  const out = new Uint8Array(HASH_SIZE);
  leafInto(segment, out, 0);
  return out;
}

/** Parent of two nodes */
export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  assertHash(left, 'left node');
  assertHash(right, 'right node');
  const out = new Uint8Array(HASH_SIZE);
  twoInto(left, right, out, 0);
  return out;
}

const ZEROS: Uint8Array[] = [EMPTY];

/** `Z_h`: root of a subtree of height `h` made only of padding (memoised) */
export function zeroHash(height: number): Uint8Array {
  if (!Number.isInteger(height) || height < 0 || height > 64) throw new Error(`Invalid tree height ${height}`);
  while (ZEROS.length <= height) {
    const below = ZEROS[ZEROS.length - 1];
    ZEROS.push(nodeHash(below, below));
  }
  return ZEROS[height];
}

/** `ceil(log2(n))`, 0 for n = 1: proof length of a tree with `n` input nodes */
export function depth(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`A Merkle tree needs at least one node (got ${n})`);
  let d = 0;
  for (let p = 1; p < n; p *= 2) d++;
  return d;
}

/** Concatenate 32-byte hashes into one packed array */
export function packHashes(nodes: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nodes.length * HASH_SIZE);
  nodes.forEach((h, i) => {
    assertHash(h, `node ${i}`);
    out.set(h, i * HASH_SIZE);
  });
  return out;
}

/** Split a packed array into 32-byte hashes (copies) */
export function unpackHashes(packed: Uint8Array): Uint8Array[] {
  if (packed.length % HASH_SIZE !== 0) throw new Error('Packed hashes must be a multiple of 32 bytes');
  return Array.from({ length: packed.length / HASH_SIZE }, (_, i) => packed.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE));
}

function toPacked(nodes: Nodes): Uint8Array {
  const packed = nodes instanceof Uint8Array ? nodes : packHashes(nodes);
  if (packed.length === 0) throw new Error('A Merkle tree needs at least one node');
  if (packed.length % HASH_SIZE !== 0) throw new Error('Packed hashes must be a multiple of 32 bytes');
  return packed;
}

/**
 * One level up: parents of the `count` nodes in `src` (at tree height
 * `height`) are written to `dst`, which may be `src` itself (parent `i` is
 * written after children `2i`, `2i+1` have been read).  Returns the new count.
 */
function reduceLevel(src: Uint8Array, count: number, dst: Uint8Array, height: number): number {
  const full = Math.floor(count / 2);
  for (let i = 0; i < full; i++) pairInto(src.subarray(64 * i, 64 * i + 64), dst, 32 * i);
  if (count % 2 === 1) twoInto(src.subarray(64 * full, 64 * full + 32), zeroHash(height), dst, 32 * full);
  return Math.ceil(count / 2);
}

/** Root of packed nodes sitting at tree height `height` (padding with `Z_height`) */
function rootOfPacked(packed: Uint8Array, height = 0): Uint8Array {
  let count = packed.length / HASH_SIZE;
  if (count === 1) return packed.slice(0, HASH_SIZE);
  // first level into a scratch buffer, then in place
  const scratch = new Uint8Array(Math.ceil(count / 2) * HASH_SIZE);
  count = reduceLevel(packed, count, scratch, height++);
  while (count > 1) count = reduceLevel(scratch, count, scratch, height++);
  return scratch.slice(0, HASH_SIZE);
}

/**
 * Root of the subtree of height `height` whose leftmost input node is
 * `start` (nodes past the end of `packed` are padding).
 */
function subtreeRoot(packed: Uint8Array, start: number, height: number, baseHeight: number): Uint8Array {
  const total = packed.length / HASH_SIZE;
  if (start >= total) return zeroHash(baseHeight + height);
  const count = Math.min(2 ** height, total - start);
  let root = rootOfPacked(packed.subarray(start * HASH_SIZE, (start + count) * HASH_SIZE), baseHeight);
  for (let h = depth(count); h < height; h++) root = nodeHash(root, zeroHash(baseHeight + h));
  return root;
}

/**
 * Siblings of node `index` at height `height` (relative to the input level)
 * up to the root of the padded tree over `packed`, computed without storing
 * the tree: O(N) hashing, O(N/2) scratch memory.
 */
function pathOfPacked(packed: Uint8Array, index: number, height: number, baseHeight = 0): Uint8Array[] {
  const d = depth(packed.length / HASH_SIZE);
  const proof: Uint8Array[] = [];
  for (let h = height; h < d; h++) {
    const sibling = Math.floor(index / 2 ** (h - height)) ^ 1;
    proof.push(subtreeRoot(packed, sibling * 2 ** h, h, baseHeight));
  }
  return proof;
}

/** Root of `nodes` padded with EMPTY to the next power of two */
export function rootOfNodes(nodes: Nodes): Uint8Array {
  return rootOfPacked(toPacked(nodes));
}

/** Siblings of node `index`, bottom-up (`depth(N)` hashes, padding included) */
export function proofOfNodes(nodes: Nodes, index: number): Uint8Array[] {
  const packed = toPacked(nodes);
  assertIndex(index, packed.length / HASH_SIZE);
  return pathOfPacked(packed, index, 0);
}

/**
 * Check a proof: folds `node` with the siblings, left or right by the bits of
 * `index`.  Also rejects an `index` that does not fit in `proof.length` bits.
 */
export function verifyProof(node: Uint8Array, index: number, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (node.length !== HASH_SIZE || root.length !== HASH_SIZE) return false;
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** proof.length) return false;
  let h = node;
  let i = index;
  for (const sibling of proof) {
    if (sibling.length !== HASH_SIZE) return false;
    h = i % 2 === 0 ? nodeHash(h, sibling) : nodeHash(sibling, h);
    i = Math.floor(i / 2);
  }
  return equalBytes(h, root);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Leaf hashes of a shard, packed (`32 · shard.length / 1024` bytes) */
export function shardLeafHashes(shard: Uint8Array): Uint8Array {
  if (shard.length === 0 || shard.length % SEGMENT_SIZE !== 0) {
    throw new Error(`Shards are a non-zero multiple of ${SEGMENT_SIZE} bytes (got ${shard.length})`);
  }
  const count = shard.length / SEGMENT_SIZE;
  const out = new Uint8Array(count * HASH_SIZE);
  for (let i = 0; i < count; i++) leafInto(shard.subarray(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE), out, i * HASH_SIZE);
  return out;
}

/** `r_j`: Merkle root of a shard's 1024-byte segments */
export function shardRoot(shard: Uint8Array): Uint8Array {
  return rootOfPacked(shardLeafHashes(shard));
}

/** `R`: Merkle root of the shard roots (used as nodes directly) */
export function blobRoot(shardRoots: Nodes): Uint8Array {
  return rootOfNodes(shardRoots);
}

/** Proof of `r_index` to `R` (`depth(n)` hashes): the `top_proof` of `prove_shard` */
export function blobProof(shardRoots: Nodes, index: number): Uint8Array[] {
  return proofOfNodes(shardRoots, index);
}

/** `log2(fragmentLeaves)`; `fragmentLeaves = F / 1024` must be a power of two */
function fragmentHeight(fragmentLeaves: number): number {
  if (!Number.isInteger(fragmentLeaves) || fragmentLeaves < 1 || (fragmentLeaves & (fragmentLeaves - 1)) !== 0) {
    throw new Error(`Fragments span a power-of-two number of segments (got ${fragmentLeaves})`);
  }
  return Math.log2(fragmentLeaves);
}

function checkFragment(leafHashes: Uint8Array, fragmentLeaves: number, stripe: number): number {
  const a = fragmentHeight(fragmentLeaves);
  const leaves = toPacked(leafHashes).length / HASH_SIZE;
  if (leaves % fragmentLeaves !== 0) throw new Error('The shard is not a whole number of fragments');
  assertIndex(stripe, leaves / fragmentLeaves, 'stripe');
  return a;
}

/** Root of fragment `stripe` (leaves `[stripe·L, (stripe+1)·L)`, `L = fragmentLeaves`): O(L) */
export function fragmentRoot(leafHashes: Uint8Array, fragmentLeaves: number, stripe: number): Uint8Array {
  checkFragment(leafHashes, fragmentLeaves, stripe);
  const start = stripe * fragmentLeaves * HASH_SIZE;
  return rootOfPacked(leafHashes.subarray(start, start + fragmentLeaves * HASH_SIZE));
}

/**
 * Proof of fragment `stripe` to the shard root: siblings of node `stripe` at
 * height `a = log2(fragmentLeaves)`, `depth(N) − a` hashes.  O(N) hashing;
 * build a `MerkleTree` once to answer many requests.
 */
export function fragmentProof(leafHashes: Uint8Array, fragmentLeaves: number, stripe: number): Uint8Array[] {
  const a = checkFragment(leafHashes, fragmentLeaves, stripe);
  return pathOfPacked(leafHashes, stripe, a);
}

/** Proof of segment `segmentIndex` to the shard root (`depth(N)` hashes): the `shard_proof` of `prove_shard` */
export function segmentProof(leafHashes: Uint8Array, segmentIndex: number): Uint8Array[] {
  const packed = toPacked(leafHashes);
  assertIndex(segmentIndex, packed.length / HASH_SIZE, 'segment');
  return pathOfPacked(packed, segmentIndex, 0);
}

/** Root of a fragment's bytes (`F` bytes, `F/1024` a power of two) */
export function fragmentRootOf(fragment: Uint8Array): Uint8Array {
  fragmentHeight(fragment.length / SEGMENT_SIZE);
  return rootOfPacked(shardLeafHashes(fragment));
}

/** Check fragment bytes served by a node against the shard root */
export function verifyFragment(fragment: Uint8Array, stripe: number, proof: readonly Uint8Array[], shardRootHash: Uint8Array): boolean {
  if (fragment.length === 0 || fragment.length % SEGMENT_SIZE !== 0) return false;
  const leaves = fragment.length / SEGMENT_SIZE;
  if ((leaves & (leaves - 1)) !== 0) return false;
  return verifyProof(fragmentRootOf(fragment), stripe, proof, shardRootHash);
}

/** The arguments of `prove_shard`, plus what the program reads from the Blob account */
export interface StorageProof {
  /** The 1024 challenged bytes */
  segment: Uint8Array;
  segmentIndex: number;
  /** leaf → r_index, depth(shardSize / 1024) hashes */
  shardProof: readonly Uint8Array[];
  /** r_index → R, depth(n) hashes */
  topProof: readonly Uint8Array[];
  shardIndex: number;
  /** Blob root R */
  root: Uint8Array;
  shardSize: number;
  /** n = total shards */
  totalShards: number;
}

/** What `prove_shard` checks: depths, then leafHash(segment) → r_index → R */
export function verifyStorageProof(p: StorageProof): boolean {
  if (p.segment.length !== SEGMENT_SIZE || p.shardSize % SEGMENT_SIZE !== 0 || p.shardSize === 0) return false;
  if (p.shardProof.length !== depth(p.shardSize / SEGMENT_SIZE) || p.topProof.length !== depth(p.totalShards)) return false;
  if (p.segmentIndex >= p.shardSize / SEGMENT_SIZE || p.shardIndex >= p.totalShards) return false;
  let h = leafHash(p.segment);
  let i = p.segmentIndex;
  for (const sibling of p.shardProof) {
    if (sibling.length !== HASH_SIZE) return false;
    h = i % 2 === 0 ? nodeHash(h, sibling) : nodeHash(sibling, h);
    i = Math.floor(i / 2);
  }
  return verifyProof(h, p.shardIndex, p.topProof, p.root);
}

/**
 * Segment a challenge asks for: `u64_le(sha256(slotHash ‖ blob ‖ [shardIndex])[0..8])
 * mod (shardSize / 1024)`.  `blob` is the 32 address bytes of the Blob account.
 */
export function challengeSegment(slotHash: Uint8Array, blob: Uint8Array, shardIndex: number, shardSize: number): number {
  assertHash(slotHash, 'slot hash');
  assertHash(blob, 'blob address');
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex > 255) throw new Error('Invalid shard index');
  if (shardSize <= 0 || shardSize % SEGMENT_SIZE !== 0) throw new Error('Invalid shard size');
  const digest = sha256.create().update(slotHash).update(blob).update(Uint8Array.of(shardIndex)).digest();
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, true);
  return Number(value % BigInt(shardSize / SEGMENT_SIZE));
}

/**
 * A whole tree kept in memory (every level packed; ~32 extra bytes per input
 * node), for answering many fragment or segment requests on one shard.
 */
export class MerkleTree {
  /** levels[0] = input nodes, levels[depth] = [root] */
  private readonly levels: Uint8Array[];

  constructor(nodes: Nodes) {
    const input = toPacked(nodes);
    this.levels = [input];
    let level = input;
    let count = input.length / HASH_SIZE;
    for (let h = 0; count > 1; h++) {
      const next = new Uint8Array(Math.ceil(count / 2) * HASH_SIZE);
      count = reduceLevel(level, count, next, h);
      this.levels.push(next);
      level = next;
    }
  }

  /** Number of input nodes */
  get size(): number {
    return this.levels[0].length / HASH_SIZE;
  }

  get depth(): number {
    return this.levels.length - 1;
  }

  get root(): Uint8Array {
    return this.levels[this.depth].slice(0, HASH_SIZE);
  }

  /** Node `index` at `height` (0 = input level); padding nodes are `Z_height` */
  node(height: number, index: number): Uint8Array {
    if (!Number.isInteger(height) || height < 0 || height > this.depth) throw new Error(`Invalid height ${height}`);
    assertIndex(index, 2 ** (this.depth - height));
    const level = this.levels[height];
    if (index * HASH_SIZE >= level.length) return zeroHash(height);
    return level.slice(index * HASH_SIZE, (index + 1) * HASH_SIZE);
  }

  /** Siblings of node `index` at `height` up to the root (`depth − height` hashes) */
  proof(index: number, height = 0): Uint8Array[] {
    if (!Number.isInteger(height) || height < 0 || height > this.depth) throw new Error(`Invalid height ${height}`);
    assertIndex(index, Math.ceil(this.size / 2 ** height));
    const proof: Uint8Array[] = [];
    for (let h = height, i = index; h < this.depth; h++, i = Math.floor(i / 2)) proof.push(this.node(h, i ^ 1));
    return proof;
  }

  /** Root of fragment `stripe` when the input nodes are a shard's leaves */
  fragmentRoot(fragmentLeaves: number, stripe: number): Uint8Array {
    return this.node(fragmentHeight(fragmentLeaves), stripe);
  }

  /** Proof of fragment `stripe` to the root when the input nodes are a shard's leaves */
  fragmentProof(fragmentLeaves: number, stripe: number): Uint8Array[] {
    const a = fragmentHeight(fragmentLeaves);
    if (this.size % fragmentLeaves !== 0) throw new Error('The shard is not a whole number of fragments');
    assertIndex(stripe, this.size / fragmentLeaves, 'stripe');
    return this.proof(stripe, a);
  }
}

export interface ShardHasherOptions {
  /** Keep the leaf hashes (32 bytes per KiB) for `leafHashes()`; default true */
  keepLeafHashes?: boolean;
  /** Expected shard size, to allocate the leaf-hash buffer once */
  expectedBytes?: number;
}

/**
 * Shard root computed while the bytes stream by, in pieces of any size.  The
 * root is folded incrementally (one pending node per level), so without
 * `keepLeafHashes` memory stays O(log N).
 */
export class ShardHasher {
  private readonly carry = new Uint8Array(SEGMENT_SIZE);
  private carryLength = 0;
  private leaves = 0;
  /** frontier[h] = pending left node at height h (present iff bit h of `leaves` is set) */
  private readonly frontier = new Uint8Array(64 * HASH_SIZE);
  private readonly scratch = new Uint8Array(HASH_SIZE);
  private hashes: Uint8Array | null;

  constructor(options: ShardHasherOptions = {}) {
    const keep = options.keepLeafHashes ?? true;
    const expected = Math.ceil((options.expectedBytes ?? 0) / SEGMENT_SIZE);
    this.hashes = keep ? new Uint8Array(Math.max(expected, 16) * HASH_SIZE) : null;
  }

  /** Bytes consumed so far */
  get length(): number {
    return this.leaves * SEGMENT_SIZE + this.carryLength;
  }

  /** Complete segments hashed so far */
  get leafCount(): number {
    return this.leaves;
  }

  update(bytes: Uint8Array): this {
    let offset = 0;
    if (this.carryLength > 0) {
      const take = Math.min(SEGMENT_SIZE - this.carryLength, bytes.length);
      this.carry.set(bytes.subarray(0, take), this.carryLength);
      this.carryLength += take;
      offset = take;
      if (this.carryLength < SEGMENT_SIZE) return this;
      this.addLeaf(this.carry);
      this.carryLength = 0;
    }
    while (bytes.length - offset >= SEGMENT_SIZE) {
      this.addLeaf(bytes.subarray(offset, offset + SEGMENT_SIZE));
      offset += SEGMENT_SIZE;
    }
    if (offset < bytes.length) {
      this.carry.set(bytes.subarray(offset), 0);
      this.carryLength = bytes.length - offset;
    }
    return this;
  }

  private addLeaf(segment: Uint8Array): void {
    const h = this.scratch;
    leafInto(segment, h, 0);
    if (this.hashes) {
      const at = this.leaves * HASH_SIZE;
      if (at + HASH_SIZE > this.hashes.length) {
        const grown = new Uint8Array(this.hashes.length * 2);
        grown.set(this.hashes);
        this.hashes = grown;
      }
      this.hashes.set(h, at);
    }
    // binary-counter carry: merge with the pending node of every set low bit
    let n = this.leaves;
    let height = 0;
    while (n % 2 === 1) {
      twoInto(this.frontier.subarray(height * HASH_SIZE, (height + 1) * HASH_SIZE), h, h, 0);
      n = Math.floor(n / 2);
      height++;
    }
    this.frontier.set(h, height * HASH_SIZE);
    this.leaves++;
  }

  private assertWhole(): void {
    if (this.carryLength !== 0) throw new Error(`Shard length ${this.length} is not a multiple of ${SEGMENT_SIZE}`);
    if (this.leaves === 0) throw new Error('Empty shard');
  }

  /** Packed leaf hashes (needs `keepLeafHashes`) */
  leafHashes(): Uint8Array {
    this.assertWhole();
    if (!this.hashes) throw new Error('ShardHasher was created without keepLeafHashes');
    return this.hashes.subarray(0, this.leaves * HASH_SIZE);
  }

  /** Root of the bytes consumed so far (a multiple of 1024 bytes); more may follow */
  root(): Uint8Array {
    this.assertWhole();
    const d = depth(this.leaves);
    let h: Uint8Array | null = null;
    for (let height = 0; height < d; height++) {
      const bit = Math.floor(this.leaves / 2 ** height) % 2 === 1;
      const pending = this.frontier.subarray(height * HASH_SIZE, (height + 1) * HASH_SIZE);
      if (bit) h = nodeHash(pending, h ?? zeroHash(height));
      else if (h) h = nodeHash(h, zeroHash(height));
    }
    return h ?? this.frontier.slice(d * HASH_SIZE, (d + 1) * HASH_SIZE);
  }
}
