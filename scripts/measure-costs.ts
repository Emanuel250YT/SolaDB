import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Address, generateKeyPairSigner, KeyPairSigner, Signature } from '@solana/kit';
import {
  blobAccountSize,
  chooseLayout,
  soladbInstructions,
  SolaDBClient,
  ChunkAccount,
  fetchAccount,
  quoteBlob,
  UploadMode,
} from '../sdk/src';
import { airdrop, connect, loadDeployer, loadEnv, ROOT, sol, SOL } from './lib/common';

/**
 * Measures compute units per instruction and what uploading a file really
 * costs in each mode, at the configured pricing (npm run init:localnet):
 *
 *   - direct: chunks go straight to replicators (here: a no-op push, then
 *     two test replicators confirm), one wallet transaction
 *   - ledger: chunks written to the ledger in v1 (4 KiB) transactions
 *
 * Both are fully replicated (2 replicas), so the chunk rent comes back and
 * "kept" is what stays locked: the record's rent, refunded on delete.
 * Runs on localnet (scripts/localnet.sh + npm run init:localnet).
 *
 * Usage: npm run measure-costs
 * Output: Markdown tables + deployments/costs-localnet.json
 */
const main = async () => {
  loadEnv();
  const { rpc, sender } = connect('localnet');
  const admin = await loadDeployer('localnet');
  const ix = soladbInstructions();
  const user = await generateKeyPairSigner();
  const nodes = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  await airdrop(rpc, user.address, 100n * SOL);
  for (const node of nodes) {
    await airdrop(rpc, node.address, 5n * SOL);
    await sender.send({ feePayer: admin, instructions: [await ix.registerReplicator(admin, node.address, 'http://localhost:3999')] });
  }

  const cu = async (signature: Signature) => {
    const tx = await rpc.getTransaction(signature, { encoding: 'base64', maxSupportedTransactionVersion: 1 } as any).send();
    return Number((tx as any)?.meta?.computeUnitsConsumed ?? 0);
  };
  /** What a replicator does once it holds the bytes; the last confirmation closes the chunk */
  const confirm = async (node: KeyPairSigner, chunks: Address[]) => {
    const signatures: Signature[] = [];
    for (const chunk of chunks) {
      const account = await fetchAccount<ChunkAccount>(rpc, chunk, 'Chunk');
      if (!account || account.data.replicators.includes(node.address)) continue;
      signatures.push(await sender.send({ feePayer: node, instructions: [await ix.confirmReplication(node, chunk, account.data.owner)] }));
    }
    return signatures;
  };
  const client = (mode: UploadMode, replicas = 2) =>
    new SolaDBClient({ rpc, signer: user, replicas, mode, compress: false, pushChunk: async () => undefined });

  // ── Compute units per instruction ──────────────────────────────────────────
  const units: Record<string, number> = {};
  units.register_identity = await cu((await client('direct').register()) as Signature);
  const direct = await client('direct', 1).uploadFile(new Uint8Array(randomBytes(3_000)), { name: 'probe.bin' });
  units['open_chunk (direct) + create_record'] = await cu(direct.signatures[0] as Signature);
  units['confirm_replication (last replica, closes the chunk)'] = await cu((await confirm(nodes[0], direct.chunks))[0]);
  const ledger = await client('ledger', 2).uploadFile(new Uint8Array(randomBytes(3_000)), { name: 'probe.bin' });
  units['open_chunk (ledger) + create_record'] = await cu(ledger.signatures[0] as Signature);
  units.confirm_replication = await cu((await confirm(nodes[0], ledger.chunks))[0]);
  const writer = new SolaDBClient({ rpc, signer: user, sessionWriter: false, replicas: 1, mode: 'ledger', compress: false });
  const size = await writer.segmentSize(1);
  const one = await writer.uploadFile(new Uint8Array(randomBytes(size - 28)), { name: 'segment-v1' });
  const sigs = await rpc.getSignaturesForAddress(one.chunks[0], { limit: 5 }).send();
  units[`write_segment (v1, ${size} bytes)`] = await cu(sigs.find((s) => !one.signatures.includes(s.signature))!.signature);

  // ── Cost per file ──────────────────────────────────────────────────────────
  const rows: Record<string, unknown>[] = [];
  for (const bytes of [100 * 1024, 1024 * 1024, 10 * 1024 * 1024]) {
    for (const mode of ['direct', 'ledger'] as const) {
      const c = client(mode);
      const quote = await c.quoteFile(bytes, 2, mode);
      const before = (await rpc.getBalance(user.address).send()).value;
      const t0 = Date.now();
      const result = await c.uploadFile(new Uint8Array(randomBytes(bytes)), { name: `file-${bytes}` });
      const seconds = (Date.now() - t0) / 1000;
      const held = before - (await rpc.getBalance(user.address).send()).value;
      for (const node of nodes) await confirm(node, result.chunks);
      const kept = before - (await rpc.getBalance(user.address).send()).value;
      const recordSpace = (await rpc.getAccountInfo(result.recordId, { encoding: 'base64' }).send()).value!.space;
      const recordRent = await rpc.getMinimumBalanceForRentExemption(recordSpace).send();
      rows.push({
        size: bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MiB` : `${bytes / 1024} KiB`,
        mode,
        chunks: result.chunks.length,
        segmentTxs: result.segmentTransactions,
        walletTxs: result.signatures.length,
        uploadFee: result.feePaid.toString(),
        networkFees: (kept - result.feePaid - recordRent).toString(),
        heldDuringUpload: held.toString(),
        keptRecordRent: recordRent.toString(),
        realCost: (kept - recordRent).toString(),
        seconds,
      });
      console.log(`${rows.at(-1)!.size} ${mode}: ${result.segmentTransactions} segment txs, held ${sol(held)}, real cost ${sol(kept - recordRent)} in ${seconds.toFixed(1)} s`);
    }
  }

  // ── Blobs: one account per file, prepaid epochs ─────────────────────────────
  // What the uploader pays to open a blob; the shards themselves go to the
  // nodes over HTTP (no transaction), so any 32-byte root measures the cost.
  const config = await client('direct').config(true);
  const blobRows: Record<string, unknown>[] = [];
  for (const bytes of [1024 * 1024, 100 * 1024 * 1024, 1024 * 1024 * 1024]) {
    for (const nodes of [3, 14]) {
      const layout = chooseLayout({ payloadSize: bytes, nodes });
      const n = layout.k + layout.m;
      const epochs = 12;
      const root = new Uint8Array(randomBytes(32));
      const fee = quoteBlob(config, BigInt(layout.shardSize), n, epochs);
      const before = (await rpc.getBalance(user.address).send()).value;
      const signature = await sender.send({
        feePayer: user,
        instructions: [
          await ix.openBlob(user, config.treasury, {
            root,
            dataShards: layout.k,
            totalShards: n,
            shardSize: BigInt(layout.shardSize),
            payloadSize: BigInt(bytes),
            epochs,
            maxFee: fee,
          }),
        ],
      });
      const spent = before - (await rpc.getBalance(user.address).send()).value;
      const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(blobAccountSize(n))).send();
      if (blobRows.length === 0) units.open_blob = await cu(signature);
      blobRows.push({
        size: bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GiB` : `${bytes / 1024 ** 2} MiB`,
        layout: `${layout.k}+${layout.m}`,
        storedBytes: layout.storedBytes,
        epochs,
        storageDays: Number(config.epochSeconds * BigInt(epochs)) / 86_400,
        storageFee: fee.toString(),
        networkFee: (spent - fee - rent).toString(),
        blobRent: rent.toString(),
      });
      console.log(`blob ${blobRows.at(-1)!.size} ${layout.k}+${layout.m}: fee ${sol(fee)} for ${epochs} epochs, rent ${sol(rent)} (back at expiry)`);
    }
  }

  console.log('\n| Instruction | Compute units |\n| --- | --- |');
  for (const [name, value] of Object.entries(units)) console.log(`| \`${name}\` | ${value.toLocaleString('en-US')} |`);
  console.log(
    '\n| File | Mode | Chunks | Segment txs | Upload fee | Network fees | Held during upload | Kept (record rent, refundable) | Real cost | Time |' +
      '\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of rows) {
    const s = (k: string) => sol(BigInt(r[k] as string));
    console.log(
      `| ${r.size} | ${r.mode} | ${r.chunks} | ${r.segmentTxs} | ${s('uploadFee')} | ${s('networkFees')} | ${s('heldDuringUpload')} | ${s('keptRecordRent')} | ${s('realCost')} | ${(r.seconds as number).toFixed(1)} s |`,
    );
  }
  console.log(
    '\n| File | Erasure code | Stored | Prepaid | Storage fee | Network fees | Blob rent (back at expiry) |' +
      '\n| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const r of blobRows) {
    const s = (k: string) => sol(BigInt(r[k] as string));
    console.log(
      `| ${r.size} | ${r.layout} | ${((r.storedBytes as number) / 1024 ** 2).toFixed(1)} MiB | ${r.epochs} epochs (${(r.storageDays as number).toFixed(0)} days) | ${s('storageFee')} | ${s('networkFee')} | ${s('blobRent')} |`,
    );
  }
  const out = path.join(ROOT, 'deployments', 'costs-localnet.json');
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        pricing: {
          baseFeePerReplica: config.baseFeePerReplica.toString(),
          pricePerMib: config.pricePerMib.toString(),
          pricePerMibEpoch: config.pricePerMibEpoch.toString(),
          epochSeconds: Number(config.epochSeconds),
          protocolFeeBps: config.protocolFeeBps,
        },
        computeUnits: units,
        files: rows,
        blobs: blobRows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nWrote ${path.relative(ROOT, out)}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
