/**
 * End-to-end check of erasure-coded blobs (docs/blob-protocol.md) with real
 * nodes against a local validator (scripts/localnet.sh; admin =
 * .localnet/admin.json):
 *
 *   npm run build -w @soladb/sdk && (cd soladb-node && npm run build)
 *   npx tsx soladb-node/test/e2e-blobs.ts          # from the repo root
 *
 * It starts three nodes, uploads a file as a 2+1 blob (one shard per node,
 * one wallet transaction), downloads it, stops one node and downloads it
 * from the other two, lets the nodes prove their shards and claim, takes the
 * stopped node's slot away with an unanswered challenge, starts a fourth
 * node that rebuilds the shard from the other two, and stores a bundle of
 * small files.  The test config uses 60-second epochs and short challenge
 * windows so the whole cycle fits in a few minutes.
 *
 * Env: SOLADB_TEST_RPC (default http://127.0.0.1:8899), SOLADB_TEST_ADMIN,
 *      E2E_BASE_PORT (3201), E2E_KEEP_DATA=1 to keep the temp directory.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Address, createKeyPairSignerFromBytes, createSolanaRpc, KeyPairSigner, lamports } from '@solana/kit';
import {
  BlobAccount,
  ConfigAccount,
  fetchAccount,
  pdas,
  PROGRAM_ADDRESS,
  ReplicatorAccount,
  soladbInstructions,
  SolaDBClient,
  TransactionSender,
  VACANT,
} from '@soladb/sdk';

const NODE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(NODE_DIR, '..');
const RPC = process.env.SOLADB_TEST_RPC ?? 'http://127.0.0.1:8899';
const ADMIN = process.env.SOLADB_TEST_ADMIN ?? path.join(ROOT, '.localnet', 'admin.json');
const BASE_PORT = Number(process.env.E2E_BASE_PORT ?? 3201);
const SOL = 1_000_000_000n;
const CHALLENGE_WINDOW_SLOTS = 40n;

const rpc = createSolanaRpc(RPC);
const sender = new TransactionSender(rpc);
const ix = soladbInstructions();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (message: string) => console.log(`[e2e ${elapsed()}] ${message}`);
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`[e2e ${elapsed()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function newKeypairBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Uint8Array.from([...seed, ...pub]);
}

async function balance(address: Address): Promise<bigint> {
  return (await rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;
}

async function airdrop(address: Address, amount: bigint): Promise<void> {
  const before = await balance(address);
  await rpc.requestAirdrop(address, lamports(amount)).send();
  for (let i = 0; i < 60; i++) {
    if ((await balance(address)) >= before + amount) return;
    await sleep(500);
  }
  throw new Error(`airdrop to ${address} did not land`);
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

interface Node {
  name: string;
  url: string;
  signer: KeyPairSigner;
  keyFile: string;
  dataDir: string;
  child: ChildProcess | null;
}

function startNode(node: Node, owner: Address, logFile: string): void {
  const main = path.join(NODE_DIR, 'dist', 'main.js');
  if (!fs.existsSync(main)) throw new Error(`${main} not found: run "npm run build" in soladb-node first`);
  const port = new URL(node.url).port;
  const child = spawn(process.execPath, [main], {
    cwd: NODE_DIR,
    env: {
      ...process.env,
      PORT: port,
      SOLANA_CLUSTER: 'localnet',
      SOLANA_RPC_URL: RPC,
      SOLANA_COMMITMENT: 'confirmed',
      REPLICATOR_KEYPAIR: node.keyFile,
      NODE_ENDPOINT: node.url,
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      BLOB_STORE: 'fs',
      DATA_DIR: node.dataDir,
      POLL_INTERVAL_MS: '2000',
      BLOB_POLL_INTERVAL_MS: '2000',
      BLOB_CLAIM_MIN_LAMPORTS: '1',
      BLOB_CHALLENGE_OTHERS: 'false',
      REPLICATE_OWNERS: owner,
      LOG_LEVEL: 'log',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const echo = (chunk: Buffer) => {
    out.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      if (/Blob|blob|shard|Error|error|WARN/.test(clean)) console.log(`  [${node.name}] ${clean.slice(0, 220)}`);
    }
  };
  child.stdout!.on('data', echo);
  child.stderr!.on('data', echo);
  node.child = child;
}

async function stopNode(node: Node): Promise<void> {
  const child = node.child;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  node.child = null;
}

async function waitForNode(node: Node, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (node.child?.exitCode !== null && node.child?.exitCode !== undefined) throw new Error(`${node.name} exited`);
    try {
      if ((await getJson(`${node.url}/status`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`${node.name} did not start`);
}

async function blobAccount(blob: Address): Promise<BlobAccount> {
  return (await fetchAccount<BlobAccount>(rpc, blob, 'Blob', 'confirmed'))!.data;
}

async function waitFor<T>(what: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await what();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(1_000);
    last = await what();
  }
  return last;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-blobs-e2e-'));
  const nodes: Node[] = [];
  try {
    const program = await rpc.getAccountInfo(PROGRAM_ADDRESS, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
    if (!program.value?.executable) throw new Error(`SolaDB program ${PROGRAM_ADDRESS} is not deployed on ${RPC}`);
    const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN, 'utf8'))));
    if ((await balance(admin.address)) < 10n * SOL) await airdrop(admin.address, 20n * SOL);

    // Test-friendly blob parameters: 60 s epochs, short challenge windows, no cooldown
    const configAddress = await pdas.config();
    const current = (await fetchAccount<ConfigAccount>(rpc, configAddress, 'Config'))?.data;
    if (!current) throw new Error('SolaDB is not initialized (npm run init:localnet)');
    await sender.send({
      feePayer: admin,
      instructions: [
        await ix.updateConfig(admin, {
          treasury: current.treasury,
          baseFeePerReplica: current.baseFeePerReplica,
          pricePerMib: current.pricePerMib,
          protocolFeeBps: current.protocolFeeBps,
          replicationThresholdPct: current.replicationThresholdPct,
          replicationWindow: current.replicationWindow,
          epochSeconds: 60n,
          pricePerMibEpoch: 100_000n,
          challengeWindowSlots: CHALLENGE_WINDOW_SLOTS,
          challengeCooldown: 0n,
          challengerBountyBps: 1_000,
        }),
      ],
    });
    log('config: 60 s epochs, 40-slot challenge windows (restore with npm run init:localnet)');

    const uploader = await createKeyPairSignerFromBytes(newKeypairBytes());
    await airdrop(uploader.address, 10n * SOL);

    for (let i = 0; i < 4; i++) {
      const keyFile = path.join(tmp, `node${i + 1}.json`);
      const bytes = newKeypairBytes();
      fs.writeFileSync(keyFile, JSON.stringify([...bytes]));
      const signer = await createKeyPairSignerFromBytes(bytes);
      const url = `http://127.0.0.1:${BASE_PORT + i}`;
      await airdrop(signer.address, 1n * SOL);
      await sender.send({ feePayer: admin, instructions: [await ix.registerReplicator(admin, signer.address, url)] });
      nodes.push({ name: `node${i + 1}`, url, signer, keyFile, dataDir: path.join(tmp, `data${i + 1}`), child: null });
    }
    const logFile = (n: Node) => path.join(tmp, `${n.name}.log`);
    for (const n of nodes.slice(0, 3)) startNode(n, uploader.address, logFile(n));
    for (const n of nodes.slice(0, 3)) await waitForNode(n);
    log(`3 nodes up: ${nodes.slice(0, 3).map((n) => n.url).join(', ')}`);

    // 1. Upload: 2+1 blob, one shard per node, one wallet transaction
    const client = new SolaDBClient({ rpc: RPC, signer: uploader, nodeUrls: nodes.slice(0, 3).map((n) => n.url), mode: 'blob', epochs: 5, nodeTimeoutMs: 5_000 });
    await client.register();
    const file = new Uint8Array(randomBytes(600_000));
    const t0 = Date.now();
    const upload = await client.uploadFile(file, { name: 'dataset.bin' });
    const blob = upload.blobs![0];
    const account = await blobAccount(blob);
    check(
      'a 600 KB file is one 2+1 blob: one wallet transaction, one shard per node, Cool right away',
      upload.signatures.length === 1 && upload.blobs!.length === 1 && account.dataShards === 2 && account.totalShards === 3 && account.held === 3 && account.state === 'Cool',
      `${((Date.now() - t0) / 1000).toFixed(1)}s, layout ${upload.layout!.k}+${upload.layout!.m}, held ${account.held}/3, fee ${upload.feePaid} lamports`,
    );
    const holders = account.slots.map((s) => nodes.find((n) => n.signer.address === s.holder)?.name ?? s.holder);
    check('each node holds a different shard', new Set(holders).size === 3 && holders.every((h) => h.startsWith('node')), holders.join(', '));

    const roots = await getJson(`${nodes[0].url}/blob/${blob}/roots`);
    check('GET /blob/:blob/roots serves the 3 shard roots', roots.status === 200 && roots.body.length === 3);

    // 2. Download, then with one node down
    const ok = async (c: SolaDBClient) => Buffer.compare(Buffer.from((await c.downloadFile(upload.recordId)).data), Buffer.from(file)) === 0;
    check('the file downloads from the nodes, every fragment verified', await ok(client));
    const lost = nodes[1];
    await stopNode(lost);
    const reader = new SolaDBClient({ rpc: RPC, signer: uploader, nodeUrls: nodes.filter((n) => n !== lost && n.child).map((n) => n.url), nodeTimeoutMs: 3_000 });
    check(`with ${lost.name} down the file is rebuilt from the other two shards`, await ok(reader));

    // 3. Storage proofs: live nodes challenge themselves, answer and claim
    const live = nodes.filter((n) => n.child);
    const earned = await waitFor(
      async () => Promise.all(live.map(async (n) => (await fetchAccount<ReplicatorAccount>(rpc, await pdas.replicator(n.signer.address), 'Replicator', 'confirmed'))!.data.lamportsEarned)),
      (v) => v.every((x) => x > 0n),
      120_000,
    );
    const status = await waitFor(async () => (await getJson(`${live[0].url}/blob/status`)).body, (st) => st.totals.claims >= 1, 30_000);
    check(
      'live nodes prove their shards (challenge + 1 KiB answer) and claim rewards',
      earned.every((x) => x > 0n) && status.totals.proofs >= 1 && status.totals.claims >= 1,
      `earned ${earned.join(' / ')} lamports; ${live[0].name}: ${status.totals.proofs} proofs, ${status.totals.claims} claims`,
    );

    // 4. The stopped node never answers: its slot is reported and reopens
    const lostIndex = (await blobAccount(blob)).slots.findIndex((s) => s.holder === lost.signer.address);
    await sender.send({ feePayer: uploader, instructions: [await ix.createChallenge(uploader, blob, lostIndex)] });
    const challenged = await blobAccount(blob);
    const deadline = challenged.slots[lostIndex].challengeDeadline;
    while ((await rpc.getSlot({ commitment: 'confirmed' }).send()) <= deadline) await sleep(1_000);
    const before = await balance(uploader.address);
    await sender.send({ feePayer: uploader, instructions: [await ix.failChallenge(uploader, blob, lostIndex)] });
    const reopened = await blobAccount(blob);
    check(
      `${lost.name} let its challenge expire: the slot reopens and the reporter gets a bounty`,
      reopened.slots[lostIndex].holder === VACANT && reopened.held === 2 && reopened.needsHolders,
      `held ${reopened.held}/3, bounty ${(await balance(uploader.address)) - before + 5_000n} lamports`,
    );

    // 5. A fourth node rebuilds the missing shard from the other two
    const fresh = nodes[3];
    startNode(fresh, uploader.address, logFile(fresh));
    await waitForNode(fresh);
    const repaired = await waitFor(() => blobAccount(blob), (b) => b.slots[lostIndex].holder === fresh.signer.address, 90_000);
    const freshStatus = (await getJson(`${fresh.url}/blob/status`)).body;
    check(
      `${fresh.name} rebuilds shard ${lostIndex} from 2 fragments per stripe and takes the slot`,
      repaired.slots[lostIndex].holder === fresh.signer.address && repaired.held === 3 && freshStatus.totals.rebuilt === 1,
      `held ${repaired.held}/3, rebuilt ${freshStatus.totals.rebuilt}`,
    );
    const viaFresh = new SolaDBClient({ rpc: RPC, signer: uploader, nodeUrls: [fresh.url], nodeTimeoutMs: 5_000 });
    check(`the file downloads again with ${fresh.name} in the set`, await ok(viaFresh));

    // 6. Many small files in one bundle
    const files = Array.from({ length: 30 }, (_, i) => ({ name: `nota-${i}.txt`, mime: 'text/plain', data: new TextEncoder().encode(`Nota ${i}: `.repeat(50 + i)) }));
    const bundleClient = new SolaDBClient({ rpc: RPC, signer: uploader, nodeUrls: nodes.filter((n) => n.child).map((n) => n.url), mode: 'blob', epochs: 2, nodeTimeoutMs: 5_000 });
    const bundle = await bundleClient.uploadFiles(files, { name: 'notas' });
    const entries = await bundleClient.downloadBundle(bundle.recordId);
    check(
      '30 small files go in one bundle: one blob account, one record, gzip',
      bundle.blobs!.length === 1 && entries.length === 30 && Buffer.compare(Buffer.from(entries[12].data), Buffer.from(files[12].data)) === 0,
      `${bundle.size} bytes → ${bundle.storedSize} stored`,
    );

    // 7. Push validation
    const taken = (await blobAccount(blob)).slots.findIndex((s) => s.holder !== nodes[0].signer.address);
    const wrongRoots = await getJson(`${nodes[0].url}/blob/${blob}/shard/${taken}?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-soladb-shard-roots': ['00'.repeat(32), '11'.repeat(32), '22'.repeat(32)].join(','), 'x-soladb-fragment-size': '1024' },
      body: new Uint8Array(1024) as BodyInit,
    });
    const unknown = await getJson(`${nodes[0].url}/blob/${uploader.address}/shard/0?offset=0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(1024) as BodyInit,
    });
    check('pushes are checked: a taken slot → 409, not a blob → 404', wrongRoots.status === 409 && unknown.status === 404, `taken=${wrongRoots.status} unknown=${unknown.status}`);
  } catch (err) {
    check('run completed', false, (err as Error).stack ?? String(err));
  } finally {
    for (const n of nodes) await stopNode(n);
    if (process.env.E2E_KEEP_DATA === '1') log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed in ${elapsed()}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
