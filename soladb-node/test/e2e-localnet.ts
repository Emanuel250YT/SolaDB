/**
 * End-to-end check of the replicator node against a local validator with the
 * SolaDB program deployed (scripts/localnet.sh; admin = .localnet/admin.json):
 *
 *   npm run build -w @soladb/sdk && (cd soladb-node && npm run build)
 *   npx tsx soladb-node/test/e2e-localnet.ts          # from the repo root
 *
 * It registers a fresh replicator, starts the built node (dist/main.js) with
 * the fs + file stores, uploads a ~300 KB file with 1 replica, waits for the
 * node to confirm every chunk (Cool, rewards paid), downloads the file through
 * the node only, checks the HTTP API, then restarts the node on the same data
 * directory and checks it still serves the chunks.
 *
 * The node only replicates the test uploader's chunks (REPLICATE_OWNERS), so
 * it never interferes with other tests sharing the validator.
 *
 * Env: SOLADB_TEST_RPC (default http://127.0.0.1:8899), SOLADB_TEST_ADMIN,
 *      E2E_NODE_PORT (3100), E2E_COMMITMENT (confirmed | finalized),
 *      E2E_KEEP_DATA=1 to keep the temp directory.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  KeyPairSigner,
  lamports,
} from '@solana/kit';
import {
  SOLADB_ERRORS,
  soladbInstructions,
  SolaDBClient,
  ChunkAccount,
  fetchAccount,
  fetchAccounts,
  pdas,
  PROGRAM_ADDRESS,
  ReplicatorAccount,
  TransactionSender,
} from '@soladb/sdk';

const NODE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(NODE_DIR, '..');
const RPC = process.env.SOLADB_TEST_RPC ?? 'http://127.0.0.1:8899';
const ADMIN = process.env.SOLADB_TEST_ADMIN ?? path.join(ROOT, '.localnet', 'admin.json');
const PORT = Number(process.env.E2E_NODE_PORT ?? 3100);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const FILE_SIZE = 300_000;
// Node read commitment: "confirmed" keeps the run short; "finalized" is the production default
const COMMITMENT = process.env.E2E_COMMITMENT ?? 'confirmed';
const SOL = 1_000_000_000n;
const SIGNATURE_FEE = 5_000n;

const rpc = createSolanaRpc(RPC);
const sender = new TransactionSender(rpc);
const ix = soladbInstructions();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');

// ── Reporting ────────────────────────────────────────────────────────────────

const results: { name: string; ok: boolean; detail: string }[] = [];
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

function log(message: string): void {
  console.log(`[e2e ${elapsed()}] ${message}`);
}

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`[e2e ${elapsed()}] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A fresh keypair in the solana-keygen JSON format (64 bytes) */
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
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

/** Start dist/main.js; its log lines are echoed with a [node] prefix */
function startNode(env: Record<string, string>, logFile: string): ChildProcess {
  const main = path.join(NODE_DIR, 'dist', 'main.js');
  if (!fs.existsSync(main)) throw new Error(`${main} not found: run "npm run build" in soladb-node first`);
  const child = spawn(process.execPath, [main], {
    cwd: NODE_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const echo = (chunk: Buffer) => {
    out.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      if (line.trim()) console.log(`  [node] ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
    }
  };
  child.stdout!.on('data', echo);
  child.stderr!.on('data', echo);
  return child;
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForNode(child: ChildProcess, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`node exited with code ${child.exitCode}`);
    try {
      const { status, body } = await getJson(`${NODE_URL}/status`);
      if (status === 200) return body;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`node did not answer ${NODE_URL}/status within ${timeoutMs} ms`);
}

/** Poll /status until `predicate` holds */
async function waitForStatus(predicate: (status: any) => boolean, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = (await getJson(`${NODE_URL}/status`)).body;
    if (predicate(last)) return last;
    await sleep(1_000);
  }
  return last;
}

// ── Test ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-node-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const logFile = path.join(tmp, 'node.log');
  let node: ChildProcess | null = null;

  try {
    // 1. Cluster, program, admin, config
    const version = await rpc.getVersion().send();
    const program = await rpc.getAccountInfo(PROGRAM_ADDRESS, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }).send();
    if (!program.value?.executable) throw new Error(`SolaDB program ${PROGRAM_ADDRESS} is not deployed on ${RPC}`);
    log(`validator ${RPC} (solana-core ${version['solana-core']}), program ${PROGRAM_ADDRESS}`);

    const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN, 'utf8'))));
    if ((await balance(admin.address)) < 10n * SOL) await airdrop(admin.address, 20n * SOL);
    const configAddress = await pdas.config();
    if (!(await fetchAccount(rpc, configAddress, 'Config'))) {
      log('initializing the SolaDB config');
      await sender.send({
        feePayer: admin,
        instructions: [
          await ix.initialize(admin, {
            treasury: admin.address,
            baseFeePerReplica: 20_000n,
            pricePerByte: 2n,
            protocolFeeBps: 1_000,
            replicationThresholdPct: 60,
            replicationWindow: 3_600n,
          }),
        ],
      });
    }

    // 2. Fresh replicator: keypair file, SOL for fees, registered by the admin
    const nodeKeyFile = path.join(tmp, 'replicator.json');
    fs.writeFileSync(nodeKeyFile, JSON.stringify([...newKeypairBytes()]));
    const nodeSigner = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(nodeKeyFile, 'utf8'))));
    await airdrop(nodeSigner.address, 1n * SOL);
    await sender.send({
      feePayer: admin,
      instructions: [await ix.registerReplicator(admin, nodeSigner.address, NODE_URL)],
    });
    log(`replicator ${nodeSigner.address} registered with endpoint ${NODE_URL}`);

    // 3. Uploader with a published encryption key
    const uploader: KeyPairSigner = await createKeyPairSignerFromBytes(newKeypairBytes());
    await airdrop(uploader.address, 10n * SOL);
    const client = new SolaDBClient({ rpc: RPC, signer: uploader, ledgerFallback: false, nodeUrls: [NODE_URL] });
    await client.register();
    log(`uploader ${uploader.address} registered`);

    // 4. Start the node (fs + file stores)
    const nodeEnv = {
      PORT: String(PORT),
      SOLANA_CLUSTER: 'localnet',
      SOLANA_RPC_URL: RPC,
      SOLANA_COMMITMENT: COMMITMENT,
      REPLICATOR_KEYPAIR: nodeKeyFile,
      NODE_ENDPOINT: NODE_URL,
      CHUNK_STORE: 'fs',
      METADATA_STORE: 'file',
      DATA_DIR: dataDir,
      POLL_INTERVAL_MS: '1000',
      REPLICATE_OWNERS: uploader.address,
      LOG_LEVEL: 'log',
    };
    node = startNode(nodeEnv, logFile);
    await waitForNode(node);
    const status0 = await waitForStatus((s) => s.registered === true, 30_000);
    check('node boots and serves /status', status0.registered === true && status0.active === true,
      `registered=${status0.registered} active=${status0.active} endpoint=${status0.endpoint}`);
    const swagger = await fetch(`${NODE_URL}/docs`);
    check('Swagger UI at /docs', swagger.status === 200);

    const balanceBefore = await balance(nodeSigner.address);

    // 5. Upload ~300 KB with 1 replica
    const file = Uint8Array.from({ length: FILE_SIZE }, (_, i) => (i * 131 + (i >> 9) * 7) % 256);
    const upload = await client.uploadFile(file, { name: 'e2e-node.bin', mime: 'application/octet-stream', replicas: 1 });
    log(`uploaded ${FILE_SIZE} bytes: record ${upload.recordId}, ${upload.chunks.length} chunks, ` +
      `${upload.segmentTransactions} segment txs, fee ${upload.feePaid} lamports`);

    // 6. The node rebuilds + confirms every chunk
    const coolStart = Date.now();
    await client.waitUntilCool(upload.chunks, { timeoutMs: 120_000, pollMs: 1_000 });
    check('every chunk turns Cool through the node', true, `${((Date.now() - coolStart) / 1000).toFixed(1)}s after upload`);
    // The chain can show Cool before the node's own sender saw its confirmation
    await waitForStatus((s) => s.scan.totals.confirmed >= upload.chunks.length, 30_000);

    const accounts = await fetchAccounts<ChunkAccount>(rpc, upload.chunks, 'Chunk', 'confirmed');
    const byNode = accounts.every((a) => a && a.data.replicators.length === 1 && a.data.replicators[0] === nodeSigner.address);
    check('chunks list the node as their replicator', byNode,
      accounts.map((a) => `${a?.data.state} ${a?.data.confirmedReplicas}/${a?.data.requiredReplicas}`).join(', '));

    const rewards = accounts.reduce((sum, a) => sum + (a?.data.rewardPerReplica ?? 0n), 0n);
    const expected = rewards - BigInt(upload.chunks.length) * SIGNATURE_FEE;
    // Confirmations of the last chunk may still be settling into "confirmed" balances
    let balanceAfter = await balance(nodeSigner.address);
    for (let i = 0; i < 10 && balanceAfter - balanceBefore < expected; i++) {
      await sleep(500);
      balanceAfter = await balance(nodeSigner.address);
    }
    check('node balance grew by the rewards minus tx fees', balanceAfter - balanceBefore === expected,
      `+${balanceAfter - balanceBefore} lamports (rewards ${rewards} - ${upload.chunks.length} × ${SIGNATURE_FEE} fee)`);

    const replicatorAccount = await fetchAccount<ReplicatorAccount>(rpc, await pdas.replicator(nodeSigner.address), 'Replicator', 'confirmed');
    check('Replicator account counts the confirmations',
      replicatorAccount?.data.confirmations === BigInt(upload.chunks.length) && replicatorAccount?.data.lamportsEarned === rewards,
      `confirmations=${replicatorAccount?.data.confirmations} lamportsEarned=${replicatorAccount?.data.lamportsEarned}`);

    // 7. Download through the node only (ledgerFallback: false)
    const download = await client.downloadFile(upload.recordId);
    check('file downloads through the node only', Buffer.from(download.data).equals(Buffer.from(file)),
      `${download.data.length} bytes, sha256 ${sha256(download.data).slice(0, 16)}…`);

    // 8. HTTP API
    let rawOk = true;
    for (const account of accounts) {
      const response = await fetch(`${NODE_URL}/chunk/${account!.address}/data`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      rawOk &&= response.status === 200 &&
        response.headers.get('content-type') === 'application/octet-stream' &&
        response.headers.get('x-chunk-id') === account!.address &&
        sha256(bytes) === hex(account!.data.contentHash);
    }
    check('GET /chunk/:id/data serves sha256-valid bytes with headers', rawOk);

    const meta = await getJson(`${NODE_URL}/chunk/${upload.chunks[0]}/meta`);
    check('GET /chunk/:id/meta returns local metadata', meta.status === 200 && meta.body.source === 'local' &&
      meta.body.state === 'Cool' && meta.body.confirmedReplicas === 1 && typeof meta.body.confirmSignature === 'string',
      `state=${meta.body.state} confirmed=${meta.body.confirmedReplicas} slot=${meta.body.slot} sig=${String(meta.body.confirmSignature).slice(0, 12)}…`);

    const query = await getJson(`${NODE_URL}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { owner: uploader.address, state: 'Cool' }, orderBy: 'size', order: 'desc' }),
    });
    check('POST /query filters by owner + state', query.status === 200 && query.body.count === upload.chunks.length &&
      query.body.data[0].size >= query.body.data[query.body.count - 1].size, `count=${query.body.count}`);

    const badQuery = await getJson(`${NODE_URL}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { state: 'Warm' } }),
    });
    const badId = await fetch(`${NODE_URL}/chunk/not-an-address/data`);
    const unknown = await fetch(`${NODE_URL}/chunk/${uploader.address}/data`);
    check('invalid input → 400, unknown chunk → 404',
      badQuery.status === 400 && badId.status === 400 && unknown.status === 404,
      `query=${badQuery.status} id=${badId.status} unknown=${unknown.status}`);

    // 9. A second confirmation is rejected by the program (what the node treats as "nothing to do")
    try {
      await sender.send({ feePayer: nodeSigner, instructions: [await ix.confirmReplication(nodeSigner, upload.chunks[0])] });
      check('second confirm_replication is rejected', false, 'it succeeded');
    } catch (err) {
      const code = (err as { code?: number }).code;
      check('second confirm_replication is rejected', code === SOLADB_ERRORS.FullyReplicated || code === SOLADB_ERRORS.AlreadyReplicated,
        `code ${code} (${(err as { programError?: string }).programError})`);
    }

    const status1 = (await getJson(`${NODE_URL}/status`)).body;
    check('/status reports the scan stats', status1.scan.totals.confirmed >= upload.chunks.length &&
      status1.scan.totals.stored >= upload.chunks.length && status1.storage.chunks >= upload.chunks.length,
      `scans=${status1.scan.scans} stored=${status1.scan.totals.stored} confirmed=${status1.scan.totals.confirmed} ` +
      `errors=${status1.scan.totals.errors} earned=${status1.lamportsEarned} balance=${status1.balanceLamports}`);

    // 10. Restart on the same data directory: chunks still served, nothing re-downloaded
    await stopNode(node);
    log('node stopped; restarting on the same data directory');
    node = startNode(nodeEnv, logFile);
    await waitForNode(node);
    const status2 = await waitForStatus((s) => s.scan.scans >= 2, 15_000);
    const again = await fetch(`${NODE_URL}/chunk/${upload.chunks[1]}/data`);
    const againBytes = new Uint8Array(await again.arrayBuffer());
    check('after a restart the node still serves its chunks', again.status === 200 &&
      sha256(againBytes) === hex(accounts[1]!.data.contentHash) && status2.storage.chunks >= upload.chunks.length &&
      status2.scan.totals.stored === 0 && status2.scan.totals.confirmed === 0,
      `stored chunks=${status2.storage.chunks}, re-downloaded=${status2.scan.totals.stored}, re-confirmed=${status2.scan.totals.confirmed}`);

    const download2 = await new SolaDBClient({ rpc: RPC, signer: uploader, ledgerFallback: false, nodeUrls: [NODE_URL] })
      .downloadFile(upload.recordId);
    check('file downloads through the restarted node', Buffer.from(download2.data).equals(Buffer.from(file)));
  } catch (err) {
    check('e2e run', false, (err as Error).stack ?? String(err));
  } finally {
    if (node) await stopNode(node);
    if (process.env.E2E_KEEP_DATA === '1') log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} checks passed in ${elapsed()}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
