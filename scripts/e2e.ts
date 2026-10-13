import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createKeyPairSignerFromPrivateKeyBytes, KeyPairSigner } from '@solana/kit';
import {
  soladbInstructions,
  SolaDBClient,
  ChunkAccount,
  ConfigAccount,
  fetchAccount,
  pdas,
  quoteChunk,
  sha256,
  transferSol,
} from '../sdk/src';
import {
  airdrop,
  clusterArg,
  connect,
  explorerLink,
  loadDeployer,
  loadEnv,
  loadKeypair,
  readDeployment,
  ROOT,
  sleep,
  sol,
  SOL,
} from './lib/common';

/**
 * End-to-end check against a running soladb-node:
 *
 *   1. Ledger chunk: open (paying the fee) → write its segments to the
 *      ledger → the node rebuilds it, confirms on-chain and gets paid → the
 *      confirmation closes the chunk (rent back) → GET /chunk/:id/data
 *      returns the same bytes
 *   2. SDK file, direct mode: encrypted multi-chunk upload sent straight to
 *      the node (one wallet transaction, no ledger writes) → the node checks
 *      and confirms → chunk rent back → download through the node only
 *   3. Sharing: a second wallet registers, gets access and decrypts the file
 *
 * Usage (node running against the same deployment):
 *   npm run e2e:devnet          (or e2e:localnet)
 *
 * Env: UPLOADER_KEYPAIR (default: the deployer), NODE_URL (default http://localhost:3000),
 *      E2E_CHUNK_BYTES (default 20000), E2E_TIMEOUT_MS (default 180000).
 * Results are written to deployments/e2e-solana-<cluster>.json.
 */
const NODE_URL = (process.env.NODE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const CHUNK_BYTES = Number(process.env.E2E_CHUNK_BYTES ?? '20000');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? '180000');

const main = async () => {
  loadEnv();
  const cluster = clusterArg();
  const deployment = readDeployment(cluster);
  const { rpc, sender } = connect(cluster);
  const uploader = process.env.UPLOADER_KEYPAIR ? await loadKeypair(process.env.UPLOADER_KEYPAIR) : await loadDeployer(cluster);
  // deterministic second wallet so reruns reuse its identity
  const viewer: KeyPairSigner = await createKeyPairSignerFromPrivateKeyBytes(
    sha256(new TextEncoder().encode(`soladb-e2e-viewer:${uploader.address}`)),
  );
  const sdkDeployment = { ...deployment, nodes: [NODE_URL] };
  const owner = new SolaDBClient({
    rpc,
    signer: uploader,
    deployment: sdkDeployment,
    mode: 'direct',
    directChunkSize: 16 * 1024,
    ledgerFallback: false,
  });
  const reader = new SolaDBClient({ rpc, signer: viewer, deployment: sdkDeployment, ledgerFallback: false });
  const ix = soladbInstructions();

  const started = Date.now();
  const deadline = started + TIMEOUT_MS;
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const results: Record<string, unknown> = { cluster, startedAt: new Date().toISOString() };

  const status = await fetch(`${NODE_URL}/status`).then((r) => r.json());
  console.log(`Node ${NODE_URL}: replicator ${status.replicatorAddress ?? status.replicator}, registered=${status.registered}`);
  if (status.programId && status.programId !== deployment.programId) {
    throw new Error(`Node watches program ${status.programId}, deployment is ${deployment.programId}`);
  }
  if (cluster === 'localnet') await airdrop(rpc, uploader.address, 20n * SOL);
  console.log(`Uploader ${uploader.address}: ${sol((await rpc.getBalance(uploader.address).send()).value)}`);

  // ── 1. Identity ────────────────────────────────────────────────────────────
  const registered = await owner.register();
  if (registered) console.log(`[${elapsed()}] Registered encryption key (${registered})`);

  // ── 2. Ledger chunk: open → segments → node confirms (closes it) → GET bytes
  const data = new Uint8Array(randomBytes(CHUNK_BYTES));
  const contentHash = sha256(data);
  const chunk = await pdas.chunk(uploader.address, contentHash);
  const config = (await fetchAccount<ConfigAccount>(rpc, await pdas.config(), 'Config'))!.data;
  const fee = quoteChunk(config, data.length, 1);
  const segmentSize = await owner.segmentSize(0);
  const openSignature = await sender.send({
    feePayer: uploader,
    instructions: [
      await ix.openChunk(uploader, config.treasury, { contentHash, size: data.length, segmentSize, replicas: 1, writer: uploader.address, maxFee: fee }),
    ],
    label: 'open_chunk',
  });
  const writes = [];
  for (let i = 0; i * segmentSize < data.length; i++) {
    writes.push({
      feePayer: uploader,
      instructions: [ix.writeSegment(uploader, chunk, i, data.subarray(i * segmentSize, (i + 1) * segmentSize))],
      label: `segment ${i}`,
    });
  }
  await sender.sendAll(writes);
  const uploadedAt = Date.now();
  console.log(`[${elapsed()}] Uploaded ${CHUNK_BYTES} bytes in ${writes.length} segments → chunk ${chunk}`);
  console.log(`         fee ${sol(fee)}, open ${openSignature}`);

  // 1 replica: the node's confirmation pays it and closes the chunk
  let account = (await fetchAccount<ChunkAccount>(rpc, chunk, 'Chunk'))?.data ?? null;
  while (account && account.state !== 'Cool') {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the node to confirm (state ${account.state})`);
    await sleep(1000);
    account = (await fetchAccount<ChunkAccount>(rpc, chunk, 'Chunk'))?.data ?? null;
  }
  const secondsToCool = (Date.now() - uploadedAt) / 1000;
  console.log(
    `[${elapsed()}] Chunk is Cool${account ? `, confirmed by ${account.replicators.join(', ')}` : ' and closed by its last confirmation (rent back)'}` +
      ` (${secondsToCool.toFixed(1)} s after upload)`,
  );

  const response = await fetch(`${NODE_URL}/chunk/${chunk}/data`);
  if (!response.ok) throw new Error(`GET /chunk/${chunk}/data → HTTP ${response.status}`);
  const served = new Uint8Array(await response.arrayBuffer());
  const identical = Buffer.compare(Buffer.from(served), Buffer.from(data)) === 0;
  console.log(`[${elapsed()}] GET /chunk/:id/data → ${served.length} bytes, identical=${identical}`);
  if (!identical) throw new Error('E2E FAILED at the raw chunk step');
  results.rawChunk = { chunk, bytes: CHUNK_BYTES, segments: writes.length, feeLamports: fee.toString(), openSignature, secondsToCool };

  // ── 3. SDK file, direct: chunks go straight to the node → Cool → rent back ─
  const file = new Uint8Array(randomBytes(40_000));
  const balanceBefore = (await rpc.getBalance(uploader.address).send()).value;
  const upload = await owner.uploadFile(file, {
    name: 'e2e-report.bin',
    onProgress: (p) => console.log(`         [${p.done}/${p.total}] ${p.stage}`),
  });
  console.log(
    `[${elapsed()}] SDK upload (${upload.mode}): record ${upload.recordId}, ${upload.chunks.length} chunks, ` +
      `${upload.signatures.length} wallet tx, ${upload.segmentTransactions} segment txs, accepted by ${upload.nodes.join(', ')}`,
  );
  await owner.waitUntilCool(upload.chunks, { timeoutMs: Math.max(deadline - Date.now(), 1000) });
  const closed = (await owner.chunkStatus(upload.chunks)).filter((c) => c.state === 'Closed').length;
  const recordSpace = (await rpc.getAccountInfo(upload.recordId, { encoding: 'base64' }).send()).value!.space;
  const recordRent = await rpc.getMinimumBalanceForRentExemption(recordSpace).send();
  const spent = balanceBefore - (await rpc.getBalance(uploader.address).send()).value;
  const networkFees = spent - upload.feePaid - recordRent;
  // the uploader may also be the treasury (localnet): it gets the protocol share back
  const isTreasury = config.treasury === uploader.address;
  const rentCameBack = spent <= upload.feePaid + recordRent + 5_000n * BigInt(upload.signatures.length);
  console.log(
    `[${elapsed()}] All file chunks are Cool; ${closed}/${upload.chunks.length} closed by their last confirmation — ` +
      `spent ${sol(spent)} = fee ${sol(upload.feePaid)} + record rent ${sol(recordRent)} + network ${sol(networkFees)}` +
      `${isTreasury ? ' (minus the protocol share, back to this wallet as treasury)' : ''}; chunk rent ${sol(upload.rentDeposit - recordRent)} came back: ${rentCameBack}`,
  );
  const fileOk = async (client: SolaDBClient) => {
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        return Buffer.compare(Buffer.from((await client.downloadFile(upload.recordId)).data), Buffer.from(file)) === 0;
      } catch (err) {
        if ((err as Error).message !== lastError) console.log(`         download not ready: ${(err as Error).message}`);
        lastError = (err as Error).message;
        await sleep(1000);
      }
    }
    return false;
  };
  const ownerOk = await fileOk(owner);
  console.log(`[${elapsed()}] Owner download through the node only, decrypted and verified: ${ownerOk}`);

  // ── 4. Sharing with a second wallet ────────────────────────────────────────
  if ((await rpc.getBalance(viewer.address).send()).value < SOL / 50n) {
    await sender.send({ feePayer: uploader, instructions: [transferSol(uploader, viewer.address, SOL / 20n)], label: 'fund viewer' });
    console.log(`[${elapsed()}] Funded viewer ${viewer.address} with 0.05 SOL`);
  }
  await reader.register();
  const shareSignature = await owner.share(upload.recordId, viewer.address);
  const viewerOk = await fileOk(reader);
  console.log(`[${elapsed()}] Shared with ${viewer.address} (${shareSignature}); viewer decrypted it: ${viewerOk}`);

  results.sdkFile = {
    recordId: upload.recordId,
    mode: upload.mode,
    bytes: file.length,
    chunks: upload.chunks.length,
    chunksClosed: closed,
    segmentTransactions: upload.segmentTransactions,
    feeLamports: upload.feePaid.toString(),
    rentDepositLamports: upload.rentDeposit.toString(),
    rentKeptLamports: recordRent.toString(),
    networkFeeLamports: networkFees.toString(),
    spentLamports: spent.toString(),
    walletSignatures: upload.signatures,
    ownerDownloadOk: ownerOk,
    viewer: viewer.address,
    shareSignature,
    viewerDownloadOk: viewerOk,
  };
  results.finishedAt = new Date().toISOString();
  results.passed = ownerOk && viewerOk && closed === upload.chunks.length && rentCameBack;

  const out = path.join(ROOT, 'deployments', `e2e-solana-${cluster}.json`);
  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  console.log(`\nChunk:   ${explorerLink(cluster, 'address', chunk)}`);
  console.log(`Record:  ${explorerLink(cluster, 'address', upload.recordId)}`);
  console.log(`Share:   ${explorerLink(cluster, 'tx', shareSignature)}`);
  console.log(`Results: ${path.relative(process.cwd(), out)}`);
  if (!results.passed) throw new Error('E2E FAILED at the SDK / sharing step');
  console.log('\nE2E PASSED: ledger chunk → node confirmation (paid, chunk closed) → GET /chunk/:id/data returned the same bytes;');
  console.log('            direct file → node checked + confirmed, chunk rent back → downloaded through the node by its owner');
  console.log('            and by the wallet it was shared with');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
