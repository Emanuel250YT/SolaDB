import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Address } from '@solana/kit';
import {
  SOLADB_ERRORS,
  ChunkAccount,
  FetchedAccount,
  ReplicatorAccount,
} from '@soladb/sdk';
import { SolanaService } from '../solana/solana.service';
import { StorageService } from '../storage/storage.service';
import {
  chunkRecordFromAccount,
  ChunkStateUpdate,
  stateUpdateFromAccount,
  toHex,
} from '../storage/metadata-store';
import { BackoffSummary, ChunkBackoff } from './backoff';

/** Program errors meaning there is nothing left for this node to do */
const SETTLED_ERRORS = new Map<number, string>([
  [SOLADB_ERRORS.AlreadyReplicated, 'AlreadyReplicated'],
  [SOLADB_ERRORS.FullyReplicated, 'FullyReplicated'],
  [SOLADB_ERRORS.ReplicationClosed, 'ReplicationClosed'],
]);

/**
 * After a confirmation, a scan at "finalized" keeps listing the chunk without
 * this node for ~32 slots; it is skipped for this long instead of sending a
 * confirmation the program would reject.
 */
export const SETTLED_TTL_MS = 120_000;

/** Longest delay between scans after repeated scan failures */
const MAX_SCAN_BACKOFF_MS = 30_000;

export interface ScanStats {
  /** Chunks that still need replicas */
  seen: number;
  /** Of those, chunks this node works on now (unconfirmed, or confirmed but not yet verified locally) */
  candidates: number;
  /** Rebuilt from the ledger and stored */
  stored: number;
  /** confirm_replication transactions that landed */
  confirmed: number;
  /** Left unconfirmed: low reward, replicator missing / inactive, nothing to do */
  skipped: number;
  errors: number;
}

export interface ReplicatorStatus {
  running: boolean;
  pollIntervalMs: number;
  scans: number;
  lastScanAt: string | null;
  lastScanMs: number | null;
  lastScan: ScanStats | null;
  /** Since the node started (lamports as a string) */
  totals: { stored: number; confirmed: number; skipped: number; errors: number; lamportsEarned: string };
  inFlight: number;
  lastError: string | null;
  /** Chunks waiting out a retry delay, by failure kind */
  backoff: BackoffSummary;
}

const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const syncKey = (c: ChunkAccount) => `${c.state}:${c.confirmedReplicas}:${c.reclaimed}`;

/** Best-paid chunks first, then the oldest */
function byPriority(a: FetchedAccount<ChunkAccount>, b: FetchedAccount<ChunkAccount>): number {
  if (a.data.rewardPerReplica !== b.data.rewardPerReplica) {
    return a.data.rewardPerReplica > b.data.rewardPerReplica ? -1 : 1;
  }
  return Number(a.data.completedAt - b.data.completedAt);
}

/**
 * ReplicatorService
 *
 * Core replicator logic.  Every POLL_INTERVAL_MS it lists the Chunk accounts
 * that still need replicas (getProgramAccounts filtered on `needs_replicas`,
 * read at SOLANA_COMMITMENT) — there is no event log or cursor to keep — and
 * works on every chunk this node has not confirmed yet, REPLICATION_CONCURRENCY
 * at a time:
 *
 *   a) Rebuild the chunk from its write_segment transactions in the ledger
 *      and check its sha256 (skipped when a verified copy is already stored)
 *   b) Store the bytes (chunk store, keyed by chunk address) + metadata
 *   c) Send confirm_replication — the program pays the chunk's reward to this
 *      node in the same transaction — unless the reward is below
 *      MIN_REWARD_LAMPORTS or this node's Replicator account is missing or
 *      inactive (the data is kept either way)
 *
 * AlreadyReplicated / FullyReplicated / ReplicationClosed mean there is
 * nothing left to do.  Other failures are logged and retried with a per-chunk
 * backoff (invalid ledger data: 1 h; missing segments, RPC or transaction
 * errors: 10 s doubling up to 10 min).  The loop never stops on an error.
 *
 * Local metadata (state, confirmations) is refreshed from every scan, after
 * each confirmation, when a stored chunk leaves the needs-replicas set, and
 * once per run for records left Hot while the node was down.
 */
@Injectable()
export class ReplicatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReplicatorService.name);

  /** Chunks being rebuilt / confirmed right now */
  private readonly inFlight = new Set<string>();
  /** Chunks with nothing left to do, until the scan shows it (epoch ms) */
  private readonly settled = new Map<string, number>();
  /** Chunks whose local copy this process wrote or verified */
  private readonly verified = new Set<string>();
  /** Replication state last written to the metadata store, per chunk */
  private readonly synced = new Map<string, string>();
  /** Skip reason already logged, per chunk */
  private readonly skipLogged = new Map<string, string>();
  /** Per-chunk retry schedule after failures */
  readonly backoff = new ChunkBackoff();
  /** Chunk addresses returned by the previous scan */
  private previousScan = new Set<string>();
  /** Local records were checked against the chain once this run */
  private reconciled = false;
  private replicatorState: 'missing' | 'inactive' | 'active' | null = null;

  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly minRewardLamports: bigint;
  private readonly nodeEndpoint: string;
  private readonly updateEndpointOnStart: boolean;

  private running = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  private scans = 0;
  private lastScanAt: Date | null = null;
  private lastScanMs: number | null = null;
  private lastScan: ScanStats | null = null;
  private lastError: string | null = null;
  private readonly totals = { stored: 0, confirmed: 0, skipped: 0, errors: 0, lamportsEarned: 0n };

  constructor(
    private readonly solana: SolanaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    this.pollIntervalMs = this.config.get<number>('replication.pollIntervalMs');
    this.concurrency = Math.max(1, this.config.get<number>('replication.concurrency'));
    this.minRewardLamports = this.config.get<bigint>('replication.minRewardLamports') ?? 0n;
    this.nodeEndpoint = this.config.get<string>('replication.nodeEndpoint');
    this.updateEndpointOnStart = this.config.get<boolean>('replication.updateEndpointOnStart') ?? false;
  }

  async onApplicationBootstrap(): Promise<void> {
    const me = this.solana.address;
    const replicator = await this.solana.getReplicator();

    if (!replicator) {
      this.logger.warn(
        `${me} is not a registered replicator — chunks will be stored locally but not ` +
        `confirmed on-chain (the SolaDB admin must run register_replicator)`,
      );
    } else {
      if (!replicator.active) {
        this.logger.warn(`Replicator ${me} is inactive — chunks will be stored but not confirmed`);
      }
      this.logger.log(
        `Replicator ${me}: endpoint ${replicator.endpoint}, ${replicator.confirmations} confirmations, ` +
        `${replicator.lamportsEarned} lamports earned`,
      );
      await this._syncEndpoint(replicator);
    }
    this._checkReplicator(replicator);

    this.start();
    this.logger.log(`ReplicatorService scanning chunks that need replicas every ${this.pollIntervalMs} ms`);
  }

  // ── Scan loop ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this._run();
  }

  /** Stop scanning; resolves once the current scan finished its in-flight chunks */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
  }

  private async _run(): Promise<void> {
    let backoff = this.pollIntervalMs;
    while (this.running) {
      let delay = this.pollIntervalMs;
      try {
        await this.scanOnce();
        backoff = this.pollIntervalMs;
      } catch (err) {
        backoff = Math.min(Math.max(backoff * 2, 1000), Math.max(MAX_SCAN_BACKOFF_MS, this.pollIntervalMs));
        delay = backoff;
        this.lastError = message(err);
        this.totals.errors++;
        this.logger.error(`Chunk scan failed: ${message(err)} — retrying in ${delay} ms`);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, delay);
      });
    }
  }

  /**
   * One pass: list the chunks that need replicas and work on the ones this
   * node has not confirmed.  Throws only when the scan itself fails (RPC);
   * per-chunk failures are counted and backed off.
   */
  async scanOnce(): Promise<ScanStats> {
    const started = Date.now();
    const stats: ScanStats = { seen: 0, candidates: 0, stored: 0, confirmed: 0, skipped: 0, errors: 0 };
    const me = this.solana.address;

    const [chunks, replicator] = await Promise.all([
      this.solana.listChunksNeedingReplicas(),
      this.solana.getReplicator(),
    ]);
    stats.seen = chunks.length;
    this._checkReplicator(replicator);

    const now = Date.now();
    const current = new Set<string>(chunks.map((c) => c.address));
    for (const [chunk, at] of this.settled) {
      if (now - at > SETTLED_TTL_MS) this.settled.delete(chunk);
    }
    for (const chunk of this.skipLogged.keys()) {
      if (!current.has(chunk)) this.skipLogged.delete(chunk);
    }
    this.backoff.retain(current);

    const candidates: FetchedAccount<ChunkAccount>[] = [];
    for (const chunk of chunks) {
      if (chunk.data.replicators.includes(me)) {
        // Already confirmed by this node: refresh the local state, and check
        // once per run that the copy is really here (repaired if not)
        this.settled.delete(chunk.address);
        await this._syncState(chunk.address, chunk.data);
        if (this.verified.has(chunk.address)) continue;
      } else if (this.settled.has(chunk.address)) {
        continue;
      }
      if (this.inFlight.has(chunk.address) || this.backoff.isBlocked(chunk.address, now)) continue;
      candidates.push(chunk);
    }
    stats.candidates = candidates.length;

    candidates.sort(byPriority);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length && !this.stopping) {
        await this._replicate(candidates[cursor++], replicator, stats);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker));

    const retryDeparted = await this._refreshDeparted(current, stats);
    this.previousScan = new Set([...current, ...retryDeparted]);
    if (!this.reconciled) this.reconciled = await this._reconcileStored(current, stats);
    // A chunk never needs replicas again once it left the set: keep the
    // per-chunk caches bounded by the scan size
    for (const id of this.verified) {
      if (!this.previousScan.has(id)) this.verified.delete(id);
    }
    for (const id of this.synced.keys()) {
      if (!this.previousScan.has(id)) this.synced.delete(id);
    }

    this.scans++;
    this.lastScanAt = new Date();
    this.lastScanMs = Date.now() - started;
    this.lastScan = stats;
    this.totals.stored += stats.stored;
    this.totals.confirmed += stats.confirmed;
    this.totals.skipped += stats.skipped;
    this.totals.errors += stats.errors;
    if (stats.stored || stats.confirmed || stats.errors) {
      this.logger.log(
        `Scan: ${stats.seen} chunks need replicas, ${stats.candidates} for this node — ` +
        `${stats.stored} stored, ${stats.confirmed} confirmed, ${stats.skipped} skipped, ${stats.errors} errors`,
      );
    }
    return stats;
  }

  get status(): ReplicatorStatus {
    return {
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      scans: this.scans,
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      lastScanMs: this.lastScanMs,
      lastScan: this.lastScan,
      totals: { ...this.totals, lamportsEarned: this.totals.lamportsEarned.toString() },
      inFlight: this.inFlight.size,
      lastError: this.lastError,
      backoff: this.backoff.summary(),
    };
  }

  // ── Replication core ────────────────────────────────────────────────────────

  private async _replicate(
    chunk: FetchedAccount<ChunkAccount>,
    replicator: ReplicatorAccount | null,
    stats: ScanStats,
  ): Promise<void> {
    const id = chunk.address;
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);

    try {
      // ── a + b) Bytes from the ledger (sha256-checked) → chunk store ────
      if (await this._ensureStored(chunk)) stats.stored++;

      // ── c) Confirm on-chain unless it does not pay / this node cannot ──
      const reason = this._skipReason(chunk.data, replicator);
      if (chunk.data.replicators.includes(this.solana.address)) {
        // confirmed earlier: the copy is back, nothing to send
      } else if (reason) {
        stats.skipped++;
        this._logSkip(id, reason, replicator?.active === true);
      } else {
        await this._confirm(chunk, stats);
      }
      this.backoff.clear(id);
    } catch (err) {
      stats.errors++;
      this.lastError = `${id}: ${message(err)}`;
      const entry = this.backoff.fail(id, err);
      const retryIn = `retrying in ${Math.round((entry.retryAt - Date.now()) / 1000)} s`;
      if (entry.kind === 'invalid') {
        this.logger.warn(`Chunk ${id} has invalid ledger data (${message(err)}) — ${retryIn}`);
      } else if (entry.kind === 'incomplete') {
        this.logger.warn(`Chunk ${id} is incomplete in the ledger (${message(err)}) — ${retryIn}`);
      } else {
        this.logger.error(`Replication of ${id} failed: ${message(err)} — ${retryIn} (attempt ${entry.attempts})`);
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Make sure a verified copy of the chunk is stored.  Returns true when it
   * had to be rebuilt from the ledger.
   */
  private async _ensureStored(chunk: FetchedAccount<ChunkAccount>): Promise<boolean> {
    const id = chunk.address;
    if (this.verified.has(id)) return false;

    // Stored by an earlier run: check it once instead of re-reading the ledger
    const local = await this.storage.getRawChunk(id);
    if (local) {
      if (sha256Hex(local) === toHex(chunk.data.contentHash)) {
        if (!(await this.storage.getChunkMeta(id))) {
          await this.storage.upsertChunkMeta(chunkRecordFromAccount(id, chunk.data));
        }
        this.verified.add(id);
        await this._syncState(id, chunk.data);
        return false;
      }
      this.logger.warn(`Local copy of ${id} does not match its content hash — rebuilding it`);
      await this.storage.deleteChunk(id);
    }

    const { data, slot } = await this.solana.readChunk(id, chunk.data.contentHash);
    await this.storage.storeChunk(
      chunkRecordFromAccount(id, chunk.data, { slot: Number(slot), storedAt: new Date() }),
      Buffer.from(data),
    );
    this.verified.add(id);
    this.synced.set(id, syncKey(chunk.data));
    this.logger.log(`Stored chunk ${id} (${data.length} bytes, owner ${chunk.data.owner}) from the ledger`);
    return true;
  }

  private _skipReason(data: ChunkAccount, replicator: ReplicatorAccount | null): string | null {
    if (data.rewardPerReplica < this.minRewardLamports) {
      return `reward ${data.rewardPerReplica} lamports < MIN_REWARD_LAMPORTS (${this.minRewardLamports})`;
    }
    if (!replicator) return 'this node is not a registered replicator';
    if (!replicator.active) return "this node's Replicator account is inactive";
    return null;
  }

  /** Warn once per chunk (replicator-wide reasons are warned by _checkReplicator) */
  private _logSkip(id: string, reason: string, chunkSpecific: boolean): void {
    if (!chunkSpecific || this.skipLogged.get(id) === reason) {
      this.logger.debug(`Not confirming ${id}: ${reason}`);
      return;
    }
    this.skipLogged.set(id, reason);
    this.logger.warn(`Stored ${id} but not confirming it: ${reason}`);
  }

  private async _confirm(chunk: FetchedAccount<ChunkAccount>, stats: ScanStats): Promise<void> {
    const id = chunk.address;
    let signature: string;
    try {
      signature = await this.solana.confirmReplication(id);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const name = typeof code === 'number' ? SETTLED_ERRORS.get(code) : undefined;
      if (!name) throw err;
      // An earlier try of ours, or the other replicas, got there first
      stats.skipped++;
      this.settled.set(id, Date.now());
      this.logger.debug(`confirm_replication ${id}: ${name} — nothing to do`);
      return;
    }

    stats.confirmed++;
    this.totals.lamportsEarned += chunk.data.rewardPerReplica;
    this.settled.set(id, Date.now());
    this.skipLogged.delete(id);
    this.logger.log(
      `Confirmed replication of ${id} in ${signature}, earned ${chunk.data.rewardPerReplica} lamports`,
    );
    await this._recordConfirmation(id, chunk.data, signature);
  }

  /** Metadata after this node's confirmation, read back at "confirmed" (scans may lag) */
  private async _recordConfirmation(id: Address, before: ChunkAccount, signature: string): Promise<void> {
    try {
      const account = await this.solana.getChunk(id, 'confirmed');
      const update: ChunkStateUpdate = account
        ? stateUpdateFromAccount(account.data)
        : {
          // The owner may close a fully replicated chunk right away
          state: 'Closed',
          confirmedReplicas: before.confirmedReplicas + 1,
          replicators: [...before.replicators, this.solana.address],
        };
      await this.storage.updateReplicationState(id, {
        ...update,
        confirmedAt: new Date(),
        confirmSignature: signature,
      });
      this.synced.set(id, account ? syncKey(account.data) : 'Closed');
    } catch (err) {
      this.logger.warn(`Confirmed ${id} but could not record it locally: ${message(err)}`);
    }
  }

  // ── Local state refresh ─────────────────────────────────────────────────────

  /** Write the chain's replication state for a stored chunk when it changed */
  private async _syncState(id: string, data: ChunkAccount): Promise<void> {
    const key = syncKey(data);
    if (this.synced.get(id) === key) return;
    try {
      await this.storage.updateReplicationState(id, stateUpdateFromAccount(data));
      this.synced.set(id, key);
    } catch (err) {
      this.logger.warn(`Could not refresh the metadata of ${id}: ${message(err)}`);
    }
  }

  /**
   * Stored chunks that dropped out of the needs-replicas set (fully
   * replicated, reclaimed or closed) get a last refresh.  Returns the ones
   * that could not be fetched, to retry on the next scan.
   */
  private async _refreshDeparted(current: Set<string>, stats: ScanStats): Promise<string[]> {
    const departed = [...this.previousScan].filter((id) => !current.has(id) && this.synced.has(id));
    if (departed.length === 0) return [];
    try {
      const accounts = await this.solana.getChunks(departed as Address[]);
      for (let i = 0; i < departed.length; i++) {
        const account = accounts[i];
        if (account) {
          await this._syncState(departed[i], account.data);
        } else if (this.synced.get(departed[i]) !== 'Closed') {
          await this.storage.updateReplicationState(departed[i], { state: 'Closed' });
          this.synced.set(departed[i], 'Closed');
        }
      }
      return [];
    } catch (err) {
      stats.errors++;
      this.logger.warn(`Could not refresh ${departed.length} settled chunks: ${message(err)}`);
      return departed;
    }
  }

  /**
   * Once per run: stored chunks still recorded as Hot that the scan no
   * longer lists moved on while the node was down (or it stopped between a
   * confirmation and its metadata write).  Refresh them from the chain.
   * Returns false to retry on the next scan.
   */
  private async _reconcileStored(current: Set<string>, stats: ScanStats): Promise<boolean> {
    try {
      const stale: string[] = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await this.storage.queryChunks({
          filter: { state: 'Hot' },
          orderBy: 'chunkId',
          order: 'asc',
          limit: 1000,
          offset,
        });
        stale.push(...page.map((r) => r.chunkId).filter((id) => !current.has(id)));
        if (page.length < 1000) break;
      }
      if (stale.length === 0) return true;

      const accounts = await this.solana.getChunks(stale as Address[]);
      for (let i = 0; i < stale.length; i++) {
        const update: ChunkStateUpdate = accounts[i] ? stateUpdateFromAccount(accounts[i].data) : { state: 'Closed' };
        await this.storage.updateReplicationState(stale[i], update);
      }
      this.logger.log(`Refreshed ${stale.length} stored chunks whose state changed while the node was down`);
      return true;
    } catch (err) {
      stats.errors++;
      this.logger.warn(`Could not reconcile stored chunks with the chain: ${message(err)}`);
      return false;
    }
  }

  // ── Replicator account ──────────────────────────────────────────────────────

  /** Log when the Replicator account appears, disappears or changes activity */
  private _checkReplicator(replicator: ReplicatorAccount | null): void {
    const state = !replicator ? 'missing' : replicator.active ? 'active' : 'inactive';
    if (this.replicatorState !== null && state !== this.replicatorState) {
      if (state === 'active') {
        this.logger.log(`Replicator ${this.solana.address} is active — confirming stored chunks`);
      } else {
        this.logger.warn(`Replicator ${this.solana.address} is now ${state} — confirmations paused`);
      }
    }
    this.replicatorState = state;
  }

  /** UPDATE_ENDPOINT_ON_START: publish NODE_ENDPOINT when the on-chain one differs */
  private async _syncEndpoint(replicator: ReplicatorAccount): Promise<void> {
    if (replicator.endpoint === this.nodeEndpoint) return;
    if (!this.updateEndpointOnStart) {
      this.logger.warn(
        `On-chain endpoint ${replicator.endpoint} differs from NODE_ENDPOINT ${this.nodeEndpoint} ` +
        `(UPDATE_ENDPOINT_ON_START=true updates it)`,
      );
      return;
    }
    if (!this.nodeEndpoint || Buffer.byteLength(this.nodeEndpoint) > 128) {
      this.logger.warn(`NODE_ENDPOINT must be 1–128 bytes; on-chain endpoint left unchanged`);
      return;
    }
    try {
      const signature = await this.solana.updateEndpoint(this.nodeEndpoint);
      this.logger.log(`On-chain endpoint updated to ${this.nodeEndpoint} in ${signature}`);
    } catch (err) {
      this.logger.warn(`Could not update the on-chain endpoint: ${message(err)}`);
    }
  }
}
