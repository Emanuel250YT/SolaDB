#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/kit';
import { SolaDBClient, SolaDBDeployment, UploadMode } from './client';
import { DEPLOYMENTS } from './deployments';
import { toHex } from './manifest';

const HELP = `soladb — encrypted, replicated files on Solana

Usage: soladb <command> [args]

  whoami                          Address, balance, identity and encryption key
  register                        Publish this wallet's encryption key
  quote <file> [--mode M] [--epochs E] [--replicas N]
                                  Cost of uploading a file
  upload <file> [--mode M] [--epochs E] [--redundancy R] [--no-compress] [--wait]
                                  Compress, encrypt, upload and register a file
                                  --mode blob (erasure-coded shards on the
                                  nodes, prepaid E epochs: the default when a
                                  node answers), ledger (Solana ledger), direct
                                  (whole chunks on the nodes) or auto
  upload-many <name> <files…> [--epochs E]
                                  Many small files as one bundle (one account)
  download <recordId> [-o PATH] [--entry NAME]
                                  Download and decrypt a file (--entry: one
                                  file of a bundle)
  bundle <recordId> [-d DIR]      Download every file of a bundle into DIR
  extend <recordId> <epochs>      Prepay more storage epochs for a blob file
  share <recordId> <address>      Give a registered wallet read access
  revoke <recordId> <address>     Remove read access
  status <recordId>               Replication state of every chunk / blob
  reclaim [recordId]              Close settled chunks and recover their rent
                                  (no recordId: every settled chunk you own)
  rm <recordId>                   Revoke every grant, delete the record, close chunks
  ls                              Files you own or that were shared with you
  nodes                           Registered replicators

Environment:
  SOLADB_KEYPAIR     Solana keypair JSON (default ~/.config/solana/id.json)
  SOLADB_CLUSTER     devnet (default), mainnet or localnet
  SOLADB_DEPLOYMENT  path to a deployments/solana-<cluster>.json (overrides SOLADB_CLUSTER)
  SOLANA_RPC_URL     RPC endpoint (defaults to the deployment's)
  SOLADB_NODE_URLS   comma-separated replicator URLs tried first for downloads
  SOLADB_TX_VERSION  1 (default, 4 KiB segment transactions) or 0
  SOLADB_MODE        default upload mode: auto, blob, direct or ledger
  SOLADB_EPOCHS      default blob storage epochs (12)
`;

const LAMPORTS = 1_000_000_000;
const sol = (lamports: bigint) => `${(Number(lamports) / LAMPORTS).toFixed(6)} SOL`;

function loadDeployment(): SolaDBDeployment {
  const file = process.env.SOLADB_DEPLOYMENT;
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8')) as SolaDBDeployment;
  const cluster = process.env.SOLADB_CLUSTER ?? 'devnet';
  const deployment = DEPLOYMENTS[cluster];
  if (!deployment) throw new Error(`No SolaDB deployment known for "${cluster}"; set SOLADB_DEPLOYMENT`);
  return deployment;
}

async function loadKeypair(): Promise<KeyPairSigner> {
  const file = process.env.SOLADB_KEYPAIR ?? path.join(os.homedir(), '.config', 'solana', 'id.json');
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')) as number[]);
  return createKeyPairSignerFromBytes(secret);
}

async function makeClient(): Promise<SolaDBClient> {
  const deployment = loadDeployment();
  const nodeUrls = (process.env.SOLADB_NODE_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return new SolaDBClient({
    signer: await loadKeypair(),
    deployment,
    rpc: process.env.SOLANA_RPC_URL ?? deployment.rpcUrl,
    nodeUrls: nodeUrls.length ? nodeUrls : deployment.nodes,
    segmentTxVersion: process.env.SOLADB_TX_VERSION === '0' ? 0 : 1,
    mode: uploadMode(process.env.SOLADB_MODE ?? 'auto'),
    epochs: Number(process.env.SOLADB_EPOCHS ?? '12'),
    // a CLI keypair signs without prompts: no session key needed
    sessionWriter: false,
  });
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

function uploadMode(value: string): UploadMode {
  if (value !== 'auto' && value !== 'blob' && value !== 'direct' && value !== 'ledger') {
    throw new Error(`Unknown mode "${value}" (auto, blob, direct or ledger)`);
  }
  return value;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run "soladb help".`);
  return value;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv', '.md': 'text/markdown',
};

async function main(argv: string[]) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const client = await makeClient();

  switch (command) {
    case 'whoami': {
      const { value: balance } = await client.rpc.getBalance(client.address).send();
      const { publicKey } = await client.keys();
      const identity = await client.identity();
      console.log(`address     ${client.address}`);
      console.log(`balance     ${sol(balance)}`);
      console.log(`registered  ${identity !== null}${identity && toHex(identity.encryptionKey) !== toHex(publicKey) ? ' (different key, run register)' : ''}`);
      console.log(`public key  ${toHex(publicKey)}`);
      return;
    }
    case 'register': {
      const signature = await client.register();
      console.log(signature ? `Encryption key published (${signature})` : 'Already registered with this key');
      return;
    }
    case 'quote': {
      const replicas = Number(option(args, '--replicas') ?? '1');
      const mode = uploadMode(option(args, '--mode') ?? process.env.SOLADB_MODE ?? 'auto');
      const epochs = option(args, '--epochs');
      const file = need(args[0], '<file>');
      const q = await client.quoteFile(fs.statSync(file).size, replicas, mode, epochs ? { epochs: Number(epochs) } : {});
      if (q.mode === 'blob') {
        const days = Number(q.storageSeconds ?? 0n) / 86_400;
        console.log(`${path.basename(file)}, blob: ${q.layout!.k}+${q.layout!.m} shards (any ${q.layout!.k} rebuild it), ${q.chunks} blob account(s), ${q.epochs} epoch(s) ≈ ${days.toFixed(1)} days`);
        console.log(`  storage fee   ${sol(q.uploadFee)}  (prepaid, protocol + shard holders)`);
        console.log(`  network fees  ${sol(q.networkFee)}`);
        console.log(`  blob rent     ${sol(q.chunkRent)}  (back when the storage ends)`);
      } else {
        console.log(`${path.basename(file)} with ${replicas} replica(s), ${q.mode}: ${q.chunks} chunk(s), ${q.segments} segment transaction(s)`);
        console.log(`  upload fee    ${sol(q.uploadFee)}  (protocol + replicators)`);
        console.log(`  network fees  ${sol(q.networkFee)}`);
        console.log(`  chunk rent    ${sol(q.chunkRent)}  (back by itself once replicated)`);
      }
      console.log(`  record rent   ${sol(q.recordRent)}  (back when the file is deleted)`);
      console.log(`  real cost     ${sol(q.uploadFee + q.networkFee)}  (at most; compression lowers it)`);
      return;
    }
    case 'upload': {
      const replicas = Number(option(args, '--replicas') ?? '1');
      const modeOption = option(args, '--mode');
      const mode = modeOption ? uploadMode(modeOption) : undefined;
      const compress = !flag(args, '--no-compress');
      const epochs = option(args, '--epochs');
      const redundancy = option(args, '--redundancy');
      const wait = flag(args, '--wait');
      const file = need(args[0], '<file>');
      const data = new Uint8Array(fs.readFileSync(file));
      if (!(await client.isRegistered())) {
        console.log('Registering encryption key…');
        await client.register();
      }
      const result = await client.uploadFile(data, {
        name: path.basename(file),
        mime: MIME[path.extname(file).toLowerCase()],
        replicas,
        mode,
        compress,
        ...(epochs ? { epochs: Number(epochs) } : {}),
        ...(redundancy ? { redundancy: Number(redundancy) } : {}),
        onProgress: (p) => {
          if (p.stage !== 'segments' || p.done === p.total || p.done % 25 === 0) console.log(`  [${p.done}/${p.total}] ${p.stage}`);
        },
      });
      console.log(`recordId      ${result.recordId}`);
      console.log(`mode          ${result.mode}${result.nodes.length ? ` (${result.nodes.join(', ')})` : ''}`);
      console.log(`stored        ${result.storedSize} of ${data.length} bytes${result.storedSize < data.length ? ' (gzip)' : ''}`);
      if (result.layout) {
        console.log(`erasure code  ${result.layout.k}+${result.layout.m} (any ${result.layout.k} shards rebuild it)`);
        console.log(`blobs         ${result.blobs!.join(', ')}`);
        console.log(`paid until    ${new Date(Number(result.expiresAt ?? 0n) * 1000).toISOString()}`);
      } else {
        console.log(`chunks        ${result.chunks.length}`);
      }
      console.log(`fees paid     ${sol(result.feePaid)}`);
      console.log(`rent deposit  ${sol(result.rentDeposit)} (chunk rent returns once replicated, record rent on delete)`);
      console.log(`segment txs   ${result.segmentTransactions}`);
      if (wait) {
        console.log('Waiting for replication…');
        await client.waitUntilCool(result.chunks);
        console.log('All chunks are Cool (replicated)');
      }
      return;
    }
    case 'upload-many': {
      const epochs = option(args, '--epochs');
      const name = need(args[0], '<name>');
      const paths = args.slice(1);
      if (paths.length === 0) throw new Error('Missing <files…>. Run "soladb help".');
      if (!(await client.isRegistered())) await client.register();
      const files = paths.map((p) => ({ name: path.basename(p), mime: MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream', data: new Uint8Array(fs.readFileSync(p)) }));
      const result = await client.uploadFiles(files, { name, ...(epochs ? { epochs: Number(epochs) } : {}) });
      console.log(`recordId      ${result.recordId}`);
      console.log(`files         ${result.entries.length} in one blob (${result.layout!.k}+${result.layout!.m})`);
      console.log(`stored        ${result.storedSize} bytes${result.storedSize < result.size ? ' (gzip)' : ''}`);
      console.log(`fees paid     ${sol(result.feePaid)}`);
      return;
    }
    case 'bundle': {
      const dir = option(args, '-d') ?? process.cwd();
      const entries = await client.downloadBundle(need(args[0], '<recordId>'));
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of entries) {
        const safeName = path.basename(entry.name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '');
        if (!safeName || safeName === '.' || safeName === '..') throw new Error(`Unsafe file name in the bundle: ${JSON.stringify(entry.name)}`);
        fs.writeFileSync(path.join(dir, safeName), entry.data, { flag: 'wx' });
      }
      console.log(`Saved ${entries.length} files to ${dir} (sha256 verified)`);
      return;
    }
    case 'extend': {
      const signatures = await client.extendFile(need(args[0], '<recordId>'), Number(need(args[1], '<epochs>')));
      console.log(`Extended (${signatures.join(', ')})`);
      return;
    }
    case 'download': {
      const out = option(args, '-o');
      const entry = option(args, '--entry');
      const recordId = need(args[0], '<recordId>');
      const file = await client.downloadFile(recordId, entry ? { entry } : {});
      // The manifest name is chosen by whoever shared the file: never let it pick the path
      const safeName = path.basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '');
      if (!out && (!safeName || safeName === '.' || safeName === '..')) {
        throw new Error('The file name in this record is unsafe; pass -o <path> to choose one');
      }
      const target = out ?? path.join(process.cwd(), safeName);
      // An explicit -o may overwrite; a name from the manifest never does
      fs.writeFileSync(target, file.data, { flag: out ? 'w' : 'wx' });
      console.log(`Saved ${file.data.length} bytes to ${target} (sha256 verified)`);
      return;
    }
    case 'share': {
      const signature = await client.share(need(args[0], '<recordId>'), need(args[1], '<address>'));
      console.log(`Shared (${signature})`);
      return;
    }
    case 'revoke': {
      const signature = await client.revoke(need(args[0], '<recordId>'), need(args[1], '<address>'));
      console.log(`Revoked (${signature})`);
      return;
    }
    case 'status': {
      const { manifest, chunks, cool, blobs } = await client.fileStatus(need(args[0], '<recordId>'));
      if (blobs) {
        console.log(`${manifest.name} — ${manifest.size} bytes, ${blobs.length} blob(s), ${cool ? 'Cool' : 'Hot'}`);
        for (const b of blobs) {
          const until = b.expiresAt ? new Date(Number(b.expiresAt) * 1000).toISOString() : 'closed';
          console.log(`  ${b.address}  ${b.state}  ${b.held}/${b.totalShards} shards (any ${b.dataShards} rebuild it), paid until ${until}`);
        }
        return;
      }
      console.log(`${manifest.name} — ${manifest.size} bytes, ${chunks.length} chunk(s), ${cool ? 'Cool' : 'Hot'}`);
      for (const c of chunks) {
        console.log(`  ${c.address}  ${c.state}  ${c.confirmedReplicas}/${c.requiredReplicas} replicas`);
      }
      return;
    }
    case 'reclaim': {
      if (!args[0]) {
        const { closed, lamports } = await client.reclaimAllDeposits();
        console.log(closed ? `Closed ${closed} chunk account(s); ${sol(lamports)} returned` : 'No settled chunk to close yet');
        return;
      }
      const { closed } = await client.reclaimDeposits(args[0]);
      console.log(closed ? `Closed ${closed} chunk account(s); rent returned` : 'No settled chunk to close yet');
      return;
    }
    case 'rm': {
      await client.deleteFile(need(args[0], '<recordId>'));
      console.log('Deleted');
      return;
    }
    case 'ls': {
      const files = await client.listFiles();
      if (files.length === 0) console.log('No files');
      for (const f of files) {
        const when = new Date(f.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`${f.recordId}  ${f.shared ? `shared by ${f.owner}` : 'owned'}  (${when})`);
      }
      return;
    }
    case 'nodes': {
      const nodes = await client.replicators();
      if (nodes.length === 0) console.log('No replicators registered');
      for (const n of nodes) console.log(`${n.authority}  ${n.active ? 'active  ' : 'inactive'}  ${n.endpoint}  (${n.confirmations} confirmations)`);
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run "soladb help".`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exitCode = 1;
});
