import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, getAddressDecoder } from '@solana/kit';
import {
  SOLADB_ERRORS,
  SolaDBTransactionError,
  ChunkAccount,
  FetchedAccount,
  MAX_DIRECT_CHUNK_SIZE,
  ReplicatorAccount,
} from '@soladb/sdk';
import { ReplicatorService, SETTLED_TTL_MS } from './replicator.service';
import { DEFAULT_BACKOFF } from './backoff';
import { ChunkToConfirm, SolanaService } from '../solana/solana.service';
import { StorageService } from '../storage/storage.service';
import { FsChunkStore } from '../storage/fs-chunk-store.service';
import { FileMetadataService } from '../storage/file-metadata.service';

const newAddress = () => getAddressDecoder().decode(randomBytes(32)) as Address;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

const peer = (authority: Address, endpoint: string, active = true): ReplicatorAccount => ({
  authority,
  active,
  bump: 255,
  registeredAt: 1n,
  confirmations: 0n,
  lamportsEarned: 0n,
  endpoint,
});

/**
 * In-memory stand-in for SolanaService: a set of Chunk accounts, the bytes
 * their write_segment transactions put in the ledger, this node's Replicator
 * account and the other registered replicators.  Scans return snapshots,
 * like an RPC would.
 */
class FakeSolana {
  readonly address = newAddress();
  readonly accounts = new Map<Address, ChunkAccount>();
  readonly ledger = new Map<Address, Uint8Array>();
  replicator: ReplicatorAccount | null = peer(this.address, 'http://node');
  /** Every registered replicator (peers serving direct chunks) */
  peers: ReplicatorAccount[] = [];
  /** Look-alike accounts another program created (not at a SolaDB chunk PDA) */
  readonly forged = new Set<Address>();
  /** Next confirm_replication outcome: sends normally when undefined */
  confirmError: Error | undefined;
  /** When set, scans keep returning this stale view (scan commitment lag) */
  frozen: FetchedAccount<ChunkAccount>[] | null = null;
  signatures = 0;

  addChunk(bytes: Uint8Array, overrides: Partial<ChunkAccount> = {}): Address {
    const address = newAddress();
    this.accounts.set(address, {
      owner: newAddress(),
      contentHash: new Uint8Array(sha256(bytes)),
      writer: newAddress(),
      state: 'Hot',
      needsReplicas: true,
      reclaimed: false,
      bump: 254,
      requiredReplicas: 1,
      confirmedReplicas: 0,
      segmentSize: 3864,
      segmentsTotal: Math.ceil(bytes.length / 3864),
      segmentsWritten: Math.ceil(bytes.length / 3864),
      size: bytes.length,
      rewardPerReplica: 50_000n,
      openedAt: 1_760_000_000n,
      completedAt: 1_760_000_010n,
      reclaimableAt: 1_760_003_600n,
      segments: new Uint8Array(),
      replicators: [],
      ...overrides,
    });
    this.ledger.set(address, bytes);
    return address;
  }

  /** A direct chunk: no segments, waiting for replicas from the start, never in the ledger */
  addDirect(bytes: Uint8Array, overrides: Partial<ChunkAccount> = {}): Address {
    const address = this.addChunk(bytes, { segmentSize: 0, segmentsTotal: 0, segmentsWritten: 0, ...overrides });
    this.ledger.delete(address);
    return address;
  }

  private snapshot(address: Address): FetchedAccount<ChunkAccount> {
    return { address, data: structuredClone(this.accounts.get(address)), lamports: 1_000_000n };
  }

  listChunksNeedingReplicas = jest.fn(async () => {
    if (this.frozen) return structuredClone(this.frozen);
    return [...this.accounts.keys()].filter((a) => this.accounts.get(a).needsReplicas).map((a) => this.snapshot(a));
  });

  getReplicator = jest.fn(async () => (this.replicator ? { ...this.replicator } : null));

  readChunk = jest.fn(async (chunk: Address, contentHash: Uint8Array) => {
    const data = this.ledger.get(chunk);
    if (!data) throw new Error('Segment 0 is missing from the ledger');
    if (!sha256(data).equals(Buffer.from(contentHash))) {
      throw new Error('Chunk rebuilt from the ledger does not match its content hash');
    }
    return { data, slot: 4242n };
  });

  /** Mirrors confirm_replication: a transaction is atomic, so every chunk is checked before any is applied */
  private confirm(chunks: ChunkToConfirm[]): string {
    if (this.confirmError) {
      const err = this.confirmError;
      this.confirmError = undefined;
      throw err;
    }
    const fail = (name: string, code = SOLADB_ERRORS[name]) => {
      throw new SolaDBTransactionError(`confirm_replication failed (${name})`, code);
    };
    for (const { address, owner } of chunks) {
      const account = this.accounts.get(address);
      if (!account) fail('AccountNotInitialized', 3012);
      if (owner !== account.owner) fail('InvalidChunkOwner');
      if (account.reclaimed) fail('ReplicationClosed');
      if (account.confirmedReplicas >= account.requiredReplicas) fail('FullyReplicated');
      if (account.replicators.includes(this.address)) fail('AlreadyReplicated');
    }
    for (const { address } of chunks) {
      const account = this.accounts.get(address);
      account.replicators.push(this.address);
      account.confirmedReplicas++;
      if (account.confirmedReplicas === account.requiredReplicas) account.needsReplicas = false;
      if (account.confirmedReplicas >= Math.max(1, Math.floor((account.requiredReplicas * 60) / 100))) account.state = 'Cool';
      // the last confirmation closes the account (rent back to the owner)
      if (account.confirmedReplicas === account.requiredReplicas) this.accounts.delete(address);
    }
    return `sig${++this.signatures}`;
  }

  confirmReplication = jest.fn(async (chunk: Address, owner: Address) => this.confirm([{ address: chunk, owner }]));
  confirmReplications = jest.fn(async (chunks: ChunkToConfirm[]) => this.confirm(chunks));
  listReplicators = jest.fn(async () => structuredClone(this.peers));

  getChunk = jest.fn(async (chunk: Address, _commitment?: string) => (this.accounts.has(chunk) ? this.snapshot(chunk) : null));
  isChunkAddress = jest.fn(async (chunk: Address) => !this.forged.has(chunk));
  getChunks = jest.fn(async (chunks: Address[]) => chunks.map((c) => (this.accounts.has(c) ? this.snapshot(c) : null)));
  updateEndpoint = jest.fn(async () => 'sigEndpoint');
}

describe('ReplicatorService', () => {
  let dataDir: string;
  let solana: FakeSolana;
  let storage: StorageService;
  let now: number;

  const config = (replication: Record<string, unknown> = {}) =>
    new ConfigService({
      storage: { dataDir, chunkStore: 'fs', metadataStore: 'file' },
      replication: {
        pollIntervalMs: 1_000,
        concurrency: 3,
        minRewardLamports: 0n,
        nodeEndpoint: 'http://node',
        updateEndpointOnStart: false,
        ...replication,
      },
    });

  /** A fresh service (= a node restart) over the same data directory */
  const replicatorWith = (replication: Record<string, unknown> = {}) =>
    new ReplicatorService(solana as unknown as SolanaService, storage, config(replication));

  beforeAll(() => Logger.overrideLogger(false));

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-replicator-'));
    const cfg = config();
    const chunks = new FsChunkStore(cfg);
    const metadata = new FileMetadataService(cfg);
    await chunks.onModuleInit();
    await metadata.onModuleInit();
    storage = new StorageService(chunks, metadata, cfg);
    solana = new FakeSolana();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Batches leave only when full or at the end of a scan (the 250 ms timer never fires) */
  const holdBatchTimer = () =>
    jest.useFakeTimers({
      doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'],
    });

  /** Peers answer from `routes` (bytes, or an HTTP status); other URLs are unreachable */
  const servePeers = (routes: Record<string, Uint8Array | number>) =>
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const route = routes[String(input)];
      if (route === undefined) throw new TypeError('fetch failed');
      return typeof route === 'number' ? new Response('not here', { status: route }) : new Response(new Uint8Array(route));
    });

  it('rebuilds a new chunk from the ledger, stores it and confirms it', async () => {
    const bytes = randomBytes(10_000);
    const chunk = solana.addChunk(bytes);
    const owner = solana.accounts.get(chunk).owner;
    const replicator = replicatorWith();

    const stats = await replicator.scanOnce();

    expect(stats).toEqual({ seen: 1, candidates: 1, stored: 1, confirmed: 1, skipped: 0, errors: 0 });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(solana.confirmReplication).toHaveBeenCalledWith(chunk, owner);
    expect(solana.accounts.has(chunk)).toBe(false); // the last confirmation closed it
    const meta = await storage.getChunkMeta(chunk);
    expect(meta).toMatchObject({
      chunkId: chunk,
      contentHash: sha256(bytes).toString('hex'),
      size: 10_000,
      state: 'Closed',
      confirmedReplicas: 1,
      replicators: [solana.address],
      rewardPerReplica: '50000',
      slot: 4242,
      confirmSignature: 'sig1',
    });
    expect(meta.confirmedAt).toBeInstanceOf(Date);
    expect(replicator.status.totals).toMatchObject({ stored: 1, confirmed: 1, lamportsEarned: '50000', transactions: 1 });
  });

  it('skips chunks this node already confirmed (and only checks its copy once)', async () => {
    const bytes = randomBytes(2_000);
    const chunk = solana.addChunk(bytes, { requiredReplicas: 3, confirmedReplicas: 1, replicators: [] });
    solana.accounts.get(chunk).replicators.push(solana.address);
    await storage.storeChunk(
      { chunkId: chunk, owner: 'o', contentHash: sha256(bytes).toString('hex'), size: 2_000, requiredReplicas: 3,
        confirmedReplicas: 0, state: 'Hot', reclaimed: false, rewardPerReplica: '1', replicators: [], slot: 1,
        uploadedAt: new Date(), storedAt: new Date(), confirmedAt: null, confirmSignature: null },
      bytes,
    );
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ seen: 1, candidates: 1, stored: 0, confirmed: 0, skipped: 0 });
    expect(await replicator.scanOnce()).toMatchObject({ seen: 1, candidates: 0 });
    expect(solana.readChunk).not.toHaveBeenCalled();
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    // local state refreshed from the scan
    expect(await storage.getChunkMeta(chunk)).toMatchObject({ confirmedReplicas: 1, replicators: [solana.address] });
  });

  it('re-fetches a chunk it confirmed earlier but lost locally, without confirming again', async () => {
    const chunk = solana.addChunk(randomBytes(500), { requiredReplicas: 2, confirmedReplicas: 1 });
    solana.accounts.get(chunk).replicators.push(solana.address);

    expect(await replicatorWith().scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 0 });
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    expect(await storage.hasChunk(chunk)).toBe(true);
  });

  it('stores but does not confirm chunks paying less than MIN_REWARD_LAMPORTS', async () => {
    const bytes = randomBytes(1_000);
    const chunk = solana.addChunk(bytes, { rewardPerReplica: 999n });
    const replicator = replicatorWith({ minRewardLamports: 1_000n });

    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1, errors: 0 });
    expect(await replicator.scanOnce()).toMatchObject({ stored: 0, confirmed: 0, skipped: 1, errors: 0 });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(solana.readChunk).toHaveBeenCalledTimes(1); // idempotent: the stored copy is reused
    expect(solana.confirmReplication).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['inactive', { active: false }],
  ])('keeps the data but does not confirm while the Replicator account is %s', async (_, replicator) => {
    const chunk = solana.addChunk(randomBytes(1_000));
    solana.replicator = replicator === null ? null : { ...solana.replicator, ...replicator };
    const service = replicatorWith();

    expect(await service.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1 });
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    expect(await storage.hasChunk(chunk)).toBe(true);

    // once (re)activated, the stored copy is confirmed without another ledger read
    solana.replicator = { ...(solana.replicator ?? ({} as ReplicatorAccount)), authority: solana.address, active: true };
    expect(await service.scanOnce()).toMatchObject({ stored: 0, confirmed: 1 });
    expect(solana.readChunk).toHaveBeenCalledTimes(1);
  });

  it('reuses a verified copy after a restart and replaces a corrupt one', async () => {
    const bytes = randomBytes(3_000);
    const good = solana.addChunk(bytes, { rewardPerReplica: 1n });
    const bad = solana.addChunk(randomBytes(3_000), { rewardPerReplica: 1n });
    const skipAll = { minRewardLamports: 10n };

    await replicatorWith(skipAll).scanOnce();
    expect(solana.readChunk).toHaveBeenCalledTimes(2);
    await storage.storeChunk((await storage.getChunkMeta(bad))!, Buffer.from('bit rot'));

    const restarted = replicatorWith(skipAll);
    expect(await restarted.scanOnce()).toMatchObject({ stored: 1, errors: 0 });
    expect(solana.readChunk).toHaveBeenCalledTimes(3);
    expect(solana.readChunk).toHaveBeenLastCalledWith(bad, expect.anything());
    expect(await storage.getRawChunk(good)).toEqual(bytes);
    expect(await storage.getRawChunk(bad)).toEqual(Buffer.from(solana.ledger.get(bad)));
  });

  it.each(['AlreadyReplicated', 'FullyReplicated', 'ReplicationClosed'])(
    'treats %s as nothing to do (no error, no retry)',
    async (name) => {
      const chunk = solana.addChunk(randomBytes(100));
      solana.confirmError = new SolaDBTransactionError(`confirm failed (${name})`, SOLADB_ERRORS[name]);
      const replicator = replicatorWith();

      expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, skipped: 1, errors: 0 });
      expect(replicator.backoff.get(chunk)).toBeUndefined();
      // settled: not sent again while the scan still lists it
      expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
      expect(solana.confirmReplication).toHaveBeenCalledTimes(1);
    },
  );

  it('backs off other transaction errors and retries later', async () => {
    const chunk = solana.addChunk(randomBytes(100));
    solana.confirmError = new SolaDBTransactionError('confirm failed (ReplicatorInactive)', SOLADB_ERRORS.ReplicatorInactive);
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'error', attempts: 1, retryAt: now + DEFAULT_BACKOFF.baseMs });
    expect(replicator.status.lastError).toContain('ReplicatorInactive');

    now += 5_000;
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
    now += DEFAULT_BACKOFF.baseMs;
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 0, confirmed: 1, errors: 0 });
    expect(replicator.backoff.get(chunk)).toBeUndefined();
  });

  it('does not confirm twice while a lagging scan still lists the chunk without this node', async () => {
    const chunk = solana.addChunk(randomBytes(100), { requiredReplicas: 2 });
    solana.frozen = await solana.listChunksNeedingReplicas(); // "finalized" view before our confirmation
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ confirmed: 1 });
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0, confirmed: 0 });

    // past the TTL the program itself says AlreadyReplicated: still not an error
    now += SETTLED_TTL_MS + 1;
    expect(await replicator.scanOnce()).toMatchObject({ confirmed: 0, skipped: 1, errors: 0 });
    expect(solana.confirmReplication).toHaveBeenCalledTimes(2);
    expect((await storage.getChunkMeta(chunk)).confirmSignature).toBe('sig1');
  });

  it('skips chunks with invalid ledger data for an hour', async () => {
    const chunk = solana.addChunk(randomBytes(100));
    solana.ledger.set(chunk, randomBytes(100)); // segments that do not hash to contentHash
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'invalid', retryAt: now + 60 * 60_000 });
    expect(await storage.hasChunk(chunk)).toBe(false);

    for (const step of [10_000, 10 * 60_000, 40 * 60_000]) {
      now += step;
      await replicator.scanOnce();
    }
    expect(solana.readChunk).toHaveBeenCalledTimes(1);

    now += 60 * 60_000;
    await replicator.scanOnce();
    expect(solana.readChunk).toHaveBeenCalledTimes(2);
    expect(replicator.status.backoff).toMatchObject({ invalid: 1, incomplete: 0, error: 0 });
  });

  it('backs off incomplete ledger data exponentially (10 s doubling, capped at 10 min)', async () => {
    const chunk = solana.addChunk(randomBytes(100));
    solana.ledger.delete(chunk); // "Segment 0 is missing"
    const replicator = replicatorWith();
    const delays: number[] = [];

    for (let i = 0; i < 8; i++) {
      await replicator.scanOnce();
      const entry = replicator.backoff.get(chunk);
      delays.push(entry.retryAt - now);
      now = entry.retryAt;
    }
    expect(delays).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000]);
    expect(solana.readChunk).toHaveBeenCalledTimes(8);
    expect(replicator.status.backoff).toMatchObject({ invalid: 0, incomplete: 1, error: 0 });
    expect(replicator.status.backoff.chunks[0]).toMatchObject({ chunk, kind: 'incomplete', attempts: 8 });

    // the segment shows up: replicated, backoff cleared
    solana.ledger.set(chunk, randomBytes(100));
    solana.accounts.get(chunk).contentHash = new Uint8Array(sha256(solana.ledger.get(chunk)));
    expect(await replicator.scanOnce()).toMatchObject({ stored: 1, confirmed: 1 });
    expect(replicator.status.backoff).toMatchObject({ invalid: 0, incomplete: 0, error: 0, chunks: [] });
  });

  it('never works on the same chunk twice at once', async () => {
    solana.addChunk(randomBytes(100));
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = solana.readChunk.getMockImplementation();
    solana.readChunk.mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const replicator = replicatorWith();

    const first = replicator.scanOnce();
    await new Promise((r) => setImmediate(r));
    const second = await replicator.scanOnce(); // runs while the first is still reading
    release();
    expect(second).toMatchObject({ candidates: 0 });
    expect(await first).toMatchObject({ stored: 1, confirmed: 1 });
    expect(solana.readChunk).toHaveBeenCalledTimes(1);
  });

  it('refreshes stored chunks that leave the needs-replicas set (Closed when the account is gone)', async () => {
    const chunk = solana.addChunk(randomBytes(100), { requiredReplicas: 2 });
    const replicator = replicatorWith();
    await replicator.scanOnce();
    expect((await storage.getChunkMeta(chunk)).state).toBe('Cool');

    // another replica completes it, then the owner closes the account
    solana.accounts.get(chunk).needsReplicas = false;
    solana.accounts.delete(chunk);
    await replicator.scanOnce();
    expect((await storage.getChunkMeta(chunk)).state).toBe('Closed');
    expect(solana.getChunks).toHaveBeenCalledWith([chunk]);
  });

  it('reconciles records left Hot while the node was down, once per run', async () => {
    const settledBytes = randomBytes(100);
    const settled = solana.addChunk(settledBytes, { requiredReplicas: 1 });
    const closed = solana.addChunk(randomBytes(100));
    await replicatorWith({ minRewardLamports: 10n ** 9n }).scanOnce(); // stored, not confirmed: Hot
    expect((await storage.getChunkMeta(settled)).state).toBe('Hot');

    // while "down": another replica completes one chunk, the other is closed
    Object.assign(solana.accounts.get(settled), { needsReplicas: false, state: 'Cool', confirmedReplicas: 1, replicators: [newAddress()] });
    solana.accounts.delete(closed);

    const restarted = replicatorWith();
    await restarted.scanOnce();
    expect(await storage.getChunkMeta(settled)).toMatchObject({ state: 'Cool', confirmedReplicas: 1 });
    expect((await storage.getChunkMeta(closed)).state).toBe('Closed');

    await restarted.scanOnce();
    expect(solana.getChunks).toHaveBeenCalledTimes(1);
  });

  it('keeps scanning after a failed scan', async () => {
    solana.listChunksNeedingReplicas.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    (Date.now as jest.Mock).mockRestore();
    const replicator = replicatorWith({ pollIntervalMs: 100 });

    replicator.start();
    await new Promise((r) => setTimeout(r, 1_300));
    await replicator.stop();

    expect(solana.listChunksNeedingReplicas.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(replicator.status).toMatchObject({ running: false, lastError: '429 Too Many Requests' });
    expect(replicator.status.scans).toBeGreaterThanOrEqual(1);
  });

  // ── Batched confirmations ───────────────────────────────────────────────────

  it('confirms up to 8 chunks per transaction, each with its owner', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 10 }, () => solana.addChunk(randomBytes(500)));
    const owners = new Map(chunks.map((c) => [c, solana.accounts.get(c).owner]));
    const replicator = replicatorWith({ concurrency: 10 });

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 10, stored: 10, confirmed: 10, errors: 0 });
    const batches = solana.confirmReplications.mock.calls.map(([batch]) => batch);
    expect(batches.map((b) => b.length)).toEqual([8, 2]);
    for (const { address, owner } of batches.flat()) expect(owner).toBe(owners.get(address));
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    expect(replicator.status.totals).toMatchObject({ confirmed: 10, transactions: 2, lamportsEarned: '500000' });
    const signatures = await Promise.all(chunks.map(async (c) => (await storage.getChunkMeta(c)).confirmSignature));
    expect(new Set(signatures)).toEqual(new Set(['sig1', 'sig2']));
  });

  it('sends a rejected batch again chunk by chunk, so a settled chunk does not block the others', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 3 }, () => solana.addChunk(randomBytes(500)));
    solana.frozen = await solana.listChunksNeedingReplicas();
    solana.accounts.delete(chunks[1]); // completed (and closed) by other replicas since the scan's view
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 3, stored: 3, confirmed: 2, skipped: 1, errors: 0 });
    expect(solana.confirmReplications).toHaveBeenCalledTimes(1);
    expect(solana.confirmReplication).toHaveBeenCalledTimes(3);
    expect(replicator.status.totals.transactions).toBe(2);
    for (const chunk of chunks) expect(replicator.backoff.get(chunk)).toBeUndefined();
    // the closed one is settled too: nothing is sent again while the scan lists it
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 });
  });

  it('fails the whole batch on a transport error, without retrying chunk by chunk', async () => {
    holdBatchTimer();
    const chunks = Array.from({ length: 3 }, () => solana.addChunk(randomBytes(500)));
    solana.confirmError = new Error('1 transaction(s) not confirmed after 60000 ms');
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ stored: 3, confirmed: 0, errors: 3 });
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    for (const chunk of chunks) expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'error', attempts: 1 });
  });

  // ── Direct chunks ───────────────────────────────────────────────────────────

  it('accepts a pushed direct chunk: stores it and confirms it', async () => {
    const bytes = randomBytes(5_000);
    const chunk = solana.addDirect(bytes);
    const owner = solana.accounts.get(chunk).owner;
    const replicator = replicatorWith();

    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 201, stored: true, confirmed: true, signature: 'sig1' });
    expect(solana.getChunk).toHaveBeenCalledWith(chunk, 'confirmed');
    expect(solana.confirmReplication).toHaveBeenCalledWith(chunk, owner);
    expect(solana.accounts.has(chunk)).toBe(false); // the last confirmation closed it
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(await storage.getChunkMeta(chunk)).toMatchObject({
      owner,
      size: 5_000,
      state: 'Closed',
      confirmedReplicas: 1,
      replicators: [solana.address],
      slot: null,
      confirmSignature: 'sig1',
    });
    expect(replicator.status).toMatchObject({
      pushes: { accepted: 1, rejected: 0 },
      totals: { stored: 1, confirmed: 1, lamportsEarned: '50000', transactions: 1 },
    });
    expect(await replicator.scanOnce()).toMatchObject({ seen: 0, errors: 0 });
  });

  it.each<[string, number, (bytes: Buffer) => { chunk: Address; push: Buffer; owners?: string[] }]>([
    ['the bytes do not hash to the content hash', 400, (bytes) => ({ chunk: solana.addDirect(bytes), push: randomBytes(bytes.length) })],
    ['the size differs', 400, (bytes) => ({ chunk: solana.addDirect(bytes), push: bytes.subarray(1) })],
    ['the chunk is written to the ledger', 409, (bytes) => ({ chunk: solana.addChunk(bytes), push: bytes })],
    ['the owner reclaimed the chunk', 409, (bytes) => ({ chunk: solana.addDirect(bytes, { reclaimed: true, needsReplicas: false }), push: bytes })],
    ['the chunk needs no more replicas', 409, (bytes) => ({ chunk: solana.addDirect(bytes, { needsReplicas: false }), push: bytes })],
    ['the chunk does not exist (yet)', 404, (bytes) => ({ chunk: newAddress(), push: bytes })],
    ['the account was not created by the program', 404, (bytes) => {
      const chunk = solana.addDirect(bytes);
      solana.forged.add(chunk);
      return { chunk, push: bytes };
    }],
    ['the owner is not in REPLICATE_OWNERS', 403, (bytes) => ({ chunk: solana.addDirect(bytes), push: bytes, owners: [newAddress()] })],
    ['it is larger than 16 MiB', 413, () => ({ chunk: newAddress(), push: Buffer.alloc(MAX_DIRECT_CHUNK_SIZE + 1) })],
  ])('rejects a push when %s (%i)', async (_, status, setup) => {
    const { chunk, push, owners } = setup(randomBytes(2_000));
    const replicator = replicatorWith(owners ? { owners } : {});

    await expect(replicator.acceptPush(chunk, push)).rejects.toMatchObject({ status });
    expect(await storage.hasChunk(chunk)).toBe(false);
    expect(solana.confirmReplication).not.toHaveBeenCalled();
    expect(replicator.status.pushes).toEqual({ accepted: 0, rejected: 1 });
  });

  it('answers a repeated push idempotently, also once the chunk account closed', async () => {
    const bytes = randomBytes(3_000);
    const chunk = solana.addDirect(bytes, { requiredReplicas: 2 });
    const replicator = replicatorWith();

    expect(await replicator.acceptPush(chunk, bytes)).toMatchObject({ status: 201, confirmed: true });
    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 200, stored: true, confirmed: true });
    solana.accounts.delete(chunk); // another replica completed it
    expect(await replicator.acceptPush(chunk, bytes)).toEqual({ status: 200, stored: true, confirmed: true });
    await expect(replicator.acceptPush(chunk, randomBytes(3_000))).rejects.toMatchObject({ status: 404 });
    expect(solana.confirmReplication).toHaveBeenCalledTimes(1);
    expect(replicator.status.pushes).toEqual({ accepted: 3, rejected: 1 });
  });

  it('stores a pushed chunk it cannot confirm and says why', async () => {
    const bytes = randomBytes(1_000);
    const chunk = solana.addDirect(bytes, { rewardPerReplica: 10n });
    const replicator = replicatorWith({ minRewardLamports: 1_000n });

    expect(await replicator.acceptPush(chunk, bytes)).toEqual({
      status: 201,
      stored: true,
      confirmed: false,
      reason: 'reward 10 lamports < MIN_REWARD_LAMPORTS (1000)',
    });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(solana.confirmReplication).not.toHaveBeenCalled();
  });

  it('copies a direct chunk from a peer: the replicators that confirmed it first, never itself', async () => {
    const bytes = randomBytes(4_000);
    const confirmedBy = newAddress();
    const chunk = solana.addDirect(bytes, { requiredReplicas: 3, confirmedReplicas: 1, replicators: [confirmedBy] });
    solana.peers = [
      peer(newAddress(), 'http://node/'), // a second registration with this node's endpoint
      peer(solana.address, 'http://self'),
      peer(newAddress(), 'http://good'),
      peer(newAddress(), 'http://inactive', false),
      peer(confirmedBy, 'http://liar/'),
    ];
    const fetchMock = servePeers({
      [`http://liar/chunk/${chunk}/data`]: randomBytes(4_000), // not the chunk: skipped
      [`http://good/chunk/${chunk}/data`]: bytes,
    });
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 1, confirmed: 1, errors: 0 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`http://liar/chunk/${chunk}/data`, `http://good/chunk/${chunk}/data`]);
    expect(solana.readChunk).not.toHaveBeenCalled();
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(await storage.getChunkMeta(chunk)).toMatchObject({ slot: null, confirmedReplicas: 2, confirmSignature: 'sig1' });
  });

  it('retries a direct chunk no peer serves yet (incomplete), until its push arrives', async () => {
    const bytes = randomBytes(1_000);
    const chunk = solana.addDirect(bytes);
    solana.peers = [peer(newAddress(), 'http://a'), peer(newAddress(), 'http://b')];
    const fetchMock = servePeers({ [`http://a/chunk/${chunk}/data`]: 404 }); // b is unreachable
    const replicator = replicatorWith();

    expect(await replicator.scanOnce()).toMatchObject({ candidates: 1, stored: 0, confirmed: 0, errors: 1 });
    expect(replicator.backoff.get(chunk)).toMatchObject({ kind: 'incomplete', retryAt: now + DEFAULT_BACKOFF.baseMs });
    expect(replicator.status.lastError).toContain('not available from any peer yet (2 tried)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await replicator.scanOnce()).toMatchObject({ candidates: 0 }); // backed off

    expect(await replicator.acceptPush(chunk, bytes)).toMatchObject({ status: 201, confirmed: true });
    expect(replicator.backoff.get(chunk)).toBeUndefined();
    expect(solana.readChunk).not.toHaveBeenCalled();
  });

  it('makes a push wait while a scan works on the same chunk', async () => {
    const bytes = randomBytes(1_000);
    const chunk = solana.addDirect(bytes);
    solana.peers = [peer(newAddress(), 'http://slow')];
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await gate;
      return new Response('not here', { status: 404 });
    });
    const replicator = replicatorWith();

    const scan = replicator.scanOnce();
    while (fetchMock.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    let answered = false;
    const push = replicator.acceptPush(chunk, bytes).finally(() => (answered = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toBe(false);

    release();
    expect(await scan).toMatchObject({ stored: 0, errors: 1 });
    expect(await push).toMatchObject({ status: 201, stored: true, confirmed: true });
    expect(solana.confirmReplication).toHaveBeenCalledTimes(1);
  });
});
