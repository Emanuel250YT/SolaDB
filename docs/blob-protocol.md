# SolaDB blobs: erasure-coded storage with storage proofs

A **blob** stores a large payload as `n = k + m` erasure-coded shards spread over
`n` replicator nodes, with **one** on-chain account per blob (a Merkle root),
time-based payments and challenge/response storage proofs. It complements the
chunk paths (ledger chunks, direct chunks), which keep working.

Why: with chunks, 1 TB needs ~119 000 accounts (~216 SOL of temporary rent) and
~20 000 wallet transactions, and every replica is a full copy. A blob needs one
account and one transaction, stores 1.4× the data with Reed-Solomon 10+4
instead of 2–3×, and tolerates `m` lost nodes.

Everything below is normative: the SDK (TypeScript), the node (TypeScript, reusing
the SDK) and the program (Rust) must agree byte for byte.

## 1. Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `SEGMENT_SIZE` | 1024 | bytes per Merkle leaf (and per storage-proof answer) |
| `MAX_SHARDS` | 32 | `n = k + m ≤ 32`, `k ≥ 1`, `m ≥ 0` |
| `MIN_FRAGMENT` / `MAX_FRAGMENT` | 1 KiB / 1 MiB | fragment size `F`, a power of two |
| `ENCRYPTION_OVERHEAD` | 28 | AES-256-GCM: 12-byte nonce + 16-byte tag (SDK `encryptBytes` layout) |
| `CHALLENGE_DELAY_SLOTS` | 2 | a challenge's randomness is the hash of a slot not yet produced |

## 2. Merkle trees

- `EMPTY` = 32 zero bytes.
- `leafHash(segment) = sha256(0x00 ‖ segment)` (segment is exactly 1024 bytes).
- `nodeHash(l, r) = sha256(0x01 ‖ l ‖ r)`.
- `rootOfNodes(nodes)`: pad `nodes` to the next power of two with `EMPTY`, then
  pair adjacent nodes with `nodeHash` level by level until one node is left. One
  node is its own root (depth 0). Padding happens once, at the input level.
- **Shard root** `r_j = rootOfNodes(segments(shard_j).map(leafHash))`. Shards
  are always a multiple of 1024 bytes.
- **Blob root** `R = rootOfNodes([r_0, …, r_{n-1}])` (shard roots are used as
  nodes directly, no extra leaf hashing).
- **Proof** for node index `i` in a tree whose input level has `N` nodes
  (padded to `P = 2^d`): the `d` siblings bottom-up. Verify: `h = node`; for
  level `ℓ = 0..d-1`: if `(i >> ℓ) & 1 == 0` then `h = nodeHash(h, sib_ℓ)` else
  `h = nodeHash(sib_ℓ, h)`; accept if `h == root`.
- `depth(N) = ceil(log2(N))` (0 for N = 1).
- **Fragment proofs.** `F = 2^a · 1024`, so fragment `s` of shard `j` covers
  leaves `[s·2^a, (s+1)·2^a)`, an aligned subtree. Its root is
  `rootOfNodes(its 2^a leaf hashes)`; its proof to `r_j` is the sibling path of
  node index `s` at level `a` of the shard tree (depth `depth(N) − a`), computed
  on the padded tree (padding leaves are `EMPTY`, so padded subtrees hash to
  `Z_h`, with `Z_0 = EMPTY`, `Z_{h+1} = nodeHash(Z_h, Z_h)`).

## 3. Payload → stripes → shards

1. **Payload**: the file bytes, gzip-compressed first when that saves ≥ 10 %
   (SDK `maybeCompress`). A *bundle* payload packs many small files (§6).
2. **Stripes**: capacity `C = k·F − 28`. The payload is cut into stripes of `C`
   bytes (the last one shorter, at least 1 byte; an empty payload is one empty
   stripe). Stripe `s` ciphertext = `encryptBytes(dek, plain_s)` (fresh random
   nonce each time), right-padded with zeros to exactly `k·F` bytes.
3. **Data fragments**: stripe ciphertext split into `k` consecutive `F`-byte
   fragments, `frag(s, j)` for `j < k`.
4. **Parity fragments** `j = k … n−1`: systematic Reed-Solomon over GF(2^8),
   primitive polynomial `0x11D`, generator 2. For every byte position `x`:
   `frag(s, k+i)[x] = Σ_{j<k} C[i][j] · frag(s, j)[x]` with the Cauchy matrix
   `C[i][j] = inv(X_i ⊕ Y_j)`, `X_i = k + i`, `Y_j = j` (field addition is XOR).
   Any `k` of the `n` fragments of a stripe recover it (invert the `k×k`
   matrix made of the identity rows of the data fragments you hold and the
   Cauchy rows of the parity fragments you hold).
5. **Shard** `j` = `frag(0, j) ‖ frag(1, j) ‖ … ‖ frag(stripes−1, j)`, length
   `shard_size = stripes · F`.
6. Shard roots, blob root as in §2. Blob address = PDA
   `["blob", owner, R]`.

Large files are split into several blobs of at most `stripesPerBlob` stripes
(SDK default: `F = 1 MiB`, ≤ 1024 stripes → shards ≤ 1 GiB); the payload is
consumed in order, blob after blob.

## 4. File manifest v3 (sealed in the Record, like v2)

Little endian:

```
u8  version = 3
u8  flags            GZIP 4, BUNDLE 8
u64 size             plaintext file size (bundle: payload size before compression)
u32 createdAt
[32] sha256          of the plaintext (bundle: of the uncompressed bundle payload)
[32] dek
u8  nameLen, name    (≤ 200 bytes)
u8  mimeLen, mime    (≤ 100 bytes)
u64 payloadSize      bytes after compression, before encryption
u8  k, u8 m
u32 fragmentSize
u16 blobCount
blobCount × ([32] root, u32 stripes)
```

Records stay ≤ 2048 bytes, so a file has at most 48 blobs. Record schema:
`soladb.file.v3`.

## 5. Program

### Config (new fields)

`epoch_seconds` (i64, storage is paid per epoch), `price_per_mib_epoch` (u64,
lamports per MiB of shard per epoch), `challenge_window_slots` (u64, ≤ 450:
slots to answer after the challenge's target slot; must stay inside the 512
entries of SlotHashes), `challenge_cooldown` (i64 seconds between challenges
of one slot), `challenger_bounty_bps` (u16, share of forfeited rewards paid to
whoever reports a failed challenge).

### Blob account (PDA `["blob", owner, root]`)

```
owner Pubkey | root [32] | state u8 (0 Hot, 1 Cool, 2 Expired) | needs_holders bool
bump u8 | data_shards u8 (k) | total_shards u8 (n) | held u8
shard_size u64 | payload_size u64 | epochs u32 | reward_per_shard_epoch u64
opened_at i64 | expires_at i64 | slots: Vec<ShardSlot> (len n)

ShardSlot: holder Pubkey (default = vacant) | proven_at i64 | claimed_until i64
           last_challenge_at i64 | challenge_slot u64 (0 = none) | challenge_deadline u64 (slot)
```

`needs_holders` sits at byte offset 73 (discriminator 8 + owner 32 + root 32 +
state 1), so nodes can find work with one memcmp.

### Fee

`fee = n · (base_fee_per_replica + ⌈shard_size · price_per_mib_epoch · epochs / 2^20⌉)`.
Protocol share `fee · protocol_fee_bps / 10 000` goes to the treasury, the
rest is escrowed in the blob account; `reward_per_shard_epoch =
⌊escrow / (n · epochs)⌋` (dust to the protocol).

### Instructions

- `open_blob(root, data_shards, total_shards, shard_size, payload_size, epochs, max_fee)`
  — owner with an identity; state Hot, `needs_holders = true`, `expires_at =
  now + epochs · epoch_seconds`.
- `confirm_shard(index)` — an active replicator takes vacant slot `index`
  (one slot per replicator per blob): `proven_at = claimed_until = now`.
  `held ≥ k` → Cool; `held == n` → `needs_holders = false`.
- `create_challenge(index)` — anyone; slot held, no open challenge, cooldown
  elapsed. `challenge_slot = current slot + CHALLENGE_DELAY_SLOTS`,
  `challenge_deadline = challenge_slot + challenge_window_slots`.
- `prove_shard(index, segment[1024], shard_proof, top_proof)` — anyone (only a
  holder of the data can), once `challenge_slot` has passed and before the
  deadline. Segment index = `u64_le(sha256(slot_hash(challenge_slot) ‖ blob ‖
  [index])[0..8]) mod (shard_size / 1024)`. Verifies `leafHash(segment)` →
  `r_index` (`shard_proof`, depth `depth(shard_size/1024)`) → `R`
  (`top_proof`, depth `depth(n)`). Success: `proven_at = now`, challenge cleared.
  Needs the SlotHashes sysvar account.
- `fail_challenge(index)` — anyone, after the deadline: the slot is vacated, its
  unclaimed rewards are forfeited (`challenger_bounty_bps` of them to the
  caller, the rest stays in escrow), `needs_holders = true`, `held −= 1`
  (below `k` → Hot).
- `claim_shard_rewards(index)` — the holder is paid
  `reward_per_shard_epoch · (min(proven_at, expires_at) − claimed_until) / epoch_seconds`;
  `claimed_until` moves forward. Rewards unlock only up to the last proof.
- `extend_blob(epochs, max_fee)` — owner, before expiry, at the blob's own rate.
- `close_blob` — owner: after `expires_at + epoch_seconds` (grace to claim),
  or when nobody holds a shard and it was opened more than 10 minutes ago.
  Rent and unspent escrow go back to the owner.

## 6. Bundles (many small files in one blob)

Payload = `u32 entryCount | entries | file bytes…` where each entry is
`u8 nameLen, name | u8 mimeLen, mime | u64 offset | u64 length | [32] sha256`
(offsets relative to the start of the file bytes). The manifest sets
`BUNDLE`; its `name` is the bundle name. One account and one record for any
number of files.

## 7. Node HTTP API for blobs

- `PUT /blob/:blob/shard/:index?offset=<bytes>` — append shard bytes (resumable;
  `offset` must equal the bytes already received). Headers on the first
  request: `x-soladb-shard-roots: <n hex roots, comma separated>`. When the
  shard is complete the node checks `r_index` and the roots against the
  on-chain `R`, stores it and sends `confirm_shard`. Responses: `202
  {received}`, `201 {stored, confirmed, signature?}`, `400/404/409/413` like
  chunk pushes.
- `GET /blob/:blob/roots` — the `n` shard roots (hex), verifiable against `R`.
- `GET /blob/:blob/shard/:index/fragment/:stripe` — the fragment bytes;
  header `x-soladb-proof: <hex siblings, comma separated>` = its fragment proof
  to `r_index`.
- Nodes rebuild vacant slots from any `k` other shards (fragment by fragment),
  answer challenges on their slots, claim rewards, and may challenge others.
