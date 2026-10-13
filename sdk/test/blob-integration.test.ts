/**
 * Blob end-to-end tests against a local validator (scripts/localnet.sh),
 * with in-process "nodes" that do what soladb-node does over HTTP: accept
 * shard pushes, check them against the on-chain root, confirm_shard, serve
 * roots and fragments with proofs, and answer storage challenges.
 *
 * Skipped when no validator answers on SOLADB_TEST_RPC (default http://127.0.0.1:8899).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Address, createKeyPairSignerFromBytes, createSolanaRpc, generateKeyPairSigner, KeyPairSigner, lamports } from '@solana/kit';
import {
  BlobAccount,
  blobAccountSize,
  blobProof,
  blobRoot,
  challengedSegment,
  ConfigAccount,
  fetchAccount,
  fragmentProof,
  pdas,
  rewardBetween,
  segmentProof,
  shardLeafHashes,
  shardRoot,
  SLOT_HASHES_ADDRESS,
  soladbInstructions,
  SolaDBClient,
  toHex,
  TransactionSender,
} from '../src';

const RPC = process.env.SOLADB_TEST_RPC ?? 'http://127.0.0.1:8899';
const ADMIN = process.env.SOLADB_TEST_ADMIN ?? path.join(__dirname, '..', '..', '..', '.localnet', 'admin.json');
const SOL = 1_000_000_000n;

const rpc = createSolanaRpc(RPC);
const sender = new TransactionSender(rpc);
const ix = soladbInstructions();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const random = (n: number) => new Uint8Array(randomBytes(n));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function available(): Promise<boolean> {
  try {
    await rpc.getHealth().send();
    return fs.existsSync(ADMIN);
  } catch {
    return false;
  }
}

async function airdrop(address: Address, amount: bigint) {
  const before = (await rpc.getBalance(address).send()).value;
  await rpc.requestAirdrop(address, lamports(amount)).send();
  for (let i = 0; i < 60; i++) {
    if ((await rpc.getBalance(address).send()).value >= before + amount) return;
    await sleep(500);
  }
  throw new Error('airdrop did not land');
}

async function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

/** A minimal replicator node: the blob HTTP API backed by memory */
class FakeNode {
  server!: http.Server;
  url = '';
  readonly shards = new Map<string, { data: Uint8Array; roots: Uint8Array[]; fragmentSize: number; index: number }>();
  private readonly incoming = new Map<string, { parts: Uint8Array[]; length: number; roots: Uint8Array[]; fragmentSize: number }>();

  constructor(readonly signer: KeyPairSigner) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        res.writeHead(500).end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/status') return json(200, { registered: true, active: true });
    if (parts[0] !== 'blob') return json(404, {});
    const blob = parts[1] as Address;
    if (req.method === 'PUT' && parts[2] === 'shard') {
      const index = Number(parts[3]);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const body = await readBody(req);
      const account = await fetchAccount<BlobAccount>(rpc, blob, 'Blob', 'confirmed');
      if (!account) return json(404, { error: 'no blob yet' });
      const key = `${blob}/${index}`;
      if (offset === 0) {
        const roots = String(req.headers['x-soladb-shard-roots']).split(',').map(fromHex);
        if (toHex(blobRoot(roots)) !== toHex(account.data.root)) return json(400, { error: 'roots' });
        this.incoming.set(key, { parts: [], length: 0, roots, fragmentSize: Number(req.headers['x-soladb-fragment-size']) });
      }
      const state = this.incoming.get(key)!;
      state.parts.push(body);
      state.length += body.length;
      if (state.length < Number(account.data.shardSize)) return json(202, { received: state.length });
      const data = new Uint8Array(state.length);
      let at = 0;
      for (const p of state.parts) {
        data.set(p, at);
        at += p.length;
      }
      this.incoming.delete(key);
      if (toHex(shardRoot(data)) !== toHex(state.roots[index])) return json(400, { error: 'shard root' });
      this.shards.set(key, { data, roots: state.roots, fragmentSize: state.fragmentSize, index });
      const signature = await sender.send({ feePayer: this.signer, instructions: [await ix.confirmShard(this.signer, blob, index)] });
      return json(201, { stored: true, confirmed: true, signature });
    }
    const held = [...this.shards.entries()].find(([k]) => k.startsWith(`${blob}/`));
    if (!held) return json(404, {});
    if (req.method === 'GET' && parts[2] === 'roots') return json(200, held[1].roots.map(toHex));
    if (req.method === 'GET' && parts[2] === 'shard' && parts[4] === 'fragment') {
      const shard = this.shards.get(`${blob}/${Number(parts[3])}`);
      if (!shard) return json(404, {});
      const stripe = Number(parts[5]);
      const F = shard.fragmentSize;
      const proof = fragmentProof(shardLeafHashes(shard.data), F / 1024, stripe).map(toHex).join(',');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-soladb-proof': proof });
      res.end(Buffer.from(shard.data.subarray(stripe * F, (stripe + 1) * F)));
      return undefined;
    }
    return json(404, {});
  }

  /** Answer the open challenge on our slot of `blob` */
  async prove(blob: Address): Promise<string> {
    const account = (await fetchAccount<BlobAccount>(rpc, blob, 'Blob', 'confirmed'))!.data;
    const index = account.slots.findIndex((s) => s.holder === this.signer.address);
    const slot = account.slots[index];
    while ((await rpc.getSlot({ commitment: 'confirmed' }).send()) <= slot.challengeSlot) await sleep(200);
    const info = await rpc.getAccountInfo(SLOT_HASHES_ADDRESS, { encoding: 'base64', commitment: 'confirmed' }).send();
    const data = Buffer.from(info.value!.data[0], 'base64');
    let hash: Uint8Array | null = null;
    for (let i = 0; i < Number(data.readBigUInt64LE(0)); i++) {
      if (data.readBigUInt64LE(8 + i * 40) === slot.challengeSlot) hash = new Uint8Array(data.subarray(16 + i * 40, 48 + i * 40));
    }
    assert.ok(hash, 'challenge slot is in SlotHashes');
    const shard = this.shards.get(`${blob}/${index}`)!;
    const segment = Number(challengedSegment(hash!, blob, index, account.shardSize / 1024n));
    const leaves = shardLeafHashes(shard.data);
    const program = await rpc.getAccountInfo(await pdas.programData(), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
    const loaded = Number(program.value!.space) + 36 + 8 + 512 * 40 + blobAccountSize(account.totalShards) + 512;
    return sender.send({
      feePayer: this.signer,
      instructions: [
        ix.proveShard(this.signer, blob, index, shard.data.subarray(segment * 1024, (segment + 1) * 1024), segmentProof(leaves, segment), blobProof(shard.roots, index)),
      ],
      options: { version: 1, computeUnitLimit: 120_000, loadedAccountsDataSizeLimit: Math.ceil(loaded / 32_768) * 32_768 },
    });
  }
}

describe('Blobs on a local validator', { concurrency: false }, async () => {
  const skip = !(await available());
  let admin: KeyPairSigner;
  let alice: KeyPairSigner;
  let config: ConfigAccount;
  const nodes: FakeNode[] = [];
  let client: SolaDBClient;
  const file = random(300_000);
  let recordId: Address;
  let blobs: Address[];

  before(async () => {
    if (skip) return;
    admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN, 'utf8'))));
    await airdrop(admin.address, 20n * SOL);
    if (!(await fetchAccount(rpc, await pdas.config(), 'Config'))) {
      await sender.send({
        feePayer: admin,
        instructions: [
          await ix.initialize(admin, {
            treasury: admin.address,
            baseFeePerReplica: 20_000n,
            pricePerMib: 2_097_152n,
            protocolFeeBps: 1_000,
            replicationThresholdPct: 60,
            replicationWindow: 3_600n,
            epochSeconds: 60n,
            pricePerMibEpoch: 1_000n,
            challengeWindowSlots: 150n,
            challengeCooldown: 0n,
            challengerBountyBps: 1_000,
          }),
        ],
      });
    }
    config = (await fetchAccount<ConfigAccount>(rpc, await pdas.config(), 'Config'))!.data;
    if (config.challengeCooldown > 0n || config.epochSeconds > 600n) {
      // production-like parameters (npm run init:localnet): short epochs, no cooldown for the test
      await sender.send({
        feePayer: admin,
        instructions: [
          await ix.updateConfig(admin, { ...config, epochSeconds: 60n, pricePerMibEpoch: 1_000n, challengeWindowSlots: 150n, challengeCooldown: 0n }),
        ],
      });
      config = (await fetchAccount<ConfigAccount>(rpc, await pdas.config(), 'Config'))!.data;
    }
    for (let i = 0; i < 3; i++) {
      const node = new FakeNode(await generateKeyPairSigner());
      await airdrop(node.signer.address, 2n * SOL);
      await node.start();
      await sender.send({ feePayer: admin, instructions: [await ix.registerReplicator(admin, node.signer.address, node.url)] });
      nodes.push(node);
    }
    alice = await generateKeyPairSigner();
    await airdrop(alice.address, 20n * SOL);
    client = new SolaDBClient({ rpc, signer: alice, nodeUrls: nodes.map((n) => n.url), mode: 'blob', epochs: 3, compress: false });
    await client.register();
  });

  after(async () => {
    for (const node of nodes) await node.stop().catch(() => undefined);
  });

  test('a blob upload is one wallet transaction, one shard per node, any 2 of 3 rebuild the file', { skip }, async () => {
    const quote = await client.quoteFile(file.length, 1, 'blob');
    assert.deepEqual(quote.layout, { k: 2, m: 1 });
    const result = await client.uploadFile(file, { name: 'video.bin' });
    recordId = result.recordId;
    blobs = result.blobs!;
    assert.equal(result.mode, 'blob');
    assert.equal(result.signatures.length, 1, 'one wallet transaction');
    assert.equal(blobs.length, 1, 'one account for the whole file');
    assert.deepEqual(result.layout && [result.layout.k, result.layout.m], [2, 1]);
    assert.equal(result.feePaid, quote.uploadFee);
    assert.equal(nodes.filter((n) => n.shards.size === 1).length, 3, 'each node holds one shard');

    const blob = (await fetchAccount<BlobAccount>(rpc, blobs[0], 'Blob'))!.data;
    assert.equal(blob.state, 'Cool');
    assert.equal(blob.held, 3);
    assert.equal(blob.needsHolders, false);
    assert.equal(blob.expiresAt - blob.openedAt, 3n * config.epochSeconds);
    // stored bytes = 1.5 × the payload (2+1), not 2–3 full copies
    const stored = nodes.reduce((sum, n) => sum + [...n.shards.values()][0].data.length, 0);
    assert.ok(stored < file.length * 1.6, `${stored} bytes stored for ${file.length}`);
    console.log(`  300 KB → ${stored} bytes on 3 nodes (2+1), fee ${result.feePaid} lamports, rent ${result.rentDeposit}`);

    assert.deepEqual((await client.downloadFile(recordId)).data, file);
    const status = await client.fileStatus(recordId);
    assert.ok(status.cool);
    assert.equal(status.blobs![0].held, 3);
  });

  test('the file survives a lost node', { skip }, async () => {
    const lost = nodes[1];
    await lost.stop();
    const reader = new SolaDBClient({ rpc, signer: alice, nodeUrls: nodes.filter((n) => n !== lost).map((n) => n.url), nodeTimeoutMs: 3_000 });
    assert.deepEqual((await reader.downloadFile(recordId)).data, file, 'rebuilt from the other two shards');
    await lost.start();
    // re-register its new port so later tests can reach it
    await sender.send({ feePayer: lost.signer, instructions: [await ix.updateReplicatorEndpoint(lost.signer, lost.url)] });
  });

  test('storage proofs: a challenge is answered with a 1 KiB segment, then rewards are claimed', { skip }, async () => {
    const node = nodes[0];
    const blob = blobs[0];
    await sleep(3_000); // let some reward accrue
    await sender.send({ feePayer: alice, instructions: [await ix.createChallenge(alice, blob, findSlot(await blobAccount(blob), node))] });
    const signature = await node.prove(blob);
    assert.ok(signature);
    const account = await blobAccount(blob);
    const slot = account.slots[findSlot(account, node)];
    assert.equal(slot.challengeSlot, 0n, 'challenge answered');
    assert.ok(slot.provenAt > slot.claimedUntil);

    const expected = rewardBetween(account, config.epochSeconds, slot.claimedUntil, slot.provenAt);
    const before = (await rpc.getBalance(node.signer.address).send()).value;
    await sender.send({ feePayer: node.signer, instructions: [await ix.claimShardRewards(node.signer, blob, findSlot(account, node))] });
    const after = (await rpc.getBalance(node.signer.address).send()).value;
    assert.equal(after - before, expected - 5_000n);
    console.log(`  proof ${signature.slice(0, 16)}…, claimed ${expected} lamports`);
  });

  test('many small files fit one bundle: one blob account, one record', { skip }, async () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      name: `factura-${i}.json`,
      mime: 'application/json',
      data: new TextEncoder().encode(JSON.stringify({ id: i, total: i * 100, items: Array(i).fill('servicio') })),
    }));
    const compressing = new SolaDBClient({ rpc, signer: alice, nodeUrls: nodes.map((n) => n.url), mode: 'blob', epochs: 2 });
    const result = await compressing.uploadFiles(files, { name: 'facturas-octubre' });
    assert.equal(result.blobs!.length, 1);
    assert.equal(result.signatures.length, 1);
    assert.equal(result.entries.length, 40);
    const entries = await compressing.downloadBundle(result.recordId);
    assert.equal(entries.length, 40);
    assert.deepEqual(entries[7].data, files[7].data);
    const one = await compressing.downloadFile(result.recordId, { entry: 'factura-39.json' });
    assert.deepEqual(one.data, files[39].data);
    assert.ok((await compressing.listFiles()).some((f) => f.recordId === result.recordId));
  });

  test('extending a blob prepays more epochs', { skip }, async () => {
    const before = await blobAccount(blobs[0]);
    await client.extendFile(recordId, 2);
    const after = await blobAccount(blobs[0]);
    assert.equal(after.epochs, before.epochs + 2);
    assert.equal(after.expiresAt, before.expiresAt + 2n * config.epochSeconds);
  });
});

async function blobAccount(blob: Address): Promise<BlobAccount> {
  return (await fetchAccount<BlobAccount>(rpc, blob, 'Blob', 'confirmed'))!.data;
}

function findSlot(blob: BlobAccount, node: FakeNode): number {
  return blob.slots.findIndex((s) => s.holder === node.signer.address);
}
