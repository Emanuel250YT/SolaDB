/**
 * End-to-end check of the replicator node against a local validator with the
 * SolaDB program deployed (scripts/localnet.sh; admin = .localnet/admin.json):
 *
 *   npm run build -w @soladb/sdk && (cd soladb-node && npm run build)
 *   npx tsx soladb-node/test/e2e-localnet.ts          # from the repo root
 *
 * It registers a fresh replicator, starts the built node (dist/main.js) with
 * the fs + file stores, uploads a ~300 KB file to the ledger with 1 replica,
 * waits for the node to confirm every chunk (rewards paid, chunk accounts
 * closed by the last confirmation), downloads the file through the node
 * only, checks the HTTP API, then restarts the node on the same data
 * directory and checks it still serves the chunks.  Then a direct upload
 * (compressed, chunks pushed to the node over HTTP, nothing in the ledger):
 * the node confirms every chunk in batched transactions, the chunk rent goes
 * back to the uploader, and the file downloads through the node.  Last, the
 * PUT /chunk/:id/data contract on chunks opened by hand.
 *
 * The node only replicates the test uploader's chunks (REPLICATE_OWNERS), so
 * it never interferes with other tests sharing the validator.
 *
 * Env: SOLADB_TEST_RPC (default http://127.0.0.1:8899), SOLADB_TEST_ADMIN,
 *      E2E_NODE_PORT (3100), E2E_COMMITMENT (confirmed | finalized),
 *      E2E_KEEP_DATA=1 to keep the temp directory.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
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
  ConfigAccount,
  fetchAccount,
  fetchAccounts,
  MAX_DIRECT_CHUNK_SIZE,
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
// Direct upload: ~890 KB of CSV, ~325 KB gzipped, in 128 KiB chunks (3 pushes)
const CSV_ROWS = 25_000;
const DIRECT_CHUNK_SIZE = 128 * 1024;
// Node read commitment: "confirmed" keeps the run short; "finalized" is the production default
const COMMITMENT = process.env.E2E_COMMITMENT ?? 'confirmed';
const SOL = 1_000_000_000n;
const SIGNATURE_FEE = 5_000n;
/** Anchor's AccountNotInitialized: the chunk account was closed */
const ACCOUNT_NOT_INITIALIZED = 3012;

const rpc = createSolanaRpc(RPC);
const sender = new TransactionSender(rpc);
const ix = soladbInstructions();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

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

/** Expense-sheet CSV with random amounts: compresses ~2.7×, not more */
function csvFile(rows: number): Uint8Array {
  const concepts = ['hosting', 'cafe', 'libros', 'taxi', 'luz', 'agua', 'renta', 'sueldo'];
  const lines = ['fecha,monto,concepto,cuenta'];
  for (let i = 0; i < rows; i++) {
    const date = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + randomInt(28)).padStart(2, '0')}`;
    lines.push(`${date},${(randomInt(10_000_000) / 100).toFixed(2)},${concepts[randomInt(8)]},${randomInt(1e9)}`);
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
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

/** PUT /chunk/:id/data, as the SDK pushes a direct chunk */
function putChunk(chunk: string, data: Uint8Array): Promise<{ status: number; body: any }> {
  return getJson(`${NODE_URL}/chunk/${chunk}/data`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: data as BodyInit,
  });
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

/** The node's metadata for each chunk (GET /chunk/:id/meta) */
async function nodeMetas(chunks: Address[]): Promise<any[]> {
  return Promise.all(chunks.map(async (c) => (await getJson(`${NODE_URL}/chunk/${c}/meta`)).body));
}

/** Balance once it stops moving (confirmations still settling into "confirmed") */
async function settledBalance(address: Address, expected: bigint, from: bigint): Promise<bigint> {
  let value = await balance(address);
  for (let i = 0; i < 10 && value - from !== expected; i++) {
    await sleep(500);
    value = await balance(address);
  }
  return value;
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

    // 3. Uploader with a published encryption key; ledger uploads of uncompressed bytes first
    const uploader: KeyPairSigner = await createKeyPairSignerFromBytes(newKeypairBytes());
    await airdrop(uploader.address, 10n * SOL);
    const client = new SolaDBClient({
      rpc: RPC,
      signer: uploader,
      mode: 'ledger',
      compress: false,
      ledgerFallback: false,
      nodeUrls: [NODE_URL],
    });
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

    // 6. The node rebuilds + confirms every chunk; with 1 replica its confirmation closes the chunk account
    const coolStart = Date.now();
    await client.waitUntilCool(upload.chunks, { timeoutMs: 120_000, pollMs: 1_000 });
    check('every chunk is replicated through the node', true, `${((Date.now() - coolStart) / 1000).toFixed(1)}s after upload`);
    // The chain can show the chunk closed before the node's own sender saw its confirmation
    const status1a = await waitForStatus((s) => s.scan.totals.confirmed >= upload.chunks.length, 30_000);

    const accounts = await fetchAccounts<ChunkAccount>(rpc, upload.chunks, 'Chunk', 'confirmed');
    const metas = await nodeMetas(upload.chunks);
    const byNode = accounts.every((a) => a === null) && metas.every((m) => m.source === 'local' && m.state === 'Closed' &&
      m.confirmedReplicas === 1 && m.replicators.length === 1 && m.replicators[0] === nodeSigner.address);
    check('the confirmation closes every chunk account; the node records itself as the replicator', byNode,
      metas.map((m, i) => `${accounts[i] ? 'open' : 'closed'} ${m.state} ${m.confirmedReplicas}/${m.requiredReplicas}`).join(', '));

    const rewards = metas.reduce((sum, m) => sum + BigInt(m.rewardPerReplica ?? 0), 0n);
    const confirmTxs = BigInt(status1a.scan.totals.transactions);
    const expected = rewards - confirmTxs * SIGNATURE_FEE;
    const balanceAfter = await settledBalance(nodeSigner.address, expected, balanceBefore);
    check('node balance grew by the rewards minus tx fees', balanceAfter - balanceBefore === expected,
      `+${balanceAfter - balanceBefore} lamports (rewards ${rewards} - ${confirmTxs} confirm tx × ${SIGNATURE_FEE} fee, ` +
      `${upload.chunks.length} chunks)`);

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
    for (const meta of metas) {
      const response = await fetch(`${NODE_URL}/chunk/${meta.chunkId}/data`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      rawOk &&= response.status === 200 &&
        response.headers.get('content-type') === 'application/octet-stream' &&
        response.headers.get('x-chunk-id') === meta.chunkId &&
        sha256(bytes) === meta.contentHash;
    }
    check('GET /chunk/:id/data serves sha256-valid bytes with headers', rawOk);

    const meta = metas[0];
    check('GET /chunk/:id/meta returns local metadata', meta.source === 'local' &&
      meta.state === 'Closed' && meta.confirmedReplicas === 1 && typeof meta.confirmSignature === 'string',
      `state=${meta.state} confirmed=${meta.confirmedReplicas} slot=${meta.slot} sig=${String(meta.confirmSignature).slice(0, 12)}…`);

    const query = await getJson(`${NODE_URL}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { owner: uploader.address, state: 'Closed' }, orderBy: 'size', order: 'desc' }),
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

    // 9. Another confirmation is rejected by the program: the account is gone
    //    (what the node treats as "nothing to do")
    try {
      await sender.send({ feePayer: nodeSigner, instructions: [await ix.confirmReplication(nodeSigner, upload.chunks[0], uploader.address)] });
      check('a confirmation after the last one is rejected', false, 'it succeeded');
    } catch (err) {
      const code = (err as { code?: number }).code;
      check('a confirmation after the last one is rejected',
        code === ACCOUNT_NOT_INITIALIZED || code === SOLADB_ERRORS.FullyReplicated || code === SOLADB_ERRORS.AlreadyReplicated,
        `code ${code} (${(err as { programError?: string }).programError ?? 'AccountNotInitialized: chunk closed'})`);
    }

    const status1 = (await getJson(`${NODE_URL}/status`)).body;
    check('/status reports the scan stats', status1.scan.totals.confirmed >= upload.chunks.length &&
      status1.scan.totals.stored >= upload.chunks.length && status1.storage.chunks >= upload.chunks.length,
      `scans=${status1.scan.scans} stored=${status1.scan.totals.stored} confirmed=${status1.scan.totals.confirmed} ` +
      `txs=${status1.scan.totals.transactions} errors=${status1.scan.totals.errors} earned=${status1.lamportsEarned} ` +
      `balance=${status1.balanceLamports}`);

    // 10. Restart on the same data directory: chunks still served, nothing re-downloaded
    await stopNode(node);
    log('node stopped; restarting on the same data directory');
    node = startNode(nodeEnv, logFile);
    await waitForNode(node);
    const status2 = await waitForStatus((s) => s.scan.scans >= 2, 15_000);
    const again = await fetch(`${NODE_URL}/chunk/${upload.chunks[1]}/data`);
    const againBytes = new Uint8Array(await again.arrayBuffer());
    check('after a restart the node still serves its chunks', again.status === 200 &&
      sha256(againBytes) === metas[1].contentHash && status2.storage.chunks >= upload.chunks.length &&
      status2.scan.totals.stored === 0 && status2.scan.totals.confirmed === 0,
      `stored chunks=${status2.storage.chunks}, re-downloaded=${status2.scan.totals.stored}, re-confirmed=${status2.scan.totals.confirmed}`);

    const download2 = await new SolaDBClient({ rpc: RPC, signer: uploader, ledgerFallback: false, nodeUrls: [NODE_URL] })
      .downloadFile(upload.recordId);
    check('file downloads through the restarted node', Buffer.from(download2.data).equals(Buffer.from(file)));

    // 11. Direct upload: compressed, chunks pushed to the node over HTTP, nothing in the ledger
    const directClient = new SolaDBClient({
      rpc: RPC,
      signer: uploader,
      mode: 'direct',
      compress: true,
      directChunkSize: DIRECT_CHUNK_SIZE,
      ledgerFallback: false,
      nodeUrls: [NODE_URL],
    });
    const csv = csvFile(CSV_ROWS);
    const statusBefore = (await getJson(`${NODE_URL}/status`)).body;
    const nodeBefore = await balance(nodeSigner.address);
    const uploaderBefore = await balance(uploader.address);
    const direct = await directClient.uploadFile(csv, { name: 'e2e-gastos.csv', mime: 'text/csv', replicas: 1 });
    log(`direct upload: ${csv.length} bytes → ${direct.storedSize} gzipped, ${direct.chunks.length} chunks ` +
      `pushed to ${direct.nodes.join(', ')}, ${direct.signatures.length} wallet tx, fee ${direct.feePaid} lamports`);
    check('direct upload is compressed and pushed to the node, with no ledger writes',
      direct.mode === 'direct' && direct.segmentTransactions === 0 && direct.storedSize < csv.length &&
      direct.chunks.length > 1 && direct.nodes.length === 1 && direct.nodes[0] === NODE_URL,
      `mode=${direct.mode} segments=${direct.segmentTransactions} chunks=${direct.chunks.length} nodes=${direct.nodes.join(',')}`);

    const directStart = Date.now();
    await directClient.waitUntilCool(direct.chunks, { timeoutMs: 60_000, pollMs: 1_000 });
    const directAccounts = await fetchAccounts<ChunkAccount>(rpc, direct.chunks, 'Chunk', 'confirmed');
    check('every direct chunk is confirmed and its account closed', directAccounts.every((a) => a === null),
      `${((Date.now() - directStart) / 1000).toFixed(1)}s after the upload returned`);

    // The uploader paid the upload fee, the record's rent and the network fee; the chunk rent came back
    const record = await rpc.getAccountInfo(direct.recordId, { encoding: 'base64', commitment: 'confirmed' }).send();
    const recordRent = await rpc.getMinimumBalanceForRentExemption(record.value!.space).send();
    const networkFee = BigInt(direct.signatures.length) * SIGNATURE_FEE;
    const uploaderSpent = uploaderBefore - (await balance(uploader.address));
    check('chunk rent is refunded: uploader paid fee + record rent + network fee only',
      uploaderSpent === direct.feePaid + recordRent + networkFee,
      `spent ${uploaderSpent} = fee ${direct.feePaid} + record rent ${recordRent} + ${direct.signatures.length} × ${SIGNATURE_FEE}`);

    const statusAfter = await waitForStatus(
      (s) => s.scan.totals.confirmed >= statusBefore.scan.totals.confirmed + direct.chunks.length, 30_000);
    const directTxs = statusAfter.scan.totals.transactions - statusBefore.scan.totals.transactions;
    const directMetas = await nodeMetas(direct.chunks);
    const directRewards = directMetas.reduce((sum, m) => sum + BigInt(m.rewardPerReplica ?? 0), 0n);
    const directExpected = directRewards - BigInt(directTxs) * SIGNATURE_FEE;
    const nodeEarned = (await settledBalance(nodeSigner.address, directExpected, nodeBefore)) - nodeBefore;
    check('node stored the pushes and earned their rewards, one fee per confirmation transaction',
      nodeEarned === directExpected && statusAfter.scan.pushes.accepted >= direct.chunks.length &&
      directMetas.every((m) => m.source === 'local' && m.state === 'Closed' && m.slot === null),
      `+${nodeEarned} lamports = rewards ${directRewards} - ${directTxs} tx(s) × ${SIGNATURE_FEE} for ` +
      `${direct.chunks.length} chunks; pushes ${JSON.stringify(statusAfter.scan.pushes)}`);

    const directDownload = await new SolaDBClient({ rpc: RPC, signer: uploader, ledgerFallback: false, nodeUrls: [NODE_URL] })
      .downloadFile(direct.recordId);
    check('direct file downloads through the node only', Buffer.from(directDownload.data).equals(Buffer.from(csv)),
      `${directDownload.data.length} bytes, sha256 ${sha256(directDownload.data).slice(0, 16)}…`);

    // 12. PUT /chunk/:id/data contract, on chunks opened by hand
    const config = (await fetchAccount<ConfigAccount>(rpc, configAddress, 'Config', 'confirmed'))!.data;
    const openChunk = async (data: Uint8Array, segmentSize: number): Promise<Address> => {
      const contentHash = createHash('sha256').update(data).digest();
      await sender.send({
        feePayer: uploader,
        instructions: [await ix.openChunk(uploader, config.treasury, {
          contentHash,
          size: data.length,
          segmentSize,
          replicas: 1,
          writer: uploader.address,
          maxFee: SOL,
        })],
      });
      return pdas.chunk(uploader.address, contentHash);
    };
    const pushed = new Uint8Array(randomBytes(2_048));
    const directChunk = await openChunk(pushed, 0);
    const ledgerChunk = await openChunk(new Uint8Array(randomBytes(2_048)), 1_000);
    const flipped = Uint8Array.from(pushed);
    flipped[0] ^= 1;

    const badHash = await putChunk(directChunk, flipped);
    const badSize = await putChunk(directChunk, pushed.subarray(1));
    const notDirect = await putChunk(ledgerChunk, pushed);
    const notChunk = await putChunk(uploader.address, pushed);
    const badPushId = await putChunk('not-an-address', pushed);
    const tooLarge = await putChunk(directChunk, new Uint8Array(MAX_DIRECT_CHUNK_SIZE + 1));
    check('push rejects: hash 400, size 400, ledger chunk 409, not a chunk 404, bad id 400, > 16 MiB 413',
      badHash.status === 400 && badSize.status === 400 && notDirect.status === 409 && notChunk.status === 404 &&
      badPushId.status === 400 && tooLarge.status === 413,
      `hash=${badHash.status} size=${badSize.status} ledger=${notDirect.status} notChunk=${notChunk.status} ` +
      `id=${badPushId.status} large=${tooLarge.status}`);

    const accepted = await putChunk(directChunk, pushed);
    const repeated = await putChunk(directChunk, pushed);
    const closed = (await fetchAccount<ChunkAccount>(rpc, directChunk, 'Chunk', 'confirmed')) === null;
    check('push accepted → 201 stored + confirmed (account closed), repeated → 200',
      accepted.status === 201 && accepted.body.stored === true && accepted.body.confirmed === true &&
      typeof accepted.body.signature === 'string' && closed &&
      repeated.status === 200 && repeated.body.confirmed === true,
      `201 ${JSON.stringify(accepted.body)}; then ${repeated.status} ${JSON.stringify(repeated.body)}; closed=${closed}`);

    const preflight = await fetch(`${NODE_URL}/chunk/${directChunk}/data`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    const allowed = preflight.headers.get('access-control-allow-methods') ?? '';
    check('CORS preflight allows browser pushes (PUT)', preflight.status < 300 && /PUT/.test(allowed), `${preflight.status} ${allowed}`);

    // the hand-opened ledger chunk was never written: close it (rent back)
    await sender.send({ feePayer: uploader, instructions: [ix.closeChunk(uploader, ledgerChunk)] });
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
