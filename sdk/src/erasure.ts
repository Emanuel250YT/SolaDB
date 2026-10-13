/**
 * Systematic Reed-Solomon over GF(2^8) (docs/blob-protocol.md §3 step 4).
 *
 * Field: primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), generator 2,
 * addition is XOR.  Parity fragment `k + i` is `Σ_j C[i][j] · data_j` with the
 * Cauchy matrix `C[i][j] = inv((k + i) ⊕ j)`; any `k` of the `n = k + m`
 * fragments of a stripe recover it, since every square submatrix of a Cauchy
 * matrix is invertible.
 */

export const GF_POLYNOMIAL = 0x11d;

/** EXP[i] = 2^i, doubled so EXP[LOG[a] + LOG[b]] needs no reduction */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
const INV = new Uint8Array(256);
/** GF_MUL[a·256 + b] = a·b: row `a` is the 256-entry "multiply by a" table */
const MUL = new Uint8Array(65536);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_POLYNOMIAL;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  for (let a = 1; a < 256; a++) {
    INV[a] = EXP[255 - LOG[a]];
    for (let b = 1; b < 256; b++) MUL[(a << 8) | b] = EXP[LOG[a] + LOG[b]];
  }
}

export function gfMul(a: number, b: number): number {
  return MUL[((a & 0xff) << 8) | (b & 0xff)];
}

export function gfInv(a: number): number {
  if ((a & 0xff) === 0 || a !== (a & 0xff)) throw new Error(`No inverse for ${a} in GF(256)`);
  return INV[a];
}

export function gfDiv(a: number, b: number): number {
  return gfMul(a, gfInv(b));
}

/** 2^e (e any integer ≥ 0) */
export function gfExp(e: number): number {
  return EXP[e % 255];
}

/** Discrete log base 2 of a non-zero element */
export function gfLog(a: number): number {
  if ((a & 0xff) === 0 || a !== (a & 0xff)) throw new Error(`No logarithm for ${a} in GF(256)`);
  return LOG[a];
}

function checkShape(k: number, m: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > 256) {
    throw new Error(`Invalid erasure code ${k}+${m}`);
  }
}

/** `m` rows of `k` coefficients: C[i][j] = inv((k + i) ⊕ j) */
export function cauchyMatrix(k: number, m: number): Uint8Array[] {
  checkShape(k, m);
  return Array.from({ length: m }, (_, i) => Uint8Array.from({ length: k }, (_, j) => INV[(k + i) ^ j]));
}

/** Coefficients of fragment `index` over the data fragments (identity row or Cauchy row) */
function generatorRow(k: number, index: number): Uint8Array {
  if (index < k) {
    const row = new Uint8Array(k);
    row[index] = 1;
    return row;
  }
  return Uint8Array.from({ length: k }, (_, j) => INV[index ^ j]);
}

const row = (c: number) => MUL.subarray(c << 8, (c << 8) + 256);

/**
 * out = Σ coeffs[t] · sources[t], byte by byte.  Sources are combined four at
 * a time so `out` is read and written once per group.
 */
function combine(coeffs: ArrayLike<number>, sources: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let t = 0;
  for (; t + 4 <= sources.length; t += 4) {
    const [s0, s1, s2, s3] = [sources[t], sources[t + 1], sources[t + 2], sources[t + 3]];
    const [r0, r1, r2, r3] = [row(coeffs[t]), row(coeffs[t + 1]), row(coeffs[t + 2]), row(coeffs[t + 3])];
    for (let x = 0; x < length; x++) out[x] ^= r0[s0[x]] ^ r1[s1[x]] ^ r2[s2[x]] ^ r3[s3[x]];
  }
  for (; t < sources.length; t++) {
    const s = sources[t];
    const r = row(coeffs[t]);
    for (let x = 0; x < length; x++) out[x] ^= r[s[x]];
  }
  return out;
}

/** The `m` parity fragments of `k` equal-length data fragments */
export function encodeParity(data: readonly Uint8Array[], m: number): Uint8Array[] {
  const k = data.length;
  checkShape(k, m);
  const length = data[0].length;
  if (data.some((d) => d.length !== length)) throw new Error('Data fragments must have the same length');
  return cauchyMatrix(k, m).map((coeffs) => combine(coeffs, data, length));
}

/** Gauss-Jordan inverse of a k×k matrix (row-major) */
function invert(matrix: Uint8Array, k: number): Uint8Array {
  const a = matrix.slice();
  const inv = new Uint8Array(k * k);
  for (let i = 0; i < k; i++) inv[i * k + i] = 1;
  for (let col = 0; col < k; col++) {
    let pivot = col;
    while (pivot < k && a[pivot * k + col] === 0) pivot++;
    if (pivot === k) throw new Error('Singular matrix');
    if (pivot !== col) {
      for (let x = 0; x < k; x++) {
        [a[col * k + x], a[pivot * k + x]] = [a[pivot * k + x], a[col * k + x]];
        [inv[col * k + x], inv[pivot * k + x]] = [inv[pivot * k + x], inv[col * k + x]];
      }
    }
    const scale = row(INV[a[col * k + col]]);
    for (let x = 0; x < k; x++) {
      a[col * k + x] = scale[a[col * k + x]];
      inv[col * k + x] = scale[inv[col * k + x]];
    }
    for (let r = 0; r < k; r++) {
      const factor = a[r * k + col];
      if (r === col || factor === 0) continue;
      const f = row(factor);
      for (let x = 0; x < k; x++) {
        a[r * k + x] ^= f[a[col * k + x]];
        inv[r * k + x] ^= f[inv[col * k + x]];
      }
    }
  }
  return inv;
}

/**
 * Fragments `targets` (data or parity indices) from any `k` present ones.
 * Present targets are returned as they are; one matrix inversion serves all
 * missing ones.
 */
function recover(fragments: readonly (Uint8Array | null | undefined)[], k: number, m: number, targets: readonly number[]): Uint8Array[] {
  checkShape(k, m);
  const n = k + m;
  if (fragments.length !== n) throw new Error(`Expected ${n} fragment slots, got ${fragments.length}`);
  for (const t of targets) {
    if (!Number.isInteger(t) || t < 0 || t >= n) throw new Error(`Fragment index ${t} out of range`);
  }
  const present = fragments.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
  const length = fragments[present[0] ?? 0]?.length ?? 0;
  if (present.some((i) => fragments[i]!.length !== length)) throw new Error('Fragments must have the same length');
  if (targets.every((t) => fragments[t])) return targets.map((t) => fragments[t]!);
  if (present.length < k) throw new Error(`Need ${k} fragments to recover, only ${present.length} present`);

  // data fragments first (identity rows), then parity
  const sources = present.slice(0, k);
  const systematic = sources.every((s, i) => s === i);
  let inverse: Uint8Array | null = null;
  if (!systematic) {
    const a = new Uint8Array(k * k);
    sources.forEach((s, r) => a.set(generatorRow(k, s), r * k));
    inverse = invert(a, k);
  }
  const sourceBytes = sources.map((s) => fragments[s]!);
  return targets.map((t) => {
    const existing = fragments[t];
    if (existing) return existing;
    const g = generatorRow(k, t);
    if (!inverse) return combine(g, sourceBytes, length);
    // target = g · data = g · A⁻¹ · sources
    const coeffs = new Uint8Array(k);
    for (let r = 0; r < k; r++) {
      if (g[r] === 0) continue;
      const gr = row(g[r]);
      for (let c = 0; c < k; c++) coeffs[c] ^= gr[inverse[r * k + c]];
    }
    return combine(coeffs, sourceBytes, length);
  });
}

/**
 * The `k` data fragments of a stripe from any `k` of its `n = k + m`
 * fragments (`null` = missing).  Present data fragments are returned as they are.
 */
export function reconstruct(fragments: readonly (Uint8Array | null | undefined)[], k: number, m: number): Uint8Array[] {
  return recover(
    fragments,
    k,
    m,
    Array.from({ length: k }, (_, j) => j),
  );
}

/**
 * Any single fragment (data or parity) from any `k` present ones: what a node
 * rebuilding a lost shard computes, stripe by stripe.  Returns the fragment
 * itself when it is present.
 */
export function rebuildShardFragment(
  fragments: readonly (Uint8Array | null | undefined)[],
  k: number,
  m: number,
  targetIndex: number,
): Uint8Array {
  return recover(fragments, k, m, [targetIndex])[0];
}

/** Several fragments at once (one matrix inversion) */
export function rebuildFragments(
  fragments: readonly (Uint8Array | null | undefined)[],
  k: number,
  m: number,
  targetIndices: readonly number[],
): Uint8Array[] {
  return recover(fragments, k, m, targetIndices);
}
