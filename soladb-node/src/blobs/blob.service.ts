import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address } from '@solana/kit';
import {
  BlobAccount,
  blobAccountSize,
  blobProof,
  blobRoot,
  challengedSegment,
  ConfigAccount,
  depth,
  FetchedAccount,
  fragmentProof,
  packHashes,
  rebuildShardFragment,
  rewardBetween,
  segmentProof,
  ShardHasher,
  unpackHashes,
  VACANT,
  verifyFragment,
} from '@soladb/sdk';
import { SolanaService } from '../solana/solana.service';
import { BLOB_STORE, BlobStore } from '../storage/blob-store';
import { StorageService } from '../storage/storage.service';
import { BlobShardRecord } from '../storage/metadata-store';

const SEGMENT = 1024;
/** Pushes not continued for this long are dropped (staged bytes and hashing state) */
const ABANDONED_PUSH_MS = 60 * 60 * 1000;
const MIN_FRAGMENT = 1024;
const MAX_FRAGMENT = 1024 * 1024;
/** Largest body of one PUT /blob/:blob/shard/:index (the SDK sends 8 MiB) */
export const MAX_SHARD_REQUEST = 16 * 1024 * 1024;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

/** Public, verifiable description of a blob this node holds a shard of */
export interface BlobInfo {
  blob: string;
  root: string;
  dataShards: number;
  totalShards: number;
  shardSize: number;
  fragmentSize: number;
  /** Shard roots r_0…r_{n-1} (hex); blobRoot(roots) is the on-chain root */
  roots: string[];
}

export interface PushResult {
  status: 201 | 202 | 200;
  received: number;
  stored?: boolean;
  confirmed?: boolean;
  signature?: string;
  reason?: string;
}

interface Incoming {
  /** Last append (epoch ms) */
  touchedAt: number;
  hasher: ShardHasher;
  roots: Uint8Array[];
  fragmentSize: number;
  shardSize: number;
  received: number;
}

export interface BlobStatus {
  held: number;
  incoming: number;
  totals: {
    pushesStored: number;
    rebuilt: number;
    confirmed: number;
    proofs: number;
    claims: number;
    lamportsClaimed: string;
    challengesSent: number;
    challengesWon: number;
    lost: number;
    errors: number;
  };
  lastError: string | null;
}

/**
 * BlobService
 *
 * The node's side of erasure-coded blobs (docs/blob-protocol.md):
 *
 *   • receives shards pushed by uploaders (resumable appends), checks them
 *     against the shard roots and the on-chain blob root, stores them and
 *     takes the slot with confirm_shard;
 *   • serves fragments with their Merkle proof, so readers verify each
 *     fragment on its own;
 *   • every BLOB_POLL_INTERVAL_MS: answers challenges on the shards it holds
 *     (before their deadline slot), challenges itself and claims its rewards
 *     when enough accrued, drops shards it lost or that expired, rebuilds a
 *     vacant slot of a blob from k other holders, and optionally challenges
 *     other holders (bounty when they fail).
 */
@Injectable()
export class BlobService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BlobService.name);
  private readonly incoming = new Map<string, Incoming>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leafCache = new Map<string, Uint8Array>();
  private leafCacheBytes = 0;
  private heldCount = 0;
  private config: ConfigAccount | null = null;
  private endpoints = new Map<string, string>();
  private endpointsAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private busy = false;
  private lastError: string | null = null;
  private readonly totals = {
    pushesStored: 0,
    rebuilt: 0,
    confirmed: 0,
    proofs: 0,
    claims: 0,
    lamportsClaimed: 0n,
    challengesSent: 0,
    challengesWon: 0,
    lost: 0,
    errors: 0,
  };

  private readonly pollIntervalMs: number;
  private readonly repair: boolean;
  private readonly challengeOthers: boolean;
  private readonly challengeIntervalMs: number;
  private readonly claimMinLamports: bigint;
  private readonly minRewardLamports: bigint;
  private readonly nodeEndpoint: string;
  private readonly leafCacheLimit: number;
  private readonly maxShardBytes: number;
  private lastChallengeRound = 0;

  constructor(
    private readonly solana: SolanaService,
    private readonly storage: StorageService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs = this.configService.get<number>('blobs.pollIntervalMs') ?? 10_000;
    this.repair = this.configService.get<boolean>('blobs.repair') ?? true;
    this.challengeOthers = this.configService.get<boolean>('blobs.challengeOthers') ?? false;
    this.challengeIntervalMs = this.configService.get<number>('blobs.challengeIntervalMs') ?? 600_000;
    this.claimMinLamports = this.configService.get<bigint>('blobs.claimMinLamports') ?? 50_000n;
    this.minRewardLamports = this.configService.get<bigint>('replication.minRewardLamports') ?? 0n;
    this.nodeEndpoint = (this.configService.get<string>('replication.nodeEndpoint') ?? '').replace(/\/$/, '');
    this.leafCacheLimit = this.configService.get<number>('blobs.leafCacheBytes') ?? 256 * 1024 * 1024;
    this.maxShardBytes = this.configService.get<number>('blobs.maxShardBytes') ?? 2 * 1024 * 1024 * 1024;
  }

  onApplicationBootstrap(): void {
    if (this.configService.get<boolean>('blobs.enabled') === false) return;
    this.running = true;
    this.schedule(1_000);
    this.logger.log(
      `BlobService: maintenance every ${this.pollIntervalMs} ms (repair ${this.repair ? 'on' : 'off'}, ` +
        `challenging others ${this.challengeOthers ? 'on' : 'off'})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  get status(): BlobStatus {
    return {
      held: this.heldCount,
      incoming: this.incoming.size,
      totals: { ...this.totals, lamportsClaimed: this.totals.lamportsClaimed.toString() },
      lastError: this.lastError,
    };
  }

  // ── HTTP: pushes ────────────────────────────────────────────────────────────

  /**
   * PUT /blob/:blob/shard/:index?offset=N — append shard bytes.  The first
   * request (offset 0) carries the shard roots and the fragment size; the
   * last one completes the shard, which is verified, stored and confirmed.
   */
  async acceptPush(
    blob: Address,
    index: number,
    offset: number,
    bytes: Buffer,
    header: { roots?: string; fragmentSize?: string },
  ): Promise<PushResult> {
    return this.withLock(this.key(blob, index), () => this._acceptPush(blob, index, offset, bytes, header));
  }

  private async _acceptPush(
    blob: Address,
    index: number,
    offset: number,
    bytes: Buffer,
    header: { roots?: string; fragmentSize?: string },
  ): Promise<PushResult> {
    if (bytes.length > MAX_SHARD_REQUEST) throw new PayloadTooLargeException(`At most ${MAX_SHARD_REQUEST} bytes per request`);
    const account = await this.solana.getBlob(blob, 'confirmed').catch((err) => {
      if (/is not a SolaDB Blob/.test(message(err))) return null;
      throw err;
    });
    if (!account || !(await this.solana.isBlobAddress(blob, account.data))) {
      throw new NotFoundException(`Blob ${blob} does not exist (yet)`);
    }
    const data = account.data;
    if (!this.solana.replicatesOwner(data.owner)) throw new ForbiddenException(`This node does not store blobs of ${data.owner}`);
    if (index >= data.totalShards) throw new BadRequestException(`Shard index ${index} ≥ ${data.totalShards}`);
    const me = this.solana.address;
    const slot = data.slots[index];
    const key = this.key(blob, index);
    if (slot.holder === me) {
      const local = await this.storage.getBlobShard(blob, index);
      if (local && (local.state === 'Confirmed' || local.state === 'Stored')) {
        return { status: 200, received: Number(data.shardSize), stored: true, confirmed: true };
      }
    }
    if (slot.holder !== VACANT && slot.holder !== me) throw new ConflictException(`Shard ${index} already has a holder`);
    const other = data.slots.findIndex((s, i) => s.holder === me && i !== index);
    if (other >= 0) throw new ConflictException(`This node already holds shard ${other} of the blob`);
    if (nowSeconds() >= data.expiresAt) throw new ConflictException('The blob has expired');
    if (data.shardSize > BigInt(this.maxShardBytes)) {
      throw new PayloadTooLargeException(`This node stores shards of at most ${this.maxShardBytes} bytes (BLOB_MAX_SHARD_BYTES)`);
    }

    const shardSize = Number(data.shardSize);
    let state = this.incoming.get(key);
    if (offset === 0) {
      const parts = (header.roots ?? '').split(',').map((r) => r.trim()).filter(Boolean);
      if (parts.some((r) => !/^[0-9a-f]{64}$/i.test(r))) throw new BadRequestException('x-soladb-shard-roots must be 64-character hex roots');
      const roots = parts.map(fromHex);
      if (roots.length !== data.totalShards || roots.some((r) => r.length !== 32)) {
        throw new BadRequestException(`x-soladb-shard-roots must list ${data.totalShards} hex roots`);
      }
      if (hex(blobRoot(roots)) !== hex(data.root)) throw new BadRequestException('The shard roots do not match the blob root');
      const fragmentSize = Number(header.fragmentSize);
      if (!isFragmentSize(fragmentSize, shardSize)) {
        throw new BadRequestException('x-soladb-fragment-size must be a power of two between 1 KiB and 1 MiB dividing the shard');
      }
      await this.blobs.discardStaged(key);
      state = { touchedAt: Date.now(), hasher: new ShardHasher(), roots, fragmentSize, shardSize, received: 0 };
      this.incoming.set(key, state);
    } else if (!state || state.received !== offset) {
      throw new ConflictException(`Expected offset ${state?.received ?? 0}; restart the shard from offset 0`);
    }
    if (offset + bytes.length > shardSize) throw new BadRequestException(`The shard is ${shardSize} bytes`);

    state.received = await this.blobs.stageAppend(key, offset, bytes);
    state.touchedAt = Date.now();
    state.hasher.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (state.received < shardSize) return { status: 202, received: state.received };

    this.incoming.delete(key);
    const root = state.hasher.root();
    if (hex(root) !== hex(state.roots[index])) {
      await this.blobs.discardStaged(key);
      throw new BadRequestException(`Shard ${index} does not hash to its root`);
    }
    await this.commitShard(blob, index, data, state.hasher.leafHashes(), state.roots, state.fragmentSize);
    this.totals.pushesStored++;
    this.logger.log(`Stored shard ${index} of blob ${blob} (${shardSize} bytes) pushed by its uploader`);
    const confirmation = await this.confirm(blob, index, data);
    return { status: 201, received: shardSize, stored: true, ...confirmation };
  }

  // ── HTTP: reads ─────────────────────────────────────────────────────────────

  async info(blob: Address): Promise<BlobInfo> {
    const shards = await this.storage.listBlobShards({ blob, limit: 1 });
    const record = shards[0];
    const packed = await this.blobs.getObject(this.rootsKey(blob));
    if (!record || !packed) throw new NotFoundException(`This node holds no shard of ${blob}`);
    return {
      blob,
      root: record.root,
      dataShards: record.dataShards,
      totalShards: record.totalShards,
      shardSize: record.shardSize,
      fragmentSize: record.fragmentSize ?? 0,
      roots: unpackHashes(new Uint8Array(packed)).map(hex),
    };
  }

  /** One fragment of a shard this node holds, with its proof to the shard root */
  async fragment(blob: Address, index: number, stripe: number): Promise<{ data: Buffer; proof: string[] }> {
    const record = await this.storage.getBlobShard(blob, index);
    if (!record || !record.fragmentSize || (record.state !== 'Confirmed' && record.state !== 'Stored')) {
      throw new NotFoundException(`This node holds no shard ${index} of ${blob}`);
    }
    const stripes = record.shardSize / record.fragmentSize;
    if (!Number.isInteger(stripe) || stripe < 0 || stripe >= stripes) throw new BadRequestException(`Stripe out of range (0–${stripes - 1})`);
    const key = this.key(blob, index);
    const data = await this.blobs.readRange(key, stripe * record.fragmentSize, record.fragmentSize);
    if (!data) throw new NotFoundException(`Shard ${index} of ${blob} is missing`);
    const leaves = await this.leafHashes(key);
    return { data, proof: fragmentProof(leaves, record.fragmentSize / SEGMENT, stripe).map(hex) };
  }

  // ── Maintenance loop ────────────────────────────────────────────────────────

  private schedule(delay = this.pollIntervalMs): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.busy = true;
    try {
      await this.pruneAbandoned();
      this.config = (await this.solana.getConfig()) ?? this.config;
      if (this.config && this.config.epochSeconds > 0n) {
        await this.maintainHoldings();
        if (this.repair) await this.repairOne();
        if (this.challengeOthers && Date.now() - this.lastChallengeRound >= this.challengeIntervalMs) {
          this.lastChallengeRound = Date.now();
          await this.challengeRound();
        }
      }
    } catch (err) {
      this.totals.errors++;
      this.lastError = message(err);
      this.logger.warn(`Blob maintenance failed: ${message(err)}`);
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  /** Answer challenges, prove + claim when due, drop shards lost or expired */
  async maintainHoldings(): Promise<void> {
    const held: BlobShardRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.storage.listBlobShards({ state: 'Confirmed', limit: 500, offset });
      held.push(...page);
      if (page.length < 500) break;
    }
    this.heldCount = held.length;
    if (held.length === 0) return;
    const config = this.config!;
    const me = this.solana.address;
    const slotNow = await this.solana.currentSlot();
    for (let i = 0; i < held.length; i += 100) {
      const batch = held.slice(i, i + 100);
      const accounts = await this.solana.getBlobs(batch.map((r) => r.blob as Address));
      for (let j = 0; j < batch.length; j++) {
        const record = batch[j];
        const blob = record.blob as Address;
        const account = accounts[j];
        try {
          if (!account) {
            await this.drop(record, 'Expired', 'the blob account was closed');
            continue;
          }
          const slot = account.data.slots[record.index];
          if (slot.holder !== me) {
            this.totals.lost++;
            await this.drop(record, 'Lost', 'this node no longer holds the slot (a challenge went unanswered)');
            continue;
          }
          await this.maintainSlot(blob, record.index, account, config, slotNow);
        } catch (err) {
          this.totals.errors++;
          this.lastError = `${blob}#${record.index}: ${message(err)}`;
          this.logger.warn(`Blob ${blob} shard ${record.index}: ${message(err)}`);
        }
      }
    }
  }

  private async maintainSlot(
    blob: Address,
    index: number,
    account: FetchedAccount<BlobAccount>,
    config: ConfigAccount,
    slotNow: bigint,
  ): Promise<void> {
    const data = account.data;
    const slot = data.slots[index];
    const now = nowSeconds();

    // 1. An open challenge: answer once its slot exists, before the deadline
    if (slot.challengeSlot !== 0n) {
      if (slotNow > slot.challengeSlot && slotNow <= slot.challengeDeadline) await this.prove(blob, index, data);
      return;
    }

    // 2. Rewards: they unlock up to the last proof, so prove before claiming
    const until = slot.provenAt < data.expiresAt ? slot.provenAt : data.expiresAt;
    const claimable = rewardBetween(data, config.epochSeconds, slot.claimedUntil, until);
    const end = now < data.expiresAt ? now : data.expiresAt;
    const unproven = rewardBetween(data, config.epochSeconds, slot.provenAt, end);
    const expired = now >= data.expiresAt;
    const cooldownOver = now >= slot.lastChallengeAt + config.challengeCooldown;
    const grace = data.expiresAt + config.epochSeconds;
    // Claim what the last proof unlocked before proving again
    if (claimable > 0n && (claimable >= this.claimMinLamports || expired)) {
      const signature = await this.solana.claimShardRewards(blob, index);
      this.totals.claims++;
      this.totals.lamportsClaimed += claimable;
      await this.storage.updateBlobShard(blob, index, { claimedUntil: new Date(Number(until) * 1000) });
      this.logger.log(`Claimed ${claimable} lamports for shard ${index} of ${blob} in ${signature}`);
      return;
    }
    if ((unproven >= this.claimMinLamports || (expired && slot.provenAt < data.expiresAt)) && cooldownOver && now < grace) {
      await this.solana.createChallenge(blob, index);
      this.logger.log(`Challenged my own shard ${index} of ${blob} to unlock ${unproven} lamports`);
      return; // answered on a later tick, once the challenge slot exists
    }

    // 3. One epoch after expiry the owner may close the blob: nothing left to earn
    if (expired && now >= grace && claimable === 0n) {
      await this.drop((await this.storage.getBlobShard(blob, index))!, 'Expired', 'the blob expired');
    }
  }

  private async prove(blob: Address, index: number, data: BlobAccount): Promise<void> {
    const slot = data.slots[index];
    const hash = await this.solana.getSlotHash(slot.challengeSlot);
    if (!hash) {
      this.logger.warn(`Challenge slot ${slot.challengeSlot} of ${blob}#${index} is not in SlotHashes (yet)`);
      return;
    }
    const segments = data.shardSize / BigInt(SEGMENT);
    const segment = Number(challengedSegment(hash, blob, index, segments));
    const key = this.key(blob, index);
    const bytes = await this.blobs.readRange(key, segment * SEGMENT, SEGMENT);
    const packedRoots = await this.blobs.getObject(this.rootsKey(blob));
    if (!bytes || !packedRoots) throw new Error(`shard ${index} of ${blob} is missing locally; cannot answer the challenge`);
    const leaves = await this.leafHashes(key);
    const roots = unpackHashes(new Uint8Array(packedRoots));
    const signature = await this.solana.proveShard(
      blob,
      index,
      new Uint8Array(bytes),
      segmentProof(leaves, segment),
      blobProof(roots, index),
      blobAccountSize(data.totalShards),
    );
    this.totals.proofs++;
    await this.storage.updateBlobShard(blob, index, { provenAt: new Date() });
    this.logger.log(`Proved shard ${index} of ${blob} (segment ${segment}) in ${signature}`);
  }

  /** Rebuild one vacant slot of a blob that needs holders, from k other holders */
  async repairOne(): Promise<boolean> {
    const me = this.solana.address;
    const now = nowSeconds();
    const candidates = (await this.solana.listBlobsNeedingHolders()).filter((b) => {
      const d = b.data;
      if (now >= d.expiresAt || d.held < d.dataShards || d.shardSize > BigInt(this.maxShardBytes)) return false;
      if (d.slots.some((s) => s.holder === me)) return false;
      const remaining = (d.expiresAt - now) * d.rewardPerShardEpoch / (this.config!.epochSeconds || 1n);
      return remaining >= this.minRewardLamports;
    });
    for (const blob of candidates) {
      const index = blob.data.slots.findIndex((s) => s.holder === VACANT);
      if (index < 0 || this.incoming.has(this.key(blob.address, index))) continue;
      if (await this.storage.getBlobShard(blob.address, index)) continue;
      try {
        await this.withLock(this.key(blob.address, index), () => this.rebuild(blob, index));
        return true;
      } catch (err) {
        this.totals.errors++;
        this.lastError = `${blob.address}#${index}: ${message(err)}`;
        this.logger.warn(`Could not rebuild shard ${index} of ${blob.address}: ${message(err)}`);
      }
    }
    return false;
  }

  private async rebuild(blob: FetchedAccount<BlobAccount>, target: number): Promise<void> {
    const data = blob.data;
    const k = data.dataShards;
    const m = data.totalShards - k;
    const holders = data.slots
      .map((s, i) => ({ index: i, holder: s.holder }))
      .filter((h) => h.holder !== VACANT && h.holder !== this.solana.address);
    const endpoints = await this.holderEndpoints();
    const sources = holders
      .map((h) => ({ ...h, url: endpoints.get(h.holder) }))
      .filter((h): h is { index: number; holder: Address; url: string } => !!h.url && h.url !== this.nodeEndpoint);
    if (sources.length < k) throw new Error(`only ${sources.length} reachable holders, ${k} needed`);

    // Layout and roots from a holder, checked against the on-chain root
    let info: BlobInfo | null = null;
    for (const source of sources) {
      try {
        const response = await fetch(`${source.url}/blob/${blob.address}/info`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const candidate = (await response.json()) as BlobInfo;
        if (!Array.isArray(candidate.roots) || candidate.roots.some((r) => typeof r !== 'string' || !/^[0-9a-f]{64}$/i.test(r))) continue;
        const roots = candidate.roots.map(fromHex);
        if (roots.length === data.totalShards && hex(blobRoot(roots)) === hex(data.root) && isFragmentSize(candidate.fragmentSize, Number(data.shardSize))) {
          info = candidate;
          break;
        }
      } catch {
        // next holder
      }
    }
    if (!info) throw new Error('no holder served a layout matching the blob root');
    const roots = info.roots.map(fromHex);
    const fragmentSize = info.fragmentSize;
    const stripes = Number(data.shardSize) / fragmentSize;

    const key = this.key(blob.address, target);
    await this.blobs.discardStaged(key);
    const hasher = new ShardHasher();
    let received = 0;
    for (let stripe = 0; stripe < stripes; stripe++) {
      const fragments: (Uint8Array | null)[] = new Array(data.totalShards).fill(null);
      let have = 0;
      for (const source of sources) {
        if (have >= k) break;
        const fragment = await this.fetchFragment(source.url, blob.address, source.index, stripe, roots[source.index], fragmentSize, stripes);
        if (fragment) {
          fragments[source.index] = fragment;
          have++;
        }
      }
      if (have < k) throw new Error(`stripe ${stripe}: only ${have} verified fragments, ${k} needed`);
      const rebuilt = rebuildShardFragment(fragments, k, m, target);
      received = await this.blobs.stageAppend(key, received, Buffer.from(rebuilt));
      hasher.update(rebuilt);
    }
    if (hex(hasher.root()) !== hex(roots[target])) {
      await this.blobs.discardStaged(key);
      throw new Error(`rebuilt shard ${target} does not hash to its root`);
    }
    await this.commitShard(blob.address, target, data, hasher.leafHashes(), roots, fragmentSize);
    this.totals.rebuilt++;
    this.logger.log(`Rebuilt shard ${target} of ${blob.address} from ${k} other holders`);
    await this.confirm(blob.address, target, data);
  }

  /** A peer's fragment: exactly `fragmentSize` bytes with a proof of the stripe tree's depth */
  private async fetchFragment(
    url: string,
    blob: Address,
    index: number,
    stripe: number,
    shardRoot: Uint8Array,
    fragmentSize: number,
    stripes: number,
  ): Promise<Uint8Array | null> {
    try {
      const response = await fetch(`${url}/blob/${blob}/shard/${index}/fragment/${stripe}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return null;
      const header = (response.headers.get('x-soladb-proof') ?? '').split(',').filter(Boolean);
      if (header.length !== depth(stripes) || header.some((h) => !/^[0-9a-f]{64}$/i.test(h))) return null;
      const fragment = new Uint8Array(await response.arrayBuffer());
      if (fragment.length !== fragmentSize) return null;
      return verifyFragment(fragment, stripe, header.map(fromHex), shardRoot) ? fragment : null;
    } catch {
      return null;
    }
  }

  /** Challenge one random slot held by another replicator; report it if the last one went unanswered */
  async challengeRound(): Promise<void> {
    const me = this.solana.address;
    const slotNow = await this.solana.currentSlot();
    const blobs = await this.solana.listBlobs();
    // report challenges that expired
    for (const blob of blobs) {
      for (let i = 0; i < blob.data.slots.length; i++) {
        const s = blob.data.slots[i];
        if (s.holder !== VACANT && s.holder !== me && s.challengeSlot !== 0n && slotNow > s.challengeDeadline) {
          try {
            await this.solana.failChallenge(blob.address, i);
            this.totals.challengesWon++;
            this.logger.log(`Reported the unanswered challenge of ${blob.address}#${i} (holder ${s.holder})`);
          } catch (err) {
            this.logger.debug(`fail_challenge ${blob.address}#${i}: ${message(err)}`);
          }
        }
      }
    }
    const now = nowSeconds();
    const targets = blobs.flatMap((b) =>
      b.data.slots
        .map((s, i) => ({ blob: b.address, index: i, slot: s }))
        .filter(
          (t) =>
            t.slot.holder !== VACANT &&
            t.slot.holder !== me &&
            t.slot.challengeSlot === 0n &&
            now >= t.slot.lastChallengeAt + this.config!.challengeCooldown &&
            now < b.data.expiresAt,
        ),
    );
    if (targets.length === 0) return;
    const pick = targets[Math.floor(Math.random() * targets.length)];
    await this.solana.createChallenge(pick.blob, pick.index);
    this.totals.challengesSent++;
    this.logger.log(`Challenged ${pick.blob}#${pick.index} (holder ${pick.slot.holder})`);
  }

  /** Drop pushes nobody continued (a client that went away mid-shard) */
  private async pruneAbandoned(): Promise<void> {
    const cutoff = Date.now() - ABANDONED_PUSH_MS;
    for (const [key, state] of this.incoming) {
      if (state.touchedAt < cutoff) this.incoming.delete(key);
    }
    const dropped = await this.blobs.pruneStaged(ABANDONED_PUSH_MS);
    if (dropped.length > 0) this.logger.log(`Dropped ${dropped.length} abandoned shard upload(s)`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async commitShard(
    blob: Address,
    index: number,
    data: BlobAccount,
    leafHashes: Uint8Array,
    roots: Uint8Array[],
    fragmentSize: number,
  ): Promise<void> {
    const key = this.key(blob, index);
    await this.blobs.putObject(`${key}.leaves`, Buffer.from(leafHashes));
    await this.blobs.putObject(this.rootsKey(blob), Buffer.from(packHashes(roots)));
    await this.blobs.commit(key);
    this.cacheLeaves(key, leafHashes);
    await this.storage.upsertBlobShard({
      blob,
      index,
      owner: data.owner,
      root: hex(data.root),
      shardRoot: hex(roots[index]),
      shardSize: Number(data.shardSize),
      dataShards: data.dataShards,
      totalShards: data.totalShards,
      fragmentSize,
      state: 'Stored',
      storedAt: new Date(),
      confirmedAt: null,
      confirmSignature: null,
      provenAt: null,
      claimedUntil: null,
      expiresAt: new Date(Number(data.expiresAt) * 1000),
    });
  }

  /** confirm_shard unless this node may not (inactive, reward too low); the data is kept either way */
  private async confirm(blob: Address, index: number, data: BlobAccount): Promise<{ confirmed: boolean; signature?: string; reason?: string }> {
    const replicator = await this.solana.getReplicator('confirmed');
    if (!replicator) return { confirmed: false, reason: 'this node is not a registered replicator' };
    if (!replicator.active) return { confirmed: false, reason: "this node's Replicator account is inactive" };
    try {
      const signature = await this.solana.confirmShard(blob, index);
      this.totals.confirmed++;
      const now = new Date();
      await this.storage.updateBlobShard(blob, index, {
        state: 'Confirmed',
        confirmedAt: now,
        confirmSignature: signature,
        provenAt: now,
        claimedUntil: now,
      });
      this.logger.log(`Confirmed shard ${index} of ${blob} in ${signature}`);
      return { confirmed: true, signature };
    } catch (err) {
      this.logger.warn(`confirm_shard ${blob}#${index} failed: ${message(err)}`);
      return { confirmed: false, reason: message(err) };
    }
  }

  private async drop(record: BlobShardRecord, state: 'Lost' | 'Expired', why: string): Promise<void> {
    const key = this.key(record.blob as Address, record.index);
    await this.blobs.delete(key).catch(() => undefined);
    await this.blobs.delete(`${key}.leaves`).catch(() => undefined);
    this.uncacheLeaves(key);
    await this.storage.updateBlobShard(record.blob, record.index, { state });
    this.logger.log(`Dropped shard ${record.index} of ${record.blob}: ${why}`);
  }

  private async leafHashes(key: string): Promise<Uint8Array> {
    const cached = this.leafCache.get(key);
    if (cached) {
      // refresh LRU position
      this.leafCache.delete(key);
      this.leafCache.set(key, cached);
      return cached;
    }
    const stored = await this.blobs.getObject(`${key}.leaves`);
    if (!stored) throw new NotFoundException(`Leaf hashes of ${key} are missing`);
    const leaves = new Uint8Array(stored);
    this.cacheLeaves(key, leaves);
    return leaves;
  }

  private cacheLeaves(key: string, leaves: Uint8Array): void {
    this.uncacheLeaves(key);
    this.leafCache.set(key, leaves);
    this.leafCacheBytes += leaves.length;
    for (const [k, v] of this.leafCache) {
      if (this.leafCacheBytes <= this.leafCacheLimit || k === key) break;
      this.leafCache.delete(k);
      this.leafCacheBytes -= v.length;
    }
  }

  private uncacheLeaves(key: string): void {
    const old = this.leafCache.get(key);
    if (old) {
      this.leafCacheBytes -= old.length;
      this.leafCache.delete(key);
    }
  }

  private async holderEndpoints(): Promise<Map<string, string>> {
    if (Date.now() - this.endpointsAt > 60_000) {
      const replicators = await this.solana.listReplicators();
      this.endpoints = new Map(replicators.filter((r) => r.active).map((r) => [r.authority, r.endpoint.replace(/\/$/, '')]));
      this.endpointsAt = Date.now();
    }
    return this.endpoints;
  }

  private key(blob: string, index: number): string {
    return `${blob}/${index}`;
  }

  private rootsKey(blob: string): string {
    return `${blob}/roots`;
  }

  /** Serialize work on one shard (a push and a repair never interleave) */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) await this.locks.get(key)!.catch(() => undefined);
    const promise = work();
    this.locks.set(key, promise);
    try {
      return await promise;
    } finally {
      this.locks.delete(key);
    }
  }
}

function isFragmentSize(fragmentSize: number, shardSize: number): boolean {
  return (
    Number.isInteger(fragmentSize) &&
    fragmentSize >= MIN_FRAGMENT &&
    fragmentSize <= MAX_FRAGMENT &&
    (fragmentSize & (fragmentSize - 1)) === 0 &&
    shardSize % fragmentSize === 0
  );
}
