import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, getAddressDecoder } from '@solana/kit';
import {
  BlobAccount,
  ConfigAccount,
  encodeBlobs,
  EncodedBlob,
  FetchedAccount,
  fragmentProof,
  randomKey,
  ReplicatorAccount,
  shardLeafHashes,
  ShardSlot,
  VACANT,
  verifyFragment,
  verifyStorageProof,
  challengedSegment,
} from '@soladb/sdk';
import { BlobService } from './blob.service';
import { SolanaService } from '../solana/solana.service';
import { StorageService } from '../storage/storage.service';
import { FsChunkStore } from '../storage/fs-chunk-store.service';
import { FsBlobStore } from '../storage/fs-blob-store.service';
import { FileMetadataService } from '../storage/file-metadata.service';

const newAddress = () => getAddressDecoder().decode(randomBytes(32)) as Address;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const NOW = 1_800_000_000n;

const vacant = (): ShardSlot => ({ holder: VACANT, provenAt: 0n, claimedUntil: 0n, lastChallengeAt: 0n, challengeSlot: 0n, challengeDeadline: 0n });

/** In-memory stand-in for the blob side of SolanaService */
class FakeSolana {
  readonly address = newAddress();
  readonly blobs = new Map<Address, BlobAccount>();
  readonly forged = new Set<Address>();
  owners: Address[] = [];
  replicator: ReplicatorAccount | null = { authority: this.address, active: true, bump: 255, registeredAt: 1n, confirmations: 0n, lamportsEarned: 0n, endpoint: 'http://me' };
  peers: ReplicatorAccount[] = [];
  slot = 1_000n;
  slotHash = new Uint8Array(randomBytes(32));
  config: ConfigAccount = {
    epochSeconds: 60n,
    challengeCooldown: 0n,
    challengeWindowSlots: 100n,
  } as ConfigAccount;
  proofs: { blob: Address; index: number; segment: Uint8Array; shardProof: Uint8Array[]; topProof: Uint8Array[] }[] = [];

  addBlob(encoded: EncodedBlob, k: number, overrides: Partial<BlobAccount> = {}): Address {
    const address = newAddress();
    this.blobs.set(address, {
      owner: newAddress(),
      root: encoded.root,
      state: 'Hot',
      needsHolders: true,
      bump: 254,
      dataShards: k,
      totalShards: encoded.shards.length,
      held: 0,
      shardSize: BigInt(encoded.shardSize),
      payloadSize: BigInt(encoded.payloadLength),
      epochs: 10,
      rewardPerShardEpoch: 60_000n,
      openedAt: NOW - 100n,
      expiresAt: NOW + 600n,
      slots: encoded.shards.map(vacant),
      ...overrides,
    });
    return address;
  }

  hold(blob: Address, index: number, holder: Address, overrides: Partial<ShardSlot> = {}): void {
    const account = this.blobs.get(blob)!;
    account.slots[index] = { ...vacant(), holder, provenAt: NOW - 50n, claimedUntil: NOW - 50n, lastChallengeAt: NOW - 50n, ...overrides };
    account.held = account.slots.filter((s) => s.holder !== VACANT).length;
  }

  private snapshot(address: Address): FetchedAccount<BlobAccount> {
    return { address, data: structuredClone(this.blobs.get(address)!), lamports: 10_000_000n };
  }

  getBlob = jest.fn(async (blob: Address) => (this.blobs.has(blob) ? this.snapshot(blob) : null));
  getBlobs = jest.fn(async (blobs: Address[]) => blobs.map((b) => (this.blobs.has(b) ? this.snapshot(b) : null)));
  listBlobsNeedingHolders = jest.fn(async () => [...this.blobs.keys()].filter((b) => this.blobs.get(b)!.needsHolders).map((b) => this.snapshot(b)));
  listBlobs = jest.fn(async () => [...this.blobs.keys()].map((b) => this.snapshot(b)));
  isBlobAddress = jest.fn(async (blob: Address) => !this.forged.has(blob));
  replicatesOwner = (owner: Address) => this.owners.length === 0 || this.owners.includes(owner);
  getConfig = jest.fn(async () => this.config);
  getReplicator = jest.fn(async () => this.replicator);
  listReplicators = jest.fn(async () => this.peers);
  currentSlot = jest.fn(async () => this.slot);
  getSlotHash = jest.fn(async () => this.slotHash);

  confirmShard = jest.fn(async (blob: Address, index: number) => {
    const account = this.blobs.get(blob)!;
    if (account.slots[index].holder !== VACANT) throw new Error('SlotOccupied');
    this.hold(blob, index, this.address, { provenAt: NOW, claimedUntil: NOW, lastChallengeAt: NOW });
    account.needsHolders = account.held < account.totalShards;
    return `confirm-${index}`;
  });
  createChallenge = jest.fn(async (blob: Address, index: number) => {
    const slot = this.blobs.get(blob)!.slots[index];
    slot.challengeSlot = this.slot + 2n;
    slot.challengeDeadline = slot.challengeSlot + 100n;
    return 'challenge';
  });
  proveShard = jest.fn(async (blob: Address, index: number, segment: Uint8Array, shardProof: Uint8Array[], topProof: Uint8Array[]) => {
    this.proofs.push({ blob, index, segment, shardProof, topProof });
    const slot = this.blobs.get(blob)!.slots[index];
    slot.challengeSlot = 0n;
    slot.provenAt = NOW;
    return 'proof';
  });
  claimShardRewards = jest.fn(async () => 'claim');
}

describe('BlobService', () => {
  let dataDir: string;
  let storage: StorageService;
  let blobStore: FsBlobStore;
  let solana: FakeSolana;
  let service: BlobService;
  const dek = randomKey();

  /** A 2+1 blob of a random payload: 3 shards of `stripes` 1 KiB fragments */
  const makeBlob = (payload = 5_000) =>
    encodeBlobs(new Uint8Array(randomBytes(payload)), { k: 2, m: 1, fragmentSize: 1024, stripesPerBlob: 1024 }, dek)[0];
  const rootsHeader = (encoded: EncodedBlob) => encoded.shardRoots.map(hex).join(',');

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-blobs-'));
    const cfg = new ConfigService({
      storage: { dataDir, chunkStore: 'fs', metadataStore: 'file', blobStore: 'fs' },
      replication: { minRewardLamports: 0n, nodeEndpoint: 'http://me' },
      blobs: { enabled: false, claimMinLamports: 1_000n },
    });
    const chunks = new FsChunkStore(cfg);
    const metadata = new FileMetadataService(cfg);
    blobStore = new FsBlobStore(cfg);
    await chunks.onModuleInit();
    await metadata.onModuleInit();
    await blobStore.onModuleInit();
    storage = new StorageService(chunks, metadata, cfg, blobStore);
    solana = new FakeSolana();
    service = new BlobService(solana as unknown as SolanaService, storage, blobStore, cfg);
    jest.spyOn(Date, 'now').mockImplementation(() => Number(NOW) * 1000);
    (service as unknown as { config: ConfigAccount }).config = solana.config;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const expectStatus = async (promise: Promise<unknown>, status: number) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    await promise.catch((err: HttpException) => expect(err.getStatus()).toBe(status));
  };

  it('stores a pushed shard in pieces, checks it against the blob root and confirms it', async () => {
    const encoded = makeBlob(20_000);
    const blob = solana.addBlob(encoded, 2);
    const shard = Buffer.from(encoded.shards[1]);
    const half = 4 * 1024;
    const first = await service.acceptPush(blob, 1, 0, shard.subarray(0, half), { roots: rootsHeader(encoded), fragmentSize: '1024' });
    expect(first).toEqual({ status: 202, received: half });
    const done = await service.acceptPush(blob, 1, half, shard.subarray(half), {});
    expect(done).toMatchObject({ status: 201, stored: true, confirmed: true, signature: 'confirm-1' });
    expect(solana.confirmShard).toHaveBeenCalledWith(blob, 1);
    expect((await storage.getBlobShard(blob, 1))?.state).toBe('Confirmed');

    // readers verify every fragment against the shard root
    const info = await service.info(blob);
    expect(info.roots).toEqual(encoded.shardRoots.map(hex));
    for (let stripe = 0; stripe < encoded.stripes; stripe++) {
      const { data, proof } = await service.fragment(blob, 1, stripe);
      expect(verifyFragment(new Uint8Array(data), stripe, proof.map((p) => new Uint8Array(Buffer.from(p, 'hex'))), encoded.shardRoots[1])).toBe(true);
    }
    // a repeated push is a no-op
    expect(await service.acceptPush(blob, 1, 0, shard, { roots: rootsHeader(encoded), fragmentSize: '1024' })).toMatchObject({ status: 200 });
  });

  it('rejects pushes that do not match the paid commitment', async () => {
    const encoded = makeBlob();
    const blob = solana.addBlob(encoded, 2);
    const shard = Buffer.from(encoded.shards[0]);
    const header = { roots: rootsHeader(encoded), fragmentSize: '1024' };
    await expectStatus(service.acceptPush(newAddress(), 0, 0, shard, header), 404);
    const forged = solana.addBlob(encoded, 2);
    solana.forged.add(forged);
    await expectStatus(service.acceptPush(forged, 0, 0, shard, header), 404);
    await expectStatus(service.acceptPush(blob, 0, 0, shard, { ...header, roots: rootsHeader(makeBlob()) }), 400);
    await expectStatus(service.acceptPush(blob, 0, 0, shard, { ...header, fragmentSize: '1000' }), 400);
    await expectStatus(service.acceptPush(blob, 0, 4096, shard, header), 409);
    await expectStatus(service.acceptPush(blob, 3, 0, shard, header), 400);

    // bytes that do not hash to the shard root are dropped
    const tampered = Buffer.from(shard);
    tampered[10] ^= 1;
    await expectStatus(service.acceptPush(blob, 0, 0, tampered, header), 400);
    expect(await blobStore.stagedSize(`${blob}/0`)).toBe(0);
    expect(solana.confirmShard).not.toHaveBeenCalled();

    // someone else's slot, a second slot of the same blob, an expired blob, a foreign owner
    solana.hold(blob, 2, newAddress());
    await expectStatus(service.acceptPush(blob, 2, 0, Buffer.from(encoded.shards[2]), header), 409);
    solana.hold(blob, 1, solana.address);
    await expectStatus(service.acceptPush(blob, 0, 0, shard, header), 409);
    const late = solana.addBlob(encoded, 2, { expiresAt: NOW - 1n });
    await expectStatus(service.acceptPush(late, 0, 0, shard, header), 409);
    solana.owners = [newAddress()];
    const foreign = solana.addBlob(encoded, 2);
    await expectStatus(service.acceptPush(foreign, 0, 0, shard, header), 403);
  });

  it('answers a challenge with a storage proof the program accepts', async () => {
    const encoded = makeBlob(30_000);
    const blob = solana.addBlob(encoded, 2);
    await service.acceptPush(blob, 2, 0, Buffer.from(encoded.shards[2]), { roots: rootsHeader(encoded), fragmentSize: '1024' });
    const slot = solana.blobs.get(blob)!.slots[2];
    slot.challengeSlot = 990n;
    slot.challengeDeadline = 1_090n;
    await service.maintainHoldings();
    expect(solana.proofs).toHaveLength(1);
    const proof = solana.proofs[0];
    const segment = Number(challengedSegment(solana.slotHash, blob, 2, BigInt(encoded.shardSize) / 1024n));
    expect(
      verifyStorageProof({
        segment: proof.segment,
        segmentIndex: segment,
        shardProof: proof.shardProof,
        topProof: proof.topProof,
        shardIndex: 2,
        root: encoded.root,
        shardSize: encoded.shardSize,
        totalShards: 3,
      }),
    ).toBe(true);
    expect((await storage.getBlobShard(blob, 2))?.provenAt).toBeTruthy();
  });

  it('challenges itself when rewards accrue, then claims what the proof unlocked', async () => {
    const encoded = makeBlob();
    const blob = solana.addBlob(encoded, 2);
    await service.acceptPush(blob, 0, 0, Buffer.from(encoded.shards[0]), { roots: rootsHeader(encoded), fragmentSize: '1024' });
    // 60 s later: 60 000 lamports unproven ≥ BLOB_CLAIM_MIN_LAMPORTS → self-challenge
    const slot = solana.blobs.get(blob)!.slots[0];
    slot.provenAt = NOW - 60n;
    slot.claimedUntil = NOW - 60n;
    await service.maintainHoldings();
    expect(solana.createChallenge).toHaveBeenCalledWith(blob, 0);
    expect(solana.claimShardRewards).not.toHaveBeenCalled();

    // once proven, the next pass claims
    slot.challengeSlot = 0n;
    slot.provenAt = NOW;
    slot.lastChallengeAt = NOW;
    await service.maintainHoldings();
    expect(solana.claimShardRewards).toHaveBeenCalledWith(blob, 0);
    expect(service.status.totals.claims).toBe(1);
  });

  it('drops a shard whose slot it lost', async () => {
    const encoded = makeBlob();
    const blob = solana.addBlob(encoded, 2);
    await service.acceptPush(blob, 1, 0, Buffer.from(encoded.shards[1]), { roots: rootsHeader(encoded), fragmentSize: '1024' });
    solana.blobs.get(blob)!.slots[1] = vacant();
    await service.maintainHoldings();
    expect((await storage.getBlobShard(blob, 1))?.state).toBe('Lost');
    expect(await blobStore.size(`${blob}/1`)).toBeNull();
    await expect(service.fragment(blob, 1, 0)).rejects.toBeInstanceOf(HttpException);
  });

  it('rebuilds a vacant shard from k other holders and takes the slot', async () => {
    const encoded = makeBlob(12_000);
    const blob = solana.addBlob(encoded, 2);
    const holders = [newAddress(), newAddress()];
    solana.hold(blob, 0, holders[0]);
    solana.hold(blob, 2, holders[1]);
    solana.peers = holders.map((authority, i) => ({ authority, active: true, bump: 1, registeredAt: 1n, confirmations: 0n, lamportsEarned: 0n, endpoint: `http://peer${i}` }));
    const byUrl: Record<string, number> = { 'http://peer0': 0, 'http://peer1': 2 };
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const index = byUrl[url.origin];
      const parts = url.pathname.split('/');
      if (url.pathname.endsWith('/info')) {
        return new Response(JSON.stringify({ blob, root: hex(encoded.root), dataShards: 2, totalShards: 3, shardSize: encoded.shardSize, fragmentSize: 1024, roots: encoded.shardRoots.map(hex) }));
      }
      const stripe = Number(parts[6]);
      const shard = encoded.shards[index];
      const proof = fragmentProof(shardLeafHashes(shard), 1, stripe).map(hex).join(',');
      return new Response(Buffer.from(shard.subarray(stripe * 1024, (stripe + 1) * 1024)), { headers: { 'x-soladb-proof': proof } });
    });

    expect(await service.repairOne()).toBe(true);
    expect(solana.confirmShard).toHaveBeenCalledWith(blob, 1);
    const rebuilt = await blobStore.readRange(`${blob}/1`, 0, encoded.shardSize);
    expect(Buffer.compare(rebuilt!, Buffer.from(encoded.shards[1]))).toBe(0);
    expect(service.status.totals.rebuilt).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('does not rebuild a blob that cannot be reconstructed yet', async () => {
    const encoded = makeBlob();
    const blob = solana.addBlob(encoded, 2);
    solana.hold(blob, 0, newAddress()); // 1 holder < k = 2
    expect(await service.repairOne()).toBe(false);
    expect(solana.confirmShard).not.toHaveBeenCalled();
  });
});
