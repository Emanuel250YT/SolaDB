import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { concatBytes } from '@noble/hashes/utils';
import {
  BLOB_FILE_SCHEMA,
  BlobEncoder,
  BlobManifest,
  EMPTY,
  ENCRYPTION_OVERHEAD,
  EncodedStripe,
  MAX_BLOBS_PER_FILE,
  MerkleTree,
  SEGMENT_SIZE,
  ShardHasher,
  blobProof,
  blobRoot,
  cauchyMatrix,
  challengeSegment,
  chooseLayout,
  decodeBlobManifest,
  decodeBlobs,
  decodeBundle,
  decodeStripe,
  decryptBytes,
  decryptStripe,
  depth,
  encodeBlobManifest,
  encodeBlobs,
  encodeBundle,
  encodeManifest,
  encodeParity,
  encryptStripe,
  fragmentProof,
  fragmentRoot,
  fragmentRootOf,
  fromHex,
  gfDiv,
  gfExp,
  gfInv,
  gfLog,
  gfMul,
  isBlobManifest,
  leafHash,
  nodeHash,
  nonceKey,
  planBlobs,
  proofOfNodes,
  randomKey,
  readBundleIndex,
  rebuildFragments,
  rebuildShardFragment,
  reconstruct,
  rootOfNodes,
  segmentProof,
  sha256,
  shardLeafHashes,
  shardRoot,
  splitStripe,
  stripeCapacity,
  stripeCount,
  stripePlainLengths,
  syntheticNonce,
  toHex,
  verifyFragment,
  verifyProof,
  verifyStorageProof,
  zeroHash,
} from '../src';

// ---------------------------------------------------------------------------
// helpers

/** Deterministic PRNG (mulberry32) */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    bytes: (n: number) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
  };
}

/** Deterministic bytes from sha256(label ‖ counter) */
function stream(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const prefix = new TextEncoder().encode(label);
  for (let i = 0, o = 0; o < length; i++, o += 32) {
    const block = sha256(concatBytes(prefix, Uint8Array.of(i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, i >>> 24)));
    out.set(block.subarray(0, Math.min(32, length - o)), o);
  }
  return out;
}

const hex = (bytes: Uint8Array) => toHex(bytes);
const hexes = (list: readonly Uint8Array[]) => list.map(hex);
const same = (a: readonly Uint8Array[], b: readonly Uint8Array[]) => assert.deepEqual(hexes(a), hexes(b));

/** Textbook Merkle tree: explicit padding with EMPTY, every level materialised */
const ref = {
  leaf: (segment: Uint8Array) => sha256(concatBytes(Uint8Array.of(0), segment)),
  node: (l: Uint8Array, r: Uint8Array) => sha256(concatBytes(Uint8Array.of(1), l, r)),
  levels(nodes: readonly Uint8Array[]): Uint8Array[][] {
    let size = 1;
    while (size < nodes.length) size *= 2;
    let level = [...nodes, ...Array.from({ length: size - nodes.length }, () => new Uint8Array(32))];
    const levels = [level];
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(ref.node(level[i], level[i + 1]));
      levels.push(next);
      level = next;
    }
    return levels;
  },
  root: (nodes: readonly Uint8Array[]) => ref.levels(nodes).at(-1)![0],
  /** Siblings of node `index` at `height` up to the root */
  path(nodes: readonly Uint8Array[], index: number, height = 0): Uint8Array[] {
    return ref
      .levels(nodes)
      .slice(height, -1)
      .map((level, h) => level[(index >> h) ^ 1]);
  },
};

const segmentsOf = (shard: Uint8Array) =>
  Array.from({ length: shard.length / SEGMENT_SIZE }, (_, i) => shard.subarray(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE));

/** Slow GF(256) multiply: carry-less product reduced by 0x11D */
function slowMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & (1 << i)) p ^= a << i;
  }
  for (let bit = 15; bit >= 8; bit--) if (p & (1 << bit)) p ^= 0x11d << (bit - 8);
  return p;
}

function* subsets(n: number, size: number, start = 0): Generator<number[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = start; i <= n - size; i++) for (const rest of subsets(n, size - 1, i + 1)) yield [i, ...rest];
}

function shardsFromStripes(stripes: EncodedStripe[], n: number, fragmentSize: number): Uint8Array[] {
  return Array.from({ length: n }, (_, j) => {
    const shard = new Uint8Array(stripes.length * fragmentSize);
    stripes.forEach((s) => shard.set(s.fragments[j], s.stripe * fragmentSize));
    return shard;
  });
}

// ---------------------------------------------------------------------------
// Merkle

test('merkle: hash definitions, EMPTY, Z_h and depth', () => {
  const segment = stream('segment', SEGMENT_SIZE);
  assert.deepEqual(leafHash(segment), ref.leaf(segment));
  const [l, r] = [stream('l', 32), stream('r', 32)];
  assert.deepEqual(nodeHash(l, r), ref.node(l, r));
  assert.notDeepEqual(nodeHash(l, r), nodeHash(r, l));
  assert.deepEqual(EMPTY, new Uint8Array(32));
  assert.deepEqual(zeroHash(0), EMPTY);
  for (let h = 1; h <= 10; h++) assert.deepEqual(zeroHash(h), ref.node(zeroHash(h - 1), zeroHash(h - 1)));
  assert.equal(zeroHash(7), zeroHash(7), 'memoised');
  assert.throws(() => leafHash(new Uint8Array(1023)));
  assert.throws(() => nodeHash(l, new Uint8Array(31)));
  const depths: [number, number][] = [[1, 0], [2, 1], [3, 2], [4, 2], [5, 3], [8, 3], [9, 4], [1024, 10], [1025, 11], [1 << 20, 20]];
  for (const [n, d] of depths) assert.equal(depth(n), d, `depth(${n})`);
  assert.throws(() => depth(0));
});

test('merkle: roots match a textbook padded tree for 1..40 nodes', () => {
  for (let n = 1; n <= 40; n++) {
    const nodes = Array.from({ length: n }, (_, i) => stream(`node${i}`, 32));
    const root = rootOfNodes(nodes);
    assert.deepEqual(root, ref.root(nodes), `n = ${n}`);
    assert.deepEqual(rootOfNodes(concatBytes(...nodes)), root, 'packed input');
    assert.deepEqual(new MerkleTree(nodes).root, root);
  }
  const [a, b, c] = [stream('a', 32), stream('b', 32), stream('c', 32)];
  assert.deepEqual(rootOfNodes([a]), a, 'one node is its own root');
  assert.deepEqual(rootOfNodes([a, b, c]), nodeHash(nodeHash(a, b), nodeHash(c, EMPTY)), 'padding with EMPTY');
  const five = [a, b, c, a, b];
  assert.deepEqual(
    rootOfNodes(five),
    nodeHash(nodeHash(nodeHash(a, b), nodeHash(c, a)), nodeHash(nodeHash(b, EMPTY), zeroHash(1))),
    'padded subtrees hash to Z_h',
  );
  assert.throws(() => rootOfNodes([]));
  assert.throws(() => rootOfNodes(new Uint8Array(33)));
});

test('merkle: proofs for every index of small trees', () => {
  for (let n = 1; n <= 17; n++) {
    const nodes = Array.from({ length: n }, (_, i) => stream(`p${n}.${i}`, 32));
    const root = rootOfNodes(nodes);
    const tree = new MerkleTree(nodes);
    for (let i = 0; i < n; i++) {
      const proof = proofOfNodes(nodes, i);
      assert.equal(proof.length, depth(n));
      same(proof, ref.path(nodes, i));
      same(tree.proof(i), proof);
      assert.ok(verifyProof(nodes[i], i, proof, root), `n=${n} i=${i}`);
      assert.equal(verifyProof(nodes[(i + 1) % n], i, proof, root), n === 1, 'wrong node');
      if (n > 1) {
        assert.equal(verifyProof(nodes[i], i ^ 1, proof, root), false, 'wrong index');
        const tampered = proof.map((p) => p.slice());
        tampered[0][5] ^= 1;
        assert.equal(verifyProof(nodes[i], i, tampered, root), false, 'tampered sibling');
      }
      assert.equal(verifyProof(nodes[i], i + 2 ** proof.length, proof, root), false, 'index beyond the tree');
    }
    assert.throws(() => proofOfNodes(nodes, n));
    // node(height, index) of the stored tree vs the textbook levels
    const levels = ref.levels(nodes);
    for (let h = 0; h <= tree.depth; h++) {
      for (let i = 0; i < levels[h].length; i++) assert.deepEqual(tree.node(h, i), levels[h][i]);
    }
  }
});

test('merkle: shard roots, fragment and segment proofs vs full-tree recomputation', () => {
  for (const fragmentLeaves of [1, 2, 4, 8]) {
    for (let stripes = 1; stripes <= 9; stripes++) {
      const shard = stream(`shard.${fragmentLeaves}.${stripes}`, stripes * fragmentLeaves * SEGMENT_SIZE);
      const leaves = segmentsOf(shard).map(ref.leaf);
      const packed = shardLeafHashes(shard);
      assert.deepEqual(packed, concatBytes(...leaves));
      const root = shardRoot(shard);
      assert.deepEqual(root, ref.root(leaves));
      const tree = new MerkleTree(packed);
      const a = Math.log2(fragmentLeaves);
      const levels = ref.levels(leaves);
      for (let s = 0; s < stripes; s++) {
        const fragment = shard.subarray(s * fragmentLeaves * SEGMENT_SIZE, (s + 1) * fragmentLeaves * SEGMENT_SIZE);
        const fRoot = fragmentRoot(packed, fragmentLeaves, s);
        assert.deepEqual(fRoot, levels[a][s], 'fragment root = node s at level a');
        assert.deepEqual(fRoot, rootOfNodes(leaves.slice(s * fragmentLeaves, (s + 1) * fragmentLeaves)));
        assert.deepEqual(fragmentRootOf(fragment), fRoot);
        assert.deepEqual(tree.fragmentRoot(fragmentLeaves, s), fRoot);
        const proof = fragmentProof(packed, fragmentLeaves, s);
        assert.equal(proof.length, depth(leaves.length) - a);
        same(proof, ref.path(leaves, s, a));
        same(tree.fragmentProof(fragmentLeaves, s), proof);
        assert.ok(verifyProof(fRoot, s, proof, root));
        assert.ok(verifyFragment(fragment, s, proof, root));
        const tampered = fragment.slice();
        tampered[tampered.length - 1] ^= 0x80;
        assert.equal(verifyFragment(tampered, s, proof, root), false, 'tampered fragment');
        if (stripes > 1) assert.equal(verifyFragment(fragment, (s + 1) % stripes, proof, root), false, 'wrong stripe');
      }
      for (let i = 0; i < leaves.length; i++) {
        const proof = segmentProof(packed, i);
        same(proof, ref.path(leaves, i));
        same(tree.proof(i), proof);
        assert.ok(verifyProof(leaves[i], i, proof, root));
        // a segment proof is the path inside its fragment followed by the fragment proof
        const s = Math.floor(i / fragmentLeaves);
        const inner = proofOfNodes(leaves.slice(s * fragmentLeaves, (s + 1) * fragmentLeaves), i % fragmentLeaves);
        same(proof, [...inner, ...fragmentProof(packed, fragmentLeaves, s)]);
      }
      assert.throws(() => fragmentProof(packed, fragmentLeaves, stripes));
      assert.throws(() => segmentProof(packed, leaves.length));
    }
  }
  assert.throws(() => shardLeafHashes(new Uint8Array(1500)), /multiple of 1024/);
  assert.throws(() => shardLeafHashes(new Uint8Array(0)));
  assert.throws(() => fragmentRoot(shardLeafHashes(new Uint8Array(3 * 1024)), 2, 0), /whole number of fragments/);
  assert.throws(() => fragmentRoot(shardLeafHashes(new Uint8Array(6 * 1024)), 3, 0), /power-of-two/);
});

test('merkle: blob proofs and the prove_shard check', () => {
  const shards = Array.from({ length: 5 }, (_, j) => stream(`blobproof${j}`, 6 * SEGMENT_SIZE));
  const roots = shards.map(shardRoot);
  const R = blobRoot(roots);
  assert.deepEqual(R, ref.root(roots), 'shard roots are nodes, not re-hashed leaves');
  for (let j = 0; j < shards.length; j++) {
    const top = blobProof(roots, j);
    assert.equal(top.length, depth(5));
    assert.ok(verifyProof(roots[j], j, top, R));
    const leaves = shardLeafHashes(shards[j]);
    for (let i = 0; i < 6; i++) {
      const p = {
        segment: segmentsOf(shards[j])[i],
        segmentIndex: i,
        shardProof: segmentProof(leaves, i),
        topProof: top,
        shardIndex: j,
        root: R,
        shardSize: shards[j].length,
        totalShards: 5,
      };
      assert.ok(verifyStorageProof(p));
      assert.equal(verifyStorageProof({ ...p, segmentIndex: (i + 1) % 6 }), false);
      assert.equal(verifyStorageProof({ ...p, shardIndex: (j + 1) % 5 }), false);
      assert.equal(verifyStorageProof({ ...p, shardProof: p.shardProof.slice(1) }), false, 'depth is checked');
      assert.equal(verifyStorageProof({ ...p, totalShards: 9 }), false, 'top depth is checked');
      assert.equal(verifyStorageProof({ ...p, segment: stream('other', SEGMENT_SIZE) }), false);
    }
  }
});

test('merkle: ShardHasher equals the one-shot root for random piece sizes', () => {
  const rand = prng(7);
  for (let leaves = 1; leaves <= 40; leaves++) {
    const shard = stream(`hasher${leaves}`, leaves * SEGMENT_SIZE);
    const hasher = new ShardHasher();
    for (let o = 0; o < shard.length; ) {
      const size = [0, 1, 1023, 1024, 1025, rand.int(5000)][rand.int(6)];
      hasher.update(shard.subarray(o, o + size));
      o += size;
    }
    assert.equal(hasher.length, shard.length);
    assert.equal(hasher.leafCount, leaves);
    assert.deepEqual(hasher.root(), shardRoot(shard), `${leaves} leaves`);
    assert.deepEqual(hasher.leafHashes(), shardLeafHashes(shard));
    const lean = new ShardHasher({ keepLeafHashes: false }).update(shard);
    assert.deepEqual(lean.root(), shardRoot(shard));
    assert.throws(() => lean.leafHashes(), /keepLeafHashes/);
  }
  // root() is available at any segment boundary and more bytes may follow
  const shard = stream('midway', 7 * SEGMENT_SIZE);
  const hasher = new ShardHasher({ expectedBytes: shard.length }).update(shard.subarray(0, 3 * SEGMENT_SIZE));
  assert.deepEqual(hasher.root(), shardRoot(shard.subarray(0, 3 * SEGMENT_SIZE)));
  hasher.update(shard.subarray(3 * SEGMENT_SIZE, 3 * SEGMENT_SIZE + 10));
  assert.throws(() => hasher.root(), /multiple of 1024/);
  hasher.update(shard.subarray(3 * SEGMENT_SIZE + 10));
  assert.deepEqual(hasher.root(), shardRoot(shard));
  assert.throws(() => new ShardHasher().root(), /Empty/);
});

test('merkle: challenge segment index', () => {
  const slotHash = stream('slot', 32);
  const blob = stream('blob', 32);
  const digest = sha256(concatBytes(slotHash, blob, Uint8Array.of(3)));
  const expected = new DataView(digest.buffer, digest.byteOffset).getBigUint64(0, true) % 1024n;
  assert.equal(challengeSegment(slotHash, blob, 3, 1024 * SEGMENT_SIZE), Number(expected));
  for (let i = 0; i < 32; i++) {
    const s = challengeSegment(slotHash, blob, i, 5 * SEGMENT_SIZE);
    assert.ok(s >= 0 && s < 5);
  }
  assert.equal(challengeSegment(slotHash, blob, 0, SEGMENT_SIZE), 0);
});

test('merkle: building a 1 GiB-shard tree is O(N) on packed arrays (benchmark)', () => {
  const leaves = stream('bench-leaves', 32 << 16); // 2^16 leaves (a 64 MiB shard)
  let t = performance.now();
  const tree = new MerkleTree(leaves);
  const treeMs = performance.now() - t;
  t = performance.now();
  for (let s = 0; s < 64; s++) tree.fragmentProof(1024, s);
  const proofsMs = performance.now() - t;
  const shard = stream('bench-shard', 8 << 20);
  t = performance.now();
  new ShardHasher({ keepLeafHashes: false }).update(shard).root();
  const hashMs = performance.now() - t;
  console.log(
    `merkle: tree over 2^16 leaves ${treeMs.toFixed(0)} ms (~${((treeMs * 16) / 1000).toFixed(1)} s for a 1 GiB shard), ` +
      `64 fragment proofs ${proofsMs.toFixed(1)} ms, ShardHasher ${(8 / (hashMs / 1000)).toFixed(0)} MiB/s`,
  );
  assert.ok(treeMs < 10_000);
});

// ---------------------------------------------------------------------------
// GF(256) and Reed-Solomon

test('gf256: multiplication table, field axioms and inverses', () => {
  for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) assert.equal(gfMul(a, b), slowMul(a, b));
  assert.equal(gfMul(0x80, 2), 0x1d, 'x^8 = x^4 + x^3 + x^2 + 1');
  const rand = prng(11);
  for (let t = 0; t < 2000; t++) {
    const [a, b, c] = [rand.int(256), rand.int(256), rand.int(256)];
    assert.equal(gfMul(a, b), gfMul(b, a));
    assert.equal(gfMul(a, gfMul(b, c)), gfMul(gfMul(a, b), c));
    assert.equal(gfMul(a, b ^ c), gfMul(a, b) ^ gfMul(a, c));
    assert.equal(gfMul(a, 1), a);
    assert.equal(gfMul(a, 0), 0);
    if (b) assert.equal(gfMul(gfDiv(a, b), b), a);
  }
  const seen = new Set<number>();
  for (let e = 0; e < 255; e++) seen.add(gfExp(e));
  assert.equal(seen.size, 255, '2 generates the multiplicative group');
  for (let a = 1; a < 256; a++) {
    assert.equal(gfMul(a, gfInv(a)), 1);
    assert.equal(gfExp(gfLog(a)), a);
  }
  assert.throws(() => gfInv(0));
  assert.throws(() => gfLog(0));
  const c = cauchyMatrix(10, 4);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 10; j++) assert.equal(gfMul(c[i][j], (10 + i) ^ j), 1);
});

test('reed-solomon: every k-subset recovers (exhaustive for n ≤ 6)', () => {
  const rand = prng(3);
  for (let n = 1; n <= 6; n++) {
    for (let k = 1; k <= n; k++) {
      const m = n - k;
      const data = Array.from({ length: k }, () => rand.bytes(37));
      const all = [...data, ...encodeParity(data, m)];
      assert.equal(all.length, n);
      for (const keep of subsets(n, k)) {
        const fragments = all.map((f, i) => (keep.includes(i) ? f : null));
        same(reconstruct(fragments, k, m), data);
        for (let t = 0; t < n; t++) assert.deepEqual(rebuildShardFragment(fragments, k, m, t), all[t], `${k}+${m} keep ${keep} → ${t}`);
      }
      if (k > 1) {
        const short = all.map((f, i) => (i < k - 1 ? f : null));
        assert.throws(() => reconstruct(short, k, m), /Need/);
      }
    }
  }
});

test('reed-solomon: 10+4 recovers from random subsets and rebuilds any fragment', () => {
  const rand = prng(5);
  const data = Array.from({ length: 10 }, () => rand.bytes(4096));
  const all = [...data, ...encodeParity(data, 4)];
  for (let t = 0; t < 60; t++) {
    const order = Array.from({ length: 14 }, (_, i) => i).sort(() => rand.next() - 0.5);
    const keep = new Set(order.slice(0, 10 + rand.int(4)));
    const fragments = all.map((f, i) => (keep.has(i) ? f : null));
    same(reconstruct(fragments, 10, 4), data);
    const missing = [...Array(14).keys()].filter((i) => !keep.has(i));
    same(rebuildFragments(fragments, 10, 4, missing), missing.map((i) => all[i]));
    for (const i of missing) assert.deepEqual(rebuildShardFragment(fragments, 10, 4, i), all[i]);
  }
  // present fragments are returned untouched; lengths must agree
  assert.equal(reconstruct(all, 10, 4)[3], all[3]);
  assert.throws(() => encodeParity([new Uint8Array(4), new Uint8Array(5)], 1), /same length/);
  assert.throws(() => reconstruct(all.slice(0, 13), 10, 4), /14 fragment slots/);
  assert.equal(encodeParity(data, 0).length, 0);
});

test('reed-solomon: encoding 10 × 1 MiB (benchmark)', () => {
  const data = Array.from({ length: 10 }, (_, j) => stream(`rs${j}`, 1 << 20));
  encodeParity(data.map((d) => d.subarray(0, 4096)), 4); // warm up
  const t = performance.now();
  const parity = encodeParity(data, 4);
  const ms = performance.now() - t;
  const fragments = [...data, ...parity].map((f, i) => (i === 0 || i === 4 || i === 7 || i === 9 ? null : f));
  const t2 = performance.now();
  const recovered = reconstruct(fragments, 10, 4);
  const ms2 = performance.now() - t2;
  console.log(
    `reed-solomon 10+4 over 10 MiB: encode ${ms.toFixed(0)} ms (${(10 / (ms / 1000)).toFixed(0)} MiB/s), ` +
      `reconstruct 4 lost ${ms2.toFixed(0)} ms`,
  );
  assert.ok(recovered[4].every((b, i) => b === data[4][i]), 'recovered fragment 4');
  assert.ok(ms < 5_000, 'well under a second on Node 22');
});

// ---------------------------------------------------------------------------
// Stripes

test('stripes: capacities, counts and plaintext lengths', () => {
  assert.equal(ENCRYPTION_OVERHEAD, 28);
  assert.equal(stripeCapacity(2, 1024), 2020);
  assert.equal(stripeCount(0, 2, 1024), 1, 'an empty payload is one empty stripe');
  assert.deepEqual(stripePlainLengths(0, 2, 1024), [0]);
  assert.deepEqual(stripePlainLengths(1, 2, 1024), [1]);
  assert.deepEqual(stripePlainLengths(2020, 2, 1024), [2020]);
  assert.deepEqual(stripePlainLengths(2021, 2, 1024), [2020, 1]);
  assert.deepEqual(stripePlainLengths(6060, 2, 1024), [2020, 2020, 2020]);
  assert.equal(stripeCount(10 * 2020 + 5, 2, 1024), 11);
  assert.throws(() => stripeCapacity(2, 1000));
  assert.throws(() => stripeCount(-1, 2, 1024));
});

test('stripes: encryption round trip, padding and splitting', () => {
  const dek = randomKey();
  for (const length of [0, 1, 100, 2019, 2020]) {
    const plain = stream(`plain${length}`, length);
    const cipher = encryptStripe(dek, plain, 2, 1024);
    assert.equal(cipher.length, 2048);
    assert.ok(cipher.subarray(length + ENCRYPTION_OVERHEAD).every((b) => b === 0), 'right-padded with zeros');
    assert.deepEqual(decryptBytes(dek, cipher.subarray(0, length + ENCRYPTION_OVERHEAD)), plain, 'encryptBytes layout');
    assert.deepEqual(decryptStripe(dek, cipher, length), plain);
    const parts = splitStripe(cipher, 2, 1024);
    assert.deepEqual(concatBytes(...parts), cipher);
  }
  assert.throws(() => encryptStripe(dek, new Uint8Array(2021), 2, 1024), /at most 2020/);
  assert.throws(() => decryptStripe(dek, new Uint8Array(2048), 2021));
  assert.throws(() => decryptStripe(randomKey(), encryptStripe(dek, stream('x', 10), 2, 1024), 10));
  // fresh random nonces by default, a given nonce is deterministic
  const plain = stream('nonce', 500);
  assert.notDeepEqual(encryptStripe(dek, plain, 2, 1024), encryptStripe(dek, plain, 2, 1024));
  const nonce = stream('n', 12);
  assert.deepEqual(encryptStripe(dek, plain, 2, 1024, { nonce }), encryptStripe(dek, plain, 2, 1024, { nonce }));
  assert.deepEqual(encryptStripe(dek, plain, 2, 1024, { nonce }).subarray(0, 12), nonce);
  // synthetic nonces depend on the key, the position and the plaintext
  const key = nonceKey(dek);
  const base = syntheticNonce(key, 0, 0, plain);
  assert.equal(base.length, 12);
  assert.deepEqual(syntheticNonce(key, 0, 0, plain), base);
  assert.notDeepEqual(syntheticNonce(key, 0, 1, plain), base);
  assert.notDeepEqual(syntheticNonce(key, 1, 0, plain), base);
  assert.notDeepEqual(syntheticNonce(key, 0, 0, stream('other', 500)), base);
  assert.notDeepEqual(syntheticNonce(nonceKey(randomKey()), 0, 0, plain), base);
});

test('stripes: decoding uses only the data fragments that hold ciphertext', () => {
  const dek = randomKey();
  const plain = stream('small', 100);
  const cipher = encryptStripe(dek, plain, 4, 1024);
  const data = splitStripe(cipher, 4, 1024);
  const all = [...data, ...encodeParity(data, 1)];
  // 3 lost fragments > m = 1, but the 128 ciphertext bytes all sit in fragment 0
  assert.deepEqual(decodeStripe([all[0], null, null, null, all[4]], 4, 1, 1024, dek, 100), plain);
  // fragment 0 lost: rebuilt from parity
  assert.deepEqual(decodeStripe([null, all[1], all[2], all[3], all[4]], 4, 1, 1024, dek, 100), plain);
  assert.throws(() => decodeStripe([null, all[1], all[2], null, all[4]], 4, 1, 1024, dek, 100), /Need 4/);
  assert.throws(() => decodeStripe(all, 4, 1, 1024, dek, 4 * 1024), /Invalid stripe plaintext length/);
});

// ---------------------------------------------------------------------------
// Blobs

const layout = { k: 3, m: 2, fragmentSize: 2048, stripesPerBlob: 4 };

test('blobs: the streaming encoder matches encodeBlobs in memory', async () => {
  const dek = randomKey();
  const capacity = stripeCapacity(layout.k, layout.fragmentSize);
  const rand = prng(21);
  for (const size of [0, 1, capacity - 1, capacity, capacity + 1, 3 * capacity + 77, 4 * capacity]) {
    const payload = stream(`payload${size}`, size);
    const [blob, extra] = encodeBlobs(payload, layout, dek, { nonces: 'synthetic' });
    assert.equal(extra, undefined, 'one blob');
    assert.equal(blob.stripes, stripeCount(size, layout.k, layout.fragmentSize));
    assert.equal(blob.shardSize, blob.stripes * layout.fragmentSize);
    same(blob.shardRoots, blob.shards.map(shardRoot));
    assert.deepEqual(blob.root, blobRoot(blob.shardRoots));

    // push in random pieces
    const encoder = new BlobEncoder(layout, dek, { nonces: 'synthetic', keepLeafHashes: true });
    const stripes: EncodedStripe[] = [];
    for (let o = 0; o < size; ) {
      const piece = rand.int(capacity * 1.5) + (rand.int(4) === 0 ? 0 : 1);
      stripes.push(...encoder.push(payload.subarray(o, o + piece)));
      o += piece;
    }
    stripes.push(...encoder.finish());
    assert.deepEqual(
      stripes.map((s) => s.stripe),
      stripes.map((_, i) => i),
    );
    assert.deepEqual(
      stripes.map((s) => s.plainLength),
      stripePlainLengths(size, layout.k, layout.fragmentSize),
    );
    same(shardsFromStripes(stripes, 5, layout.fragmentSize), blob.shards);
    same(encoder.shardRoots, blob.shardRoots);
    assert.deepEqual(encoder.root, blob.root);
    assert.equal(encoder.stripes, blob.stripes);
    assert.equal(encoder.shardSize, blob.shardSize);
    assert.equal(encoder.payloadLength, size);
    assert.deepEqual(encoder.leafHashes(4), shardLeafHashes(blob.shards[4]));
    assert.throws(() => encoder.push(new Uint8Array(1)), /finished/);

    // async iterator over an async source
    const asyncEncoder = new BlobEncoder(layout, dek, { nonces: 'synthetic' });
    async function* source() {
      yield payload.subarray(0, 5);
      yield payload.subarray(5);
    }
    const iterated: EncodedStripe[] = [];
    for await (const s of asyncEncoder.encode(source())) iterated.push(s);
    same(shardsFromStripes(iterated, 5, layout.fragmentSize), blob.shards);
    assert.deepEqual(asyncEncoder.root, blob.root);

    assert.deepEqual(decodeBlobs([blob], layout, dek, size), payload);
  }
  const fresh = new BlobEncoder(layout, dek);
  assert.throws(() => fresh.root, /not finished/);
});

test('blobs: random nonces give fresh shards that still decode; synthetic ones repeat', () => {
  const dek = randomKey();
  const payload = stream('nonces', 10_000);
  const [a] = encodeBlobs(payload, layout, dek);
  const [b] = encodeBlobs(payload, layout, dek);
  assert.notDeepEqual(a.root, b.root);
  assert.deepEqual(decodeBlobs([a], layout, dek, payload.length), payload);
  assert.deepEqual(decodeBlobs([b], layout, dek, payload.length), payload);
  const [c] = encodeBlobs(payload, layout, dek, { nonces: 'synthetic' });
  const [d] = encodeBlobs(payload, layout, dek, { nonces: 'synthetic' });
  assert.deepEqual(c.root, d.root);
  const [e] = encodeBlobs(payload, layout, randomKey(), { nonces: 'synthetic' });
  assert.notDeepEqual(c.root, e.root);
});

test('blobs: large payloads are split over several blobs, in order', () => {
  const dek = randomKey();
  const capacity = stripeCapacity(layout.k, layout.fragmentSize);
  const size = 9 * capacity + 1000; // 10 stripes → 4 + 4 + 2
  const payload = stream('multi', size);
  const plans = planBlobs(size, layout);
  assert.deepEqual(
    plans.map((p) => [p.index, p.offset, p.length, p.stripes, p.shardSize]),
    [
      [0, 0, 4 * capacity, 4, 4 * 2048],
      [1, 4 * capacity, 4 * capacity, 4, 4 * 2048],
      [2, 8 * capacity, capacity + 1000, 2, 2 * 2048],
    ],
  );
  const blobs = encodeBlobs(payload, layout, dek);
  assert.deepEqual(
    blobs.map((b) => [b.index, b.stripes, b.payloadOffset, b.payloadLength]),
    plans.map((p) => [p.index, p.stripes, p.offset, p.length]),
  );
  assert.equal(new Set(blobs.map((b) => hex(b.root))).size, 3);
  assert.deepEqual(decodeBlobs(blobs, layout, dek, size), payload);
  assert.throws(() => decodeBlobs(blobs.slice(0, 2), layout, dek, size), /Expected 10 stripes/);
  // stripes carry no position (no AAD): the order of the blobs is the manifest's job, checked by its sha256
  assert.notDeepEqual(decodeBlobs([blobs[1], blobs[0], blobs[2]], layout, dek, size), payload);
  // one encoder holds at most stripesPerBlob stripes
  const encoder = new BlobEncoder(layout, dek);
  encoder.push(payload.subarray(0, 4 * capacity));
  assert.throws(() => encoder.push(payload.subarray(4 * capacity, 4 * capacity + 1)), /exceeds the blob capacity/);
  // exactly full blobs: no trailing empty blob
  assert.equal(planBlobs(8 * capacity, layout).length, 2);
  assert.deepEqual(decodeBlobs(encodeBlobs(payload.subarray(0, 8 * capacity), layout, dek), layout, dek, 8 * capacity), payload.subarray(0, 8 * capacity));
});

test('blobs: decode with up to m shards missing, and a tampered shard is caught by its Merkle root', () => {
  const dek = randomKey();
  const payload = stream('lossy', 5 * stripeCapacity(layout.k, layout.fragmentSize) - 300);
  const blobs = encodeBlobs(payload, layout, dek);
  for (const lost of subsets(5, 2)) {
    const damaged = blobs.map((b) => ({ shards: b.shards.map((s, j) => (lost.includes(j) ? null : s)) }));
    assert.deepEqual(decodeBlobs(damaged, layout, dek, payload.length), payload, `lost ${lost}`);
  }
  const tooMany = blobs.map((b) => ({ shards: b.shards.map((s, j) => (j < 3 ? null : s)) }));
  assert.throws(() => decodeBlobs(tooMany, layout, dek, payload.length));

  // flip one byte of shard 1, stripe 2
  const blob = blobs[0];
  const tampered = blob.shards.map((s) => s.slice());
  tampered[1][2 * layout.fragmentSize + 99] ^= 1;
  const leaves = shardLeafHashes(blob.shards[1]);
  const fragmentLeaves = layout.fragmentSize / SEGMENT_SIZE;
  const fragment = (shard: Uint8Array, s: number) => shard.subarray(s * layout.fragmentSize, (s + 1) * layout.fragmentSize);
  const proof = fragmentProof(leaves, fragmentLeaves, 2);
  assert.ok(verifyFragment(fragment(blob.shards[1], 2), 2, proof, blob.shardRoots[1]));
  assert.equal(verifyFragment(fragment(tampered[1], 2), 2, proof, blob.shardRoots[1]), false, 'fragment proof fails');
  assert.ok(verifyFragment(fragment(tampered[1], 1), 1, fragmentProof(leaves, fragmentLeaves, 1), blob.shardRoots[1]));
  // without roots the corruption reaches AES-GCM, which rejects it
  assert.throws(() => decodeBlobs([{ shards: tampered }], layout, dek, blob.payloadLength));
  // with roots the bad shard is dropped and the blob is rebuilt from the others
  const checked = { shards: tampered, shardRoots: blob.shardRoots, root: blob.root };
  assert.deepEqual(decodeBlobs([checked], layout, dek, blob.payloadLength), payload.subarray(0, blob.payloadLength));
  const forged = blob.shardRoots.map((r) => r.slice());
  forged[0][0] ^= 1;
  assert.throws(() => decodeBlobs([{ ...checked, shardRoots: forged }], layout, dek, blob.payloadLength), /do not match the blob root/);
});

test('blobs: empty payload', () => {
  const dek = randomKey();
  const [blob] = encodeBlobs(new Uint8Array(0), layout, dek);
  assert.equal(blob.stripes, 1);
  assert.equal(blob.shardSize, layout.fragmentSize);
  assert.deepEqual(decodeBlobs([blob], layout, dek, 0), new Uint8Array(0));
  const encoder = new BlobEncoder({ k: 1, m: 0, fragmentSize: 1024 }, dek);
  const [stripe] = encoder.finish();
  assert.equal(stripe.plainLength, 0);
  assert.deepEqual(decodeStripe(stripe.fragments, 1, 0, 1024, dek, 0), new Uint8Array(0));
  assert.equal(encoder.stripes, 1);
});

// ---------------------------------------------------------------------------
// Layout choice

test('chooseLayout: defaults by node count and fragment sizing', () => {
  const codes: [number, number, number][] = [
    [1, 1, 0], [2, 1, 1], [3, 2, 1], [5, 2, 1], [6, 4, 2], [8, 4, 2], [9, 6, 3], [13, 6, 3], [14, 10, 4], [40, 10, 4],
  ];
  for (const [nodes, k, m] of codes) {
    const l = chooseLayout({ payloadSize: 1 << 30, nodes });
    assert.deepEqual([l.k, l.m], [k, m], `${nodes} nodes`);
    assert.equal(l.fragmentSize, 1 << 20, 'large payloads use 1 MiB fragments');
  }
  // a 10 KB file is not padded to 10 MiB
  const small = chooseLayout({ payloadSize: 10_000, nodes: 14 });
  assert.deepEqual([small.k, small.m, small.fragmentSize, small.stripes, small.blobCount], [10, 4, 1024, 1, 1]);
  assert.equal(small.storedBytes, 14 * 1024);
  // the largest fragment that pads at most ~5 % over payload · n / k
  assert.equal(chooseLayout({ payloadSize: 0, nodes: 14 }).fragmentSize, 1024);
  assert.equal(chooseLayout({ payloadSize: 10 * 1024 - 28, nodes: 14 }).fragmentSize, 1024);
  const tight = chooseLayout({ payloadSize: 300_000, nodes: 3 });
  assert.deepEqual([tight.k, tight.m, tight.fragmentSize, tight.stripes], [2, 1, 8192, 19]);
  assert.ok(tight.storedBytes <= 300_000 * 1.5 * 1.05, 'not one padded 256 KiB stripe (1.75× the ideal)');
  for (const payloadSize of [5000, 600_000, 6 << 20, 123_456_789]) {
    const l = chooseLayout({ payloadSize, nodes: 14 });
    assert.ok(l.storedBytes <= Math.max((payloadSize * 14) / 10 * 1.05 + 14 * 1024, 14 * 1024 * l.stripes), `${payloadSize}: ${l.storedBytes}`);
  }
  // 25 MiB on 10+4: 21 stripes of 128 KiB fragments (1.1×) beat 3 stripes of 1 MiB (1.2×)
  const mid = chooseLayout({ payloadSize: 25 << 20, nodes: 14 });
  assert.deepEqual([mid.fragmentSize, mid.stripes, mid.blobCount, mid.shardSize], [128 << 10, 21, 1, 21 * (128 << 10)]);
  for (const payloadSize of [0, 1, 5000, 1 << 20, 123_456_789]) {
    for (const nodes of [1, 3, 14]) {
      const l = chooseLayout({ payloadSize, nodes });
      assert.ok(l.fragmentSize >= 1024 && l.fragmentSize <= 1 << 20 && (l.fragmentSize & (l.fragmentSize - 1)) === 0);
      assert.equal(l.stripes, stripeCount(payloadSize, l.k, l.fragmentSize));
      assert.ok(l.k + l.m <= nodes);
    }
  }
});

test('chooseLayout: blob splitting, redundancy and overrides', () => {
  const capacity = stripeCapacity(10, 1 << 20);
  // 1025 stripes: two balanced blobs instead of 1024 + 1
  const l = chooseLayout({ payloadSize: 1024 * capacity + 1, nodes: 20 });
  assert.deepEqual([l.stripes, l.blobCount, l.stripesPerBlob], [1025, 2, 513]);
  assert.deepEqual(planBlobs(1024 * capacity + 1, l).map((p) => p.stripes), [513, 512]);
  const one = chooseLayout({ payloadSize: 1024 * capacity, nodes: 20 });
  assert.deepEqual([one.blobCount, one.stripesPerBlob, one.shardSize], [1, 1024, 1 << 30]);
  assert.throws(() => chooseLayout({ payloadSize: 48 * 1024 * capacity + 1, nodes: 20 }), /at most 48/);
  // redundancy = parity shards, k = min(10, nodes − m)
  assert.deepEqual(
    [chooseLayout({ payloadSize: 1, nodes: 20, redundancy: 6 })].map((x) => [x.k, x.m]),
    [[10, 6]],
  );
  const r = chooseLayout({ payloadSize: 1, nodes: 5, redundancy: 2 });
  assert.deepEqual([r.k, r.m], [3, 2]);
  assert.throws(() => chooseLayout({ payloadSize: 1, nodes: 3, redundancy: 3 }), /cannot hold/);
  // overrides
  const o = chooseLayout({ payloadSize: 5 << 20, nodes: 14, k: 8, m: 6, fragmentSize: 4096, stripesPerBlob: 100 });
  assert.deepEqual([o.k, o.m, o.fragmentSize, o.stripesPerBlob], [8, 6, 4096, 100]);
  assert.equal(o.blobCount, Math.ceil(stripeCount(5 << 20, 8, 4096) / 100));
  assert.throws(() => chooseLayout({ payloadSize: 1, nodes: 14, fragmentSize: 3000 }), /power of two/);
  assert.throws(() => chooseLayout({ payloadSize: 1, nodes: 14, k: 30, m: 3 }), /k \+ m/);
  assert.throws(() => chooseLayout({ payloadSize: 1, nodes: 14, stripesPerBlob: 1025 }), /stripesPerBlob/);
  assert.throws(() => chooseLayout({ payloadSize: 1, nodes: 0 }), /node/);
});

// ---------------------------------------------------------------------------
// Bundles

test('bundles: round trip, index and tamper detection', () => {
  const files = [
    { name: 'notas/año-2026.txt', mime: 'text/plain', data: new TextEncoder().encode('hola mundo') },
    { name: 'vacío.bin', mime: 'application/octet-stream', data: new Uint8Array(0) },
    { name: 'foto.png', mime: 'image/png', data: stream('png', 5000) },
  ];
  const payload = encodeBundle(files);
  const entries = decodeBundle(payload);
  assert.deepEqual(
    entries.map((e) => [e.name, e.mime, hex(e.data), hex(e.sha256)]),
    files.map((f) => [f.name, f.mime, hex(f.data), hex(sha256(f.data))]),
  );
  const { entries: index, dataOffset } = readBundleIndex(payload);
  assert.deepEqual(
    index.map((e) => [e.offset, e.length]),
    [
      [0, 10],
      [10, 0],
      [10, 5000],
    ],
  );
  assert.equal(dataOffset, payload.length - 5010);
  assert.equal(new DataView(payload.buffer).getUint32(0, true), 3);
  assert.deepEqual(decodeBundle(encodeBundle([])), []);

  const tampered = payload.slice();
  tampered[payload.length - 1] ^= 1;
  assert.throws(() => decodeBundle(tampered), /foto\.png.*sha256/);
  assert.throws(() => decodeBundle(payload.subarray(0, payload.length - 1)), /Corrupted/);
  assert.throws(() => decodeBundle(payload.subarray(0, 20)), /Corrupted/);
  const huge = payload.slice();
  new DataView(huge.buffer).setUint32(0, 1_000_000, true);
  assert.throws(() => decodeBundle(huge), /Corrupted/);
  const long = decodeBundle(encodeBundle([{ name: 'é'.repeat(200), mime: 'x', data: new Uint8Array(1) }]));
  assert.ok(new TextEncoder().encode(long[0].name).length <= 255);
});

test('bundles travel through blobs', () => {
  const dek = randomKey();
  const payload = encodeBundle(Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.json`, mime: 'application/json', data: stream(`f${i}`, i * 37) })));
  const l = chooseLayout({ payloadSize: payload.length, nodes: 6 });
  const blobs = encodeBlobs(payload, l, dek);
  const back = decodeBundle(decodeBlobs(blobs.map((b) => ({ shards: b.shards.map((s, j) => (j === 1 ? null : s)) })), l, dek, payload.length));
  assert.equal(back.length, 50);
  assert.deepEqual(back[49].data, stream('f49', 49 * 37));
});

// ---------------------------------------------------------------------------
// Manifest v3

const manifest = (blobs: number, extra: Partial<BlobManifest> = {}): BlobManifest => ({
  v: 3,
  name: 'backup-2026.tar',
  mime: 'application/x-tar',
  size: 30_000_000_000,
  createdAt: 1_760_000_000,
  sha256: stream('sha', 32),
  dek: stream('dek', 32),
  payloadSize: (blobs - 1) * 1024 * stripeCapacity(10, 1 << 20) + 5,
  k: 10,
  m: 4,
  fragmentSize: 1 << 20,
  blobs: Array.from({ length: blobs }, (_, i) => ({ root: stream(`root${i}`, 32), stripes: i === blobs - 1 ? 1 : 1024 })),
  ...extra,
});

test('manifest v3: binary round trip and flags', () => {
  assert.equal(BLOB_FILE_SCHEMA, 'soladb.file.v3');
  for (const extra of [{}, { compression: 'gzip' as const }, { bundle: true as const }, { compression: 'gzip' as const, bundle: true as const }]) {
    const m = manifest(3, extra);
    const bytes = encodeBlobManifest(m);
    assert.equal(bytes[0], 3);
    assert.equal(bytes.length, 96 + m.name.length + m.mime.length + 3 * 36);
    assert.deepEqual(decodeBlobManifest(bytes), m);
    assert.ok(isBlobManifest(bytes));
  }
  const flags = encodeBlobManifest(manifest(1, { compression: 'gzip', bundle: true }))[1];
  assert.equal(flags, 4 | 8);
  const v2 = encodeManifest({
    v: 2, name: 'a', mime: 'b', size: 1, chunkSize: 1, sha256: stream('s', 32), dek: stream('d', 32), createdAt: 1, chunkCount: 1, chunks: [stream('c', 32)],
  });
  assert.equal(isBlobManifest(v2), false);
  assert.throws(() => decodeBlobManifest(v2), /Unsupported/);
  assert.equal(isBlobManifest(new Uint8Array(0)), false);
  const small = manifest(1, { payloadSize: 0, k: 1, m: 0, fragmentSize: 1024, blobs: [{ root: stream('r', 32), stripes: 1 }] });
  assert.deepEqual(decodeBlobManifest(encodeBlobManifest(small)), small);
});

test('manifest v3: limits', () => {
  // 48 blobs fit with ordinary names
  const full = manifest(MAX_BLOBS_PER_FILE);
  assert.deepEqual(decodeBlobManifest(encodeBlobManifest(full)), full);
  assert.throws(() => encodeBlobManifest(manifest(49)), /49 blobs/);
  // names and MIME types are truncated like v2
  const long = decodeBlobManifest(encodeBlobManifest(manifest(1, { name: 'á'.repeat(300), mime: 'x/'.repeat(80) })));
  assert.ok(new TextEncoder().encode(long.name).length <= 200);
  assert.ok(new TextEncoder().encode(long.mime).length <= 100);
  // with the longest name and MIME type, 48 blobs no longer fit in a 2048-byte record once sealed
  assert.throws(() => encodeBlobManifest(manifest(48, { name: 'n'.repeat(200), mime: 'm'.repeat(100) })), /records hold 2048/);
  assert.doesNotThrow(() => encodeBlobManifest(manifest(44, { name: 'n'.repeat(200), mime: 'm'.repeat(100) })));
  // the stripes must add up to the payload
  assert.throws(() => encodeBlobManifest(manifest(2, { payloadSize: 1 })), /stripes/);
  assert.throws(() => encodeBlobManifest(manifest(1, { k: 30, m: 3 })), /code/);
  assert.throws(() => encodeBlobManifest(manifest(1, { fragmentSize: 3000 })), /fragment size/);
  assert.throws(() => encodeBlobManifest(manifest(0, { payloadSize: 0 })), /0 blobs/);
  // corrupted bytes
  const bytes = encodeBlobManifest(manifest(2));
  assert.throws(() => decodeBlobManifest(bytes.subarray(0, bytes.length - 1)), /Corrupted/);
  assert.throws(() => decodeBlobManifest(concatBytes(bytes, new Uint8Array(1))), /Corrupted/);
  assert.throws(() => decodeBlobManifest(bytes.subarray(0, 50)), /Corrupted/);
  const badCount = bytes.slice();
  new DataView(badCount.buffer).setUint16(bytes.length - 2 * 36 - 2, 49, true);
  assert.throws(() => decodeBlobManifest(badCount), /Corrupted/);
});

// ---------------------------------------------------------------------------
// Test vectors shared with the Rust program tests

const VECTORS = path.resolve(__dirname, '../../test/vectors/blob-v1.json');

function blobVector(label: string, k: number, m: number, fragmentSize: number, stripes: number) {
  const data = Array.from({ length: k }, (_, j) => stream(`${label}/shard${j}`, stripes * fragmentSize));
  const parity = Array.from({ length: m }, () => new Uint8Array(stripes * fragmentSize));
  for (let s = 0; s < stripes; s++) {
    const range = (shard: Uint8Array) => shard.subarray(s * fragmentSize, (s + 1) * fragmentSize);
    encodeParity(data.map(range), m).forEach((p, i) => parity[i].set(p, s * fragmentSize));
  }
  const shards = [...data, ...parity];
  const shardRoots = shards.map(shardRoot);
  const root = blobRoot(shardRoots);
  const fragmentLeaves = fragmentSize / SEGMENT_SIZE;
  const leaves = shards.map(shardLeafHashes);
  return {
    k,
    m,
    fragmentSize,
    stripes,
    shardSize: stripes * fragmentSize,
    shards: hexes(shards),
    shardRoots: hexes(shardRoots),
    root: hex(root),
    topProofs: shards.map((_, j) => hexes(blobProof(shardRoots, j))),
    fragments: shards.flatMap((_, j) =>
      Array.from({ length: stripes }, (_, s) => ({
        shard: j,
        stripe: s,
        root: hex(fragmentRoot(leaves[j], fragmentLeaves, s)),
        proof: hexes(fragmentProof(leaves[j], fragmentLeaves, s)),
      })),
    ),
    segments: shards.flatMap((_, j) =>
      Array.from({ length: stripes * fragmentLeaves }, (_, i) => ({
        shard: j,
        segment: i,
        leaf: hex(leaves[j].subarray(32 * i, 32 * i + 32)),
        proof: hexes(segmentProof(leaves[j], i)),
      })),
    ),
  };
}

function buildVectors() {
  const segment = Uint8Array.from({ length: SEGMENT_SIZE }, (_, i) => i & 0xff);
  const trees = [1, 2, 3, 5].map((n) => {
    const nodes = Array.from({ length: n }, (_, i) => stream(`tree${n}/node${i}`, 32));
    return { nodes: hexes(nodes), root: hex(rootOfNodes(nodes)), proofs: nodes.map((_, i) => hexes(proofOfNodes(nodes, i))) };
  });
  const blobs = [blobVector('blob-v1/a', 2, 1, 1024, 3), blobVector('blob-v1/b', 2, 1, 2048, 3)];
  const slotHash = stream('blob-v1/slot-hash', 32);
  const blob = stream('blob-v1/blob-address', 32);
  return {
    name: 'soladb-blob-v1',
    description:
      'Merkle vectors of docs/blob-protocol.md §2. Hex strings. leafHash = sha256(0x00 ‖ 1024-byte segment), ' +
      'nodeHash = sha256(0x01 ‖ l ‖ r), trees padded with EMPTY (32 zero bytes) to a power of two at the input level. ' +
      'Proofs list siblings bottom-up. In each blob, shards 0..k-1 are arbitrary data and shards k..n-1 are their ' +
      'Reed-Solomon parity (GF(2^8)/0x11D, Cauchy C[i][j] = inv((k+i) xor j)), fragment by fragment. ' +
      'fragments[].proof goes from the fragment root (node `stripe` at height log2(F/1024)) to the shard root; ' +
      'segments[].proof is the prove_shard shard_proof; topProofs[j] is the prove_shard top_proof of shard j. ' +
      'challenge.segment = u64_le(sha256(slotHash ‖ blob ‖ [shardIndex])[0..8]) mod (shardSize / 1024), on blobs[1].',
    segmentSize: SEGMENT_SIZE,
    hashes: {
      empty: hex(EMPTY),
      zero: Array.from({ length: 6 }, (_, h) => hex(zeroHash(h))),
      leaf: { segment: 'byte i = i mod 256', hash: hex(leafHash(segment)) },
      node: { left: hex(leafHash(segment)), right: hex(EMPTY), hash: hex(nodeHash(leafHash(segment), EMPTY)) },
    },
    trees,
    blobs,
    challenge: {
      slotHash: hex(slotHash),
      blob: hex(blob),
      shardIndex: 1,
      shardSize: blobs[1].shardSize,
      segment: challengeSegment(slotHash, blob, 1, blobs[1].shardSize),
    },
  };
}

test('test vectors: sdk/test/vectors/blob-v1.json', () => {
  const vectors = buildVectors();
  // self-check the vectors with the verifiers before comparing
  for (const b of vectors.blobs) {
    const roots = b.shardRoots.map(fromHex);
    for (const [j, top] of b.topProofs.entries()) assert.ok(verifyProof(roots[j], j, top.map(fromHex), fromHex(b.root)));
    for (const f of b.fragments) assert.ok(verifyProof(fromHex(f.root), f.stripe, f.proof.map(fromHex), roots[f.shard]));
    for (const s of b.segments) assert.ok(verifyProof(fromHex(s.leaf), s.segment, s.proof.map(fromHex), roots[s.shard]));
    const shards = b.shards.map(fromHex);
    for (let s = 0; s < b.stripes; s++) {
      const fragments = shards.map((shard) => shard.subarray(s * b.fragmentSize, (s + 1) * b.fragmentSize));
      assert.deepEqual(encodeParity(fragments.slice(0, b.k), b.m), fragments.slice(b.k));
    }
  }
  const c = vectors.challenge;
  const challenged = vectors.blobs[1].segments.find((s) => s.shard === c.shardIndex && s.segment === c.segment)!;
  assert.ok(
    verifyStorageProof({
      segment: fromHex(vectors.blobs[1].shards[c.shardIndex]).subarray(c.segment * 1024, (c.segment + 1) * 1024),
      segmentIndex: c.segment,
      shardProof: challenged.proof.map(fromHex),
      topProof: vectors.blobs[1].topProofs[c.shardIndex].map(fromHex),
      shardIndex: c.shardIndex,
      root: fromHex(vectors.blobs[1].root),
      shardSize: c.shardSize,
      totalShards: 3,
    }),
  );

  const json = JSON.stringify(vectors, null, 2) + '\n';
  if (process.env.SOLADB_WRITE_VECTORS === '1' || !fs.existsSync(VECTORS)) {
    fs.mkdirSync(path.dirname(VECTORS), { recursive: true });
    fs.writeFileSync(VECTORS, json);
    console.log(`wrote ${VECTORS}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(VECTORS, 'utf8')), vectors, 'vectors changed: the Merkle math or the generator moved');
});
