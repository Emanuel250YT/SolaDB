/**
 * End-to-end tests against a local validator with the program deployed:
 *
 *   scripts/localnet.sh            # solana-test-validator + soladb.so, admin = .localnet/admin.json
 *   npm run test:sdk
 *
 * Skipped when no validator answers on SOLADB_TEST_RPC (default http://127.0.0.1:8899).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import {
  Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  KeyPairSigner,
  lamports,
} from '@solana/kit';
import {
  soladbInstructions,
  SolaDBClient,
  ChunkAccount,
  ConfigAccount,
  fetchAccount,
  pdas,
  readChunkFromLedger,
  sha256,
  toHex,
  TransactionSender,
} from '../src';

const RPC = process.env.SOLADB_TEST_RPC ?? 'http://127.0.0.1:8899';
const ADMIN = process.env.SOLADB_TEST_ADMIN ?? path.join(__dirname, '..', '..', '..', '.localnet', 'admin.json');
const SOL = 1_000_000_000n;

const rpc = createSolanaRpc(RPC);
const sender = new TransactionSender(rpc);
const ix = soladbInstructions();

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 7 + (i >> 9)) % 256);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function funded(sol = 20n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  await airdrop(signer.address, sol * SOL);
  return signer;
}

// ledger uploads of uncompressed bytes unless a test says otherwise (exact segment counts)
const client = (signer: KeyPairSigner, extra: Partial<ConstructorParameters<typeof SolaDBClient>[0]> = {}) =>
  new SolaDBClient({ rpc, signer, chunkSize: 256 * 1024, mode: 'ledger', compress: false, ...extra });

/** What a replicator node does: rebuild from the ledger, check, confirm */
async function replicate(node: KeyPairSigner, chunks: Address[]) {
  for (const chunk of chunks) {
    const account = await fetchAccount<ChunkAccount>(rpc, chunk, 'Chunk');
    assert.ok(account, 'chunk exists');
    const data = await readChunkFromLedger(rpc, chunk, account.data.contentHash);
    assert.equal(data.length, account.data.size);
    await sender.send({ feePayer: node, instructions: [await ix.confirmReplication(node, chunk, account.data.owner)] });
  }
}

describe('SolaDB on a local validator', { concurrency: false }, async () => {
  const skip = !(await available());
  let admin: KeyPairSigner;
  let node: KeyPairSigner;
  let alice: KeyPairSigner;
  let bob: KeyPairSigner;
  let config: ConfigAccount;
  const file = bytes(600_000, 3);
  let recordId: Address;
  let chunks: Address[];

  before(async () => {
    if (skip) return;
    admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN, 'utf8'))));
    await airdrop(admin.address, 50n * SOL);
    const configAddress = await pdas.config();
    if (!(await fetchAccount(rpc, configAddress, 'Config'))) {
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
    config = (await fetchAccount<ConfigAccount>(rpc, configAddress, 'Config'))!.data;
    node = await funded(5n);
    await sender.send({ feePayer: admin, instructions: [await ix.registerReplicator(admin, node.address, 'http://127.0.0.1:3999')] });
    [alice, bob] = await Promise.all([funded(), funded()]);
  });

  test('wallets register their encryption keys', { skip }, async () => {
    const a = client(alice);
    assert.equal(await a.isRegistered(), false);
    assert.ok(await a.register());
    assert.equal(await a.register(), null, 'second call is a no-op');
    assert.ok(await client(bob).register());
  });

  test('uploads a 600 KB file with a session key and v1 segment transactions', { skip }, async () => {
    const a = client(alice, { replicas: 2 });
    const treasuryBefore = (await rpc.getBalance(config.treasury).send()).value;
    const stages = new Set<string>();
    const result = await a.uploadFile(file, { name: 'contrato.pdf', mime: 'application/pdf', onProgress: (p) => stages.add(p.stage) });
    recordId = result.recordId;
    chunks = result.chunks;

    assert.equal(chunks.length, 3);
    assert.deepEqual([...stages], ['sign', 'open', 'segments', 'done']);
    assert.equal(result.segmentTransactions, Math.ceil((262_144 + 28) / 3864) * 2 + Math.ceil((600_000 - 2 * 262_144 + 28) / 3864));
    const statuses = await a.chunkStatus(chunks);
    assert.ok(statuses.every((s) => s.state === 'Hot' && s.requiredReplicas === 2));

    // protocol share of every chunk fee reached the treasury
    const treasuryAfter = (await rpc.getBalance(config.treasury).send()).value;
    assert.ok(treasuryAfter > treasuryBefore, 'treasury received the protocol fee');
    console.log(`  600 KB: ${result.segmentTransactions} segment txs, fee ${result.feePaid} lamports, rent ${result.rentDeposit}`);
  });

  test('downloads straight from the ledger while no replicator has it', { skip }, async () => {
    const { data, name, mime } = await client(alice).downloadFile(recordId);
    assert.equal(name, 'contrato.pdf');
    assert.equal(mime, 'application/pdf');
    assert.deepEqual(data, file);
  });

  test('a replicator confirmation pays it and turns the chunks Cool', { skip }, async () => {
    const before = (await rpc.getBalance(node.address).send()).value;
    await replicate(node, chunks);
    const after = (await rpc.getBalance(node.address).send()).value;
    let rewards = 0n;
    for (const chunk of chunks) rewards += (await fetchAccount<ChunkAccount>(rpc, chunk, 'Chunk'))!.data.rewardPerReplica;
    assert.equal(after - before, rewards - 3n * 5_000n, 'each confirmation pays its chunk reward');

    const { cool, chunks: status } = await client(alice).fileStatus(recordId);
    assert.ok(cool, '60 % of 2 replicas = 1 confirmation');
    assert.ok(status.every((c) => c.confirmedReplicas === 1 && c.replicators[0] === node.address));
  });

  test('sharing seals the manifest to the viewer; revoking removes it', { skip }, async () => {
    const a = client(alice);
    const b = client(bob);
    await assert.rejects(b.getManifest(recordId), /not shared/);
    await a.share(recordId, bob.address);
    assert.deepEqual(await a.viewers(recordId), [bob.address]);

    const { data } = await b.downloadFile(recordId);
    assert.deepEqual(data, file);
    const shared = (await b.listFiles()).find((f) => f.recordId === recordId);
    assert.ok(shared?.shared);
    assert.equal(shared.owner, alice.address);

    await a.share(recordId, bob.address); // re-sealing updates the grant in place
    await a.revoke(recordId, bob.address);
    await assert.rejects(b.getManifest(recordId), /not shared/);
  });

  test('large files keep the chunk list in an encrypted index chunk', { skip }, async () => {
    const big = bytes(100_000, 9);
    const a = client(alice, { chunkSize: 4_096 });
    const result = await a.uploadFile(big, { name: 'dataset.bin' });
    assert.equal(result.chunks.length, 26, '25 data chunks + 1 index chunk');
    const manifest = await a.getManifest(result.recordId);
    assert.ok(manifest.v === 2 && manifest.index, 'manifest points at the index chunk');
    assert.equal(manifest.chunkCount, 25);
    assert.deepEqual((await a.downloadFile(result.recordId)).data, big);
  });

  test('v0 transactions and owner-signed segments also work', { skip }, async () => {
    const small = bytes(5_000, 4);
    const a = client(alice, { segmentTxVersion: 0, sessionWriter: false });
    const result = await a.uploadFile(small, { name: 'nota.txt', mime: 'text/plain' });
    assert.equal(result.segmentTransactions, Math.ceil((5_000 + 28) / 1010));
    assert.deepEqual((await a.downloadFile(result.recordId)).data, small);
  });

  test('the last confirmation closes the chunk and refunds its rent; the file stays readable', { skip }, async () => {
    const a = client(alice, { replicas: 1 });
    const data = bytes(20_000, 5);
    const result = await a.uploadFile(data, { name: 'recibo.json' });
    const rent = (await rpc.getBalance(result.chunks[0]).send()).value - (await fetchAccount<ChunkAccount>(rpc, result.chunks[0], 'Chunk'))!.data.rewardPerReplica;

    const before = (await rpc.getBalance(alice.address).send()).value;
    await replicate(node, result.chunks);
    assert.equal((await rpc.getBalance(alice.address).send()).value - before, rent, 'rent came back without a transaction');
    assert.equal((await a.chunkStatus(result.chunks))[0].state, 'Closed');
    assert.equal((await a.reclaimDeposits(result.recordId)).closed, 0, 'nothing left to reclaim');
    assert.deepEqual((await a.downloadFile(result.recordId)).data, data, 'ledger history still serves it');
  });

  test('direct uploads: one wallet transaction, no ledger writes, compressed, rent back on replication', { skip }, async () => {
    const pushed = new Map<string, Uint8Array>();
    const a = client(alice, {
      mode: 'direct',
      compress: true,
      replicas: 1,
      pushChunk: async (ref, data) => void pushed.set(ref.address, data),
      fetchChunk: async (ref) => {
        const data = pushed.get(ref.address);
        if (!data) throw new Error('not pushed');
        return data;
      },
    });
    const csv = new TextEncoder().encode('fecha,monto,concepto\n2026-10-12,1500,hosting\n'.repeat(10_000));
    const quote = await a.quoteFile(csv.length, 1, 'direct');
    const ledgerQuote = await a.quoteFile(csv.length, 1, 'ledger');
    assert.equal(quote.segments, 0);
    assert.ok(quote.networkFee * 20n < ledgerQuote.networkFee, 'no segment transactions');

    const before = (await rpc.getBalance(alice.address).send()).value;
    const result = await a.uploadFile(csv, { name: 'gastos.csv', mime: 'text/csv' });
    assert.equal(result.mode, 'direct');
    assert.equal(result.segmentTransactions, 0);
    assert.equal(result.signatures.length, 1, 'one wallet transaction');
    assert.equal(result.chunks.length, 1);
    assert.ok(result.storedSize * 10 < csv.length, `gzip: ${csv.length} → ${result.storedSize} bytes`);

    const chunk = (await fetchAccount<ChunkAccount>(rpc, result.chunks[0], 'Chunk'))!.data;
    assert.equal(chunk.segmentSize, 0);
    assert.equal(chunk.state, 'Hot');
    assert.equal(chunk.size, result.storedSize + 28);
    // the node checks the pushed bytes against the on-chain hash, then confirms
    assert.equal(toHex(sha256(pushed.get(result.chunks[0])!)), toHex(chunk.contentHash));
    await sender.send({ feePayer: node, instructions: [await ix.confirmReplication(node, result.chunks[0], chunk.owner)] });
    assert.equal((await a.chunkStatus(result.chunks))[0].state, 'Closed');

    // the wallet paid the fee, one signature and the record's rent; the chunk's rent came back
    const spent = before - (await rpc.getBalance(alice.address).send()).value;
    const recordRent = await rpc.getMinimumBalanceForRentExemption(BigInt((await rpc.getAccountInfo(result.recordId, { encoding: 'base64' }).send()).value!.space)).send();
    assert.equal(spent, result.feePaid + recordRent + 5_000n);
    console.log(`  ${csv.length} B CSV direct: fee ${result.feePaid}, kept rent ${recordRent}, network 5000 lamports`);

    assert.deepEqual((await a.downloadFile(result.recordId)).data, csv);
    // no ledger copy: without a node holding it, the file is unavailable
    await assert.rejects(client(alice, { nodeUrls: [] }).downloadFile(result.recordId), /unavailable/);
  });

  test('listing and deleting files', { skip }, async () => {
    const a = client(alice);
    const files = await a.listFiles();
    assert.ok(files.length >= 4);
    assert.ok(files.some((f) => f.recordId === recordId && !f.shared));

    await a.share(recordId, bob.address);
    await a.deleteFile(recordId, { closeChunks: false });
    assert.ok(!(await a.listFiles()).some((f) => f.recordId === recordId));
    assert.ok(!(await client(bob).listFiles()).some((f) => f.recordId === recordId), 'grant was revoked with it');
  });

  test('rent of chunks no record points to can still be reclaimed', { skip }, async () => {
    const a = client(alice, { replicas: 1 });
    // an upload abandoned after opening its chunk
    const data = bytes(9_000, 8);
    const contentHash = sha256(data);
    await sender.send({
      feePayer: alice,
      instructions: [
        await ix.openChunk(alice, config.treasury, {
          contentHash,
          size: data.length,
          segmentSize: 1_000,
          replicas: 1,
          writer: alice.address,
          maxFee: SOL,
        }),
      ],
    });
    const chunk = await pdas.chunk(alice.address, contentHash);
    assert.equal((await a.chunkStatus([chunk]))[0].state, 'Pending');

    const { closed, lamports } = await a.reclaimAllDeposits();
    assert.ok(closed >= 1 && lamports > 0n);
    assert.equal((await a.chunkStatus([chunk]))[0].state, 'Closed');
  });
});
