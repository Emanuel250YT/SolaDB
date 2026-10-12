import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateKeyPairSigner, Signature } from '@solana/kit';
import { soladbInstructions, SolaDBClient, ChunkAccount, fetchAccount, readChunkFromLedger } from '../sdk/src';
import { airdrop, connect, loadDeployer, loadEnv, ROOT, sol, SOL } from './lib/common';

/**
 * Measures compute units per instruction and the cost of uploading files of
 * several sizes with v1 (4 KiB) and v0 (1232-byte) segment transactions.
 * Runs on localnet (scripts/localnet.sh + npm run init:localnet).
 *
 * Usage: npm run measure-costs
 * Output: a Markdown table + deployments/costs-localnet.json
 */
const main = async () => {
  loadEnv();
  const { rpc, sender } = connect('localnet');
  const admin = await loadDeployer('localnet');
  const ix = soladbInstructions();
  const user = await generateKeyPairSigner();
  const node = await generateKeyPairSigner();
  await airdrop(rpc, user.address, 100n * SOL);
  await airdrop(rpc, node.address, 5n * SOL);
  await sender.send({ feePayer: admin, instructions: [await ix.registerReplicator(admin, node.address, 'http://localhost:3000')] });

  const cu = async (signature: Signature) => {
    const tx = await rpc.getTransaction(signature, { encoding: 'base64', maxSupportedTransactionVersion: 1 } as any).send();
    return Number((tx as any)?.meta?.computeUnitsConsumed ?? 0);
  };

  // ── Compute units per instruction ──────────────────────────────────────────
  const client = new SolaDBClient({ rpc, signer: user, replicas: 1 });
  const units: Record<string, number> = {};
  units.register_identity = await cu((await client.register()) as Signature);
  const small = await client.uploadFile(new Uint8Array(randomBytes(3_000)), { name: 'probe.bin' });
  units['open_chunk + create_record (1 chunk)'] = await cu(small.signatures[0] as Signature);
  const probe = small.chunks[0];
  const account = (await fetchAccount<ChunkAccount>(rpc, probe, 'Chunk'))!.data;
  await readChunkFromLedger(rpc, probe, account.contentHash);
  units.confirm_replication = await cu(await sender.send({ feePayer: node, instructions: [await ix.confirmReplication(node, probe)] }));

  // one isolated write_segment of each size
  const writer = new SolaDBClient({ rpc, signer: user, sessionWriter: false, replicas: 1 });
  for (const version of [0, 1] as const) {
    const size = await writer.segmentSize(version);
    const data = new Uint8Array(randomBytes(size));
    const c = new SolaDBClient({ rpc, signer: user, sessionWriter: false, segmentTxVersion: version });
    const result = await c.uploadFile(data.subarray(0, size - 28), { name: `segment-v${version}` });
    const sigs = await rpc.getSignaturesForAddress(result.chunks[0], { limit: 5 }).send();
    const writeSig = sigs.find((s) => !result.signatures.includes(s.signature))!.signature;
    units[`write_segment (v${version}, ${size} bytes)`] = await cu(writeSig);
  }

  // ── Cost per file ──────────────────────────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  for (const bytes of [1_024, 100 * 1024, 1024 * 1024]) {
    for (const version of [1, 0] as const) {
      const c = new SolaDBClient({ rpc, signer: user, segmentTxVersion: version, replicas: 2 });
      const quote = await c.quoteFile(bytes, 2);
      const before = (await rpc.getBalance(user.address).send()).value;
      const t0 = Date.now();
      const result = await c.uploadFile(new Uint8Array(randomBytes(bytes)), { name: `file-${bytes}` });
      const seconds = (Date.now() - t0) / 1000;
      const spent = before - (await rpc.getBalance(user.address).send()).value;
      rows.push({
        size: bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MiB` : `${bytes / 1024} KiB`,
        tx: `v${version}`,
        chunks: result.chunks.length,
        segmentTxs: result.segmentTransactions,
        walletTxs: result.signatures.length,
        uploadFee: result.feePaid.toString(),
        rentDeposit: result.rentDeposit.toString(),
        networkFees: (spent - result.feePaid - result.rentDeposit).toString(),
        quotedTotal: quote.total.toString(),
        spent: spent.toString(),
        seconds,
      });
      console.log(`${rows.at(-1)!.size} v${version}: ${result.segmentTransactions} segments, spent ${sol(spent)} in ${seconds.toFixed(1)} s`);
    }
  }

  console.log('\n| Instruction | Compute units |\n| --- | --- |');
  for (const [name, value] of Object.entries(units)) console.log(`| \`${name}\` | ${value.toLocaleString('en-US')} |`);
  console.log('\n| File | Tx | Chunks | Segment txs | Upload fee | Rent deposit (refundable) | Network fees | Time |\n| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(
      `| ${r.size} | ${r.tx} | ${r.chunks} | ${r.segmentTxs} | ${sol(BigInt(r.uploadFee as string))} | ${sol(BigInt(r.rentDeposit as string))} | ${sol(BigInt(r.networkFees as string))} | ${(r.seconds as number).toFixed(1)} s |`,
    );
  }
  const out = path.join(ROOT, 'deployments', 'costs-localnet.json');
  fs.writeFileSync(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), computeUnits: units, files: rows }, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, out)}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
