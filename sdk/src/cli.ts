#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/kit';
import { SolaDBClient, SolaDBDeployment } from './client';
import { DEPLOYMENTS } from './deployments';
import { toHex } from './manifest';

const HELP = `soladb — encrypted, replicated files on Solana

Usage: soladb <command> [args]

  whoami                          Address, balance, identity and encryption key
  register                        Publish this wallet's encryption key
  quote <file> [--replicas N]     Cost of uploading a file
  upload <file> [--replicas N] [--wait]
                                  Encrypt, upload and register a file
  download <recordId> [-o PATH]   Download and decrypt a file
  share <recordId> <address>      Give a registered wallet read access
  revoke <recordId> <address>     Remove read access
  status <recordId>               Replication state of every chunk
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
      const file = need(args[0], '<file>');
      const q = await client.quoteFile(fs.statSync(file).size, replicas);
      console.log(`${path.basename(file)} with ${replicas} replica(s): ${q.chunks} chunk(s), ${q.segments} segment transaction(s)`);
      console.log(`  upload fee    ${sol(q.uploadFee)}  (protocol + replicators)`);
      console.log(`  rent deposit  ${sol(q.rentDeposit)}  (refundable)`);
      console.log(`  network fees  ${sol(q.networkFee)}`);
      console.log(`  total         ${sol(q.total)}`);
      return;
    }
    case 'upload': {
      const replicas = Number(option(args, '--replicas') ?? '1');
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
        onProgress: (p) => {
          if (p.stage !== 'segments' || p.done === p.total || p.done % 25 === 0) console.log(`  [${p.done}/${p.total}] ${p.stage}`);
        },
      });
      console.log(`recordId      ${result.recordId}`);
      console.log(`chunks        ${result.chunks.length}`);
      console.log(`fees paid     ${sol(result.feePaid)}`);
      console.log(`rent deposit  ${sol(result.rentDeposit)} (refundable with "reclaim")`);
      console.log(`segment txs   ${result.segmentTransactions}`);
      if (wait) {
        console.log('Waiting for replication…');
        await client.waitUntilCool(result.chunks);
        console.log('All chunks are Cool (replicated)');
      }
      return;
    }
    case 'download': {
      const out = option(args, '-o');
      const recordId = need(args[0], '<recordId>');
      const file = await client.downloadFile(recordId);
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
      const { manifest, chunks, cool } = await client.fileStatus(need(args[0], '<recordId>'));
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
