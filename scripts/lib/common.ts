import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, createSolanaRpc, KeyPairSigner, lamports } from '@solana/kit';
import { PROGRAM_ADDRESS, TransactionSender } from '../../sdk/src';

export const ROOT = path.join(__dirname, '..', '..');

/** Minimal .env loader (KEY=value lines; real environment variables win) */
export function loadEnv(file = path.join(ROOT, '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export type Cluster = 'localnet' | 'devnet' | 'mainnet';

const DEFAULT_RPC: Record<Cluster, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

export function clusterArg(): Cluster {
  const cluster = (process.argv[2] ?? process.env.SOLADB_CLUSTER ?? 'devnet') as Cluster;
  if (!(cluster in DEFAULT_RPC)) throw new Error(`Unknown cluster "${cluster}" (localnet, devnet or mainnet)`);
  return cluster;
}

export function rpcUrl(cluster: Cluster): string {
  const override = { localnet: process.env.LOCALNET_RPC_URL, devnet: process.env.DEVNET_RPC_URL, mainnet: process.env.MAINNET_RPC_URL }[cluster];
  return override || DEFAULT_RPC[cluster];
}

export function connect(cluster: Cluster) {
  const url = rpcUrl(cluster);
  const rpc = createSolanaRpc(url);
  return { url, rpc, sender: new TransactionSender(rpc, { commitment: 'confirmed' }) };
}

export function expandHome(file: string): string {
  return file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
}

/** Load a Solana CLI keypair file (JSON array of 64 bytes) */
export async function loadKeypair(file: string): Promise<KeyPairSigner> {
  const resolved = path.resolve(ROOT, expandHome(file));
  if (!fs.existsSync(resolved)) throw new Error(`Keypair not found: ${resolved}`);
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, 'utf8')) as number[]));
}

/** Deployer / admin keypair: DEPLOYER_KEYPAIR, else .localnet/admin.json on localnet, else the Solana CLI default */
export async function loadDeployer(cluster: Cluster): Promise<KeyPairSigner> {
  const file =
    process.env.DEPLOYER_KEYPAIR ??
    (cluster === 'localnet' ? path.join(ROOT, '.localnet', 'admin.json') : '~/.config/solana/id.json');
  return loadKeypair(file);
}

export const SOL = 1_000_000_000n;
export const sol = (value: bigint) => `${(Number(value) / 1e9).toFixed(6)} SOL`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function airdrop(rpc: ReturnType<typeof createSolanaRpc>, address: string, amount: bigint): Promise<void> {
  const before = (await rpc.getBalance(address as any).send()).value;
  await rpc.requestAirdrop(address as any, lamports(amount)).send();
  for (let i = 0; i < 60; i++) {
    if ((await rpc.getBalance(address as any).send()).value >= before + amount) return;
    await sleep(500);
  }
  throw new Error(`Airdrop to ${address} did not land`);
}

// ── deployments/solana-<cluster>.json ────────────────────────────────────────

export interface Deployment {
  cluster: Cluster;
  rpcUrl: string;
  programId: string;
  programDataAddress: string;
  upgradeAuthority: string;
  configAddress: string;
  deploySlot?: number;
  deployedAt: string;
  pricing: {
    treasury: string;
    baseFeePerReplicaLamports: string;
    pricePerMibLamports: string;
    protocolFeeBps: number;
    replicationThresholdPct: number;
    replicationWindowSeconds: number;
    epochSeconds: number;
    pricePerMibEpochLamports: string;
    challengeWindowSlots: number;
    challengeCooldownSeconds: number;
    challengerBountyBps: number;
  };
  replicators: { authority: string; endpoint: string }[];
  /** Public replicator endpoints advertised to SDK users */
  nodes: string[];
  explorer: string;
}

export function deploymentPath(cluster: Cluster): string {
  return path.join(ROOT, 'deployments', `solana-${cluster}.json`);
}

export function readDeployment(cluster: Cluster): Deployment {
  const file = deploymentPath(cluster);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}. Run "npm run init:${cluster}" first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Deployment;
}

export function writeDeployment(deployment: Deployment): string {
  const file = deploymentPath(deployment.cluster);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return file;
}

export function explorerFor(cluster: Cluster): string {
  return cluster === 'mainnet'
    ? 'https://explorer.solana.com'
    : cluster === 'devnet'
      ? 'https://explorer.solana.com/?cluster=devnet'
      : 'https://explorer.solana.com/?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899';
}

export function explorerLink(cluster: Cluster, kind: 'address' | 'tx', value: string): string {
  const base = explorerFor(cluster);
  const [origin, query] = base.split('?');
  return `${origin.replace(/\/$/, '')}/${kind}/${value}${query ? `?${query}` : ''}`;
}

export { PROGRAM_ADDRESS };
