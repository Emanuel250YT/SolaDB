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
  ReplicatorAccount,
} from '@soladb/sdk';
import { ReplicatorService, SETTLED_TTL_MS } from './replicator.service';
import { DEFAULT_BACKOFF } from './backoff';
import { SolanaService } from '../solana/solana.service';
import { StorageService } from '../storage/storage.service';
import { FsChunkStore } from '../storage/fs-chunk-store.service';
import { FileMetadataService } from '../storage/file-metadata.service';

const newAddress = () => getAddressDecoder().decode(randomBytes(32)) as Address;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

/**
 * In-memory stand-in for SolanaService: a set of Chunk accounts, the bytes
 * their write_segment transactions put in the ledger, and this node's
 * Replicator account.  Scans return snapshots, like an RPC would.
 */
class FakeSolana {
  readonly address = newAddress();
  readonly accounts = new Map<Address, ChunkAccount>();
  readonly ledger = new Map<Address, Uint8Array>();
  replicator: ReplicatorAccount | null = {
    authority: this.address,
    active: true,
    bump: 255,
    registeredAt: 1n,
    confirmations: 0n,
    lamportsEarned: 0n,
    endpoint: 'http://node',
  };
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

  confirmReplication = jest.fn(async (chunk: Address) => {
    if (this.confirmError) {
      const err = this.confirmError;
      this.confirmError = undefined;
      throw err;
    }
    const account = this.accounts.get(chunk);
    if (account.replicators.includes(this.address)) {
      throw new SolaDBTransactionError('AlreadyReplicated', SOLADB_ERRORS.AlreadyReplicated);
    }
    account.replicators.push(this.address);
    account.confirmedReplicas++;
    if (account.confirmedReplicas === account.requiredReplicas) account.needsReplicas = false;
    if (account.confirmedReplicas >= Math.max(1, Math.floor((account.requiredReplicas * 60) / 100))) account.state = 'Cool';
    return `sig${++this.signatures}`;
  });

  getChunk = jest.fn(async (chunk: Address) => (this.accounts.has(chunk) ? this.snapshot(chunk) : null));
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
    jest.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rebuilds a new chunk from the ledger, stores it and confirms it', async () => {
    const bytes = randomBytes(10_000);
    const chunk = solana.addChunk(bytes);
    const replicator = replicatorWith();

    const stats = await replicator.scanOnce();

    expect(stats).toEqual({ seen: 1, candidates: 1, stored: 1, confirmed: 1, skipped: 0, errors: 0 });
    expect(await storage.getRawChunk(chunk)).toEqual(bytes);
    expect(solana.confirmReplication).toHaveBeenCalledWith(chunk);
    const meta = await storage.getChunkMeta(chunk);
    expect(meta).toMatchObject({
      chunkId: chunk,
      contentHash: sha256(bytes).toString('hex'),
      size: 10_000,
      state: 'Cool',
      confirmedReplicas: 1,
      replicators: [solana.address],
      rewardPerReplica: '50000',
      slot: 4242,
      confirmSignature: 'sig1',
    });
    expect(meta.confirmedAt).toBeInstanceOf(Date);
    expect(replicator.status.totals).toMatchObject({ stored: 1, confirmed: 1, lamportsEarned: '50000' });
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
});
