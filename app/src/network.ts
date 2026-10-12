import {
  type SolaDBDeployment,
  type ConfigAccount,
  DEPLOYMENTS,
  fetchAccount,
  listAccounts,
  pdas,
  PROGRAM_ADDRESS,
  type ReplicatorAccount,
} from '@soladb/sdk';
import { type Address, address, createSolanaRpc, isAddress, type Rpc, type SolanaRpcApi } from '@solana/kit';

// ── Clusters ────────────────────────────────────────────────────────────────

export const CLUSTERS = {
  devnet: {
    name: 'Solana Devnet',
    chain: 'solana:devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    testOnly: true,
  },
  mainnet: {
    name: 'Solana',
    chain: 'solana:mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    testOnly: false,
  },
  // Local development against `npm run localnet` (scripts/localnet.sh)
  localnet: {
    name: 'Solana Localnet',
    chain: 'solana:localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    testOnly: true,
  },
} as const;

export type Cluster = keyof typeof CLUSTERS;
export type SolanaChain = (typeof CLUSTERS)[Cluster]['chain'];

/** The VITE_* variables the app reads (see .env.example) */
export interface NetworkEnv {
  VITE_SOLADB_CLUSTER?: string;
  VITE_SOLANA_RPC_URL?: string;
  VITE_SOLADB_DEPLOYMENT?: string;
  VITE_SOLADB_NODE_URLS?: string;
}

export interface Network {
  cluster: Cluster;
  /** Human name, e.g. "Solana Devnet" */
  name: string;
  /** Wallet Standard chain the wallet signs for */
  chain: SolanaChain;
  rpcUrl: string;
  /** Undefined when SolaDB has no deployment on this cluster */
  deployment?: SolaDBDeployment;
  programId: Address;
  /** Replicator endpoints tried first for downloads */
  nodeUrls: string[];
  /** Burner wallet and airdrops are offered (never on mainnet) */
  testOnly: boolean;
  /** Configuration mistake to show instead of a working app */
  problem?: string;
}

function isCluster(value: string): value is Cluster {
  return Object.hasOwn(CLUSTERS, value);
}

function parseDeployment(json: string): SolaDBDeployment {
  let value: Partial<SolaDBDeployment>;
  try {
    value = JSON.parse(json) as Partial<SolaDBDeployment>;
  } catch {
    throw new Error('VITE_SOLADB_DEPLOYMENT is not valid JSON (inline the whole deployments/solana-<cluster>.json on one line).');
  }
  if (!value || typeof value.programId !== 'string' || !isAddress(value.programId)) {
    throw new Error('VITE_SOLADB_DEPLOYMENT needs a "programId" with a valid Solana address.');
  }
  return {
    cluster: String(value.cluster ?? ''),
    rpcUrl: String(value.rpcUrl ?? ''),
    programId: value.programId,
    ...(value.deploySlot !== undefined ? { deploySlot: Number(value.deploySlot) } : {}),
    nodes: Array.isArray(value.nodes) ? value.nodes.map(String) : [],
  };
}

function splitUrls(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Work out which cluster, RPC and program the app uses.  Precedence:
 * VITE_SOLADB_DEPLOYMENT, then the SDK's DEPLOYMENTS[cluster], then (localnet
 * only) the local validator with the SDK's built-in program id.
 */
export function resolveNetwork(env: NetworkEnv, deployments: Record<string, SolaDBDeployment> = DEPLOYMENTS): Network {
  let deployment: SolaDBDeployment | undefined;
  let problem: string | undefined;
  try {
    deployment = env.VITE_SOLADB_DEPLOYMENT?.trim() ? parseDeployment(env.VITE_SOLADB_DEPLOYMENT) : undefined;
  } catch (err) {
    problem = (err as Error).message;
  }

  // An explicit cluster wins; otherwise the inlined deployment says which one it is
  const wanted = (env.VITE_SOLADB_CLUSTER?.trim() || deployment?.cluster || 'devnet').toLowerCase();
  const normalized = wanted === 'mainnet-beta' ? 'mainnet' : wanted;
  let cluster: Cluster = 'devnet';
  if (isCluster(normalized)) cluster = normalized;
  else problem ??= `Unknown cluster "${wanted}". Set VITE_SOLADB_CLUSTER to devnet, mainnet or localnet.`;

  if (deployment?.cluster && env.VITE_SOLADB_CLUSTER?.trim()) {
    const own = deployment.cluster.toLowerCase() === 'mainnet-beta' ? 'mainnet' : deployment.cluster.toLowerCase();
    if (own !== cluster) {
      problem ??= `VITE_SOLADB_DEPLOYMENT is for ${deployment.cluster} but VITE_SOLADB_CLUSTER is ${cluster}.`;
    }
  }

  deployment ??= deployments[cluster];
  if (!deployment && cluster === 'localnet') {
    deployment = { cluster: 'localnet', rpcUrl: CLUSTERS.localnet.rpcUrl, programId: PROGRAM_ADDRESS, nodes: [] };
  }

  const info = CLUSTERS[cluster];
  const envNodes = splitUrls(env.VITE_SOLADB_NODE_URLS);
  return {
    cluster,
    name: info.name,
    chain: info.chain,
    rpcUrl: env.VITE_SOLANA_RPC_URL?.trim() || deployment?.rpcUrl || info.rpcUrl,
    deployment,
    programId: address(deployment?.programId ?? PROGRAM_ADDRESS),
    nodeUrls: envNodes.length ? envNodes : (deployment?.nodes ?? []).map((u) => u.replace(/\/$/, '')),
    testOnly: info.testOnly,
    problem,
  };
}

// ── Explorers ───────────────────────────────────────────────────────────────

/** Solana Explorer link for an account or a transaction signature */
export function explorerUrl(network: Pick<Network, 'cluster' | 'rpcUrl'>, kind: 'address' | 'tx', value: string): string {
  const url = new URL(`https://explorer.solana.com/${kind}/${encodeURIComponent(value)}`);
  if (network.cluster === 'devnet') url.searchParams.set('cluster', 'devnet');
  if (network.cluster === 'localnet') {
    url.searchParams.set('cluster', 'custom');
    url.searchParams.set('customUrl', network.rpcUrl);
  }
  return url.toString();
}

/** Solscan link (Solscan cannot see a local validator) */
export function solscanUrl(network: Pick<Network, 'cluster'>, kind: 'address' | 'tx', value: string): string | undefined {
  if (network.cluster === 'localnet') return undefined;
  const url = new URL(`https://solscan.io/${kind === 'address' ? 'account' : 'tx'}/${encodeURIComponent(value)}`);
  if (network.cluster === 'devnet') url.searchParams.set('cluster', 'devnet');
  return url.toString();
}

// ── Read-only checks (no wallet needed) ─────────────────────────────────────

export function createRpc(network: Pick<Network, 'rpcUrl'>): Rpc<SolanaRpcApi> {
  return createSolanaRpc(network.rpcUrl);
}

/** Why the cluster cannot be used: the RPC does not answer, or the program has no Config */
export class NetworkProblem extends Error {
  constructor(
    message: string,
    readonly kind: 'rpc' | 'uninitialized',
  ) {
    super(message);
    this.name = 'NetworkProblem';
  }
}

/**
 * Load the program's Config account.  Throws a NetworkProblem when the RPC is
 * unreachable or SolaDB is not deployed and initialized on the cluster (the
 * same condition makes SolaDBClient.config() throw).
 */
export async function probeProgram(network: Network, rpc: Rpc<SolanaRpcApi> = createRpc(network)): Promise<ConfigAccount> {
  let account;
  try {
    account = await fetchAccount<ConfigAccount>(rpc, await pdas.config(network.programId), 'Config');
  } catch (err) {
    throw new NetworkProblem(`Cannot read from the ${network.name} RPC at ${network.rpcUrl} (${(err as Error).message}).`, 'rpc');
  }
  if (!account) {
    throw new NetworkProblem(
      `SolaDB is not initialized on ${network.name}: program ${network.programId} has no Config account.`,
      'uninitialized',
    );
  }
  return account.data;
}

export interface ReplicatorInfo {
  /** Replicator account (PDA) */
  address: Address;
  /** Key the node signs confirmations with */
  authority: Address;
  endpoint: string;
  active: boolean;
  confirmations: bigint;
}

/** Registered replicator nodes, active ones first */
export async function listReplicators(network: Network, rpc: Rpc<SolanaRpcApi> = createRpc(network)): Promise<ReplicatorInfo[]> {
  const accounts = await listAccounts<ReplicatorAccount>(rpc, 'Replicator', [], { program: network.programId });
  return accounts
    .filter((a) => isAddress(a.address) && isAddress(a.data.authority))
    .map((a) => ({
      address: a.address,
      authority: a.data.authority,
      endpoint: a.data.endpoint,
      active: a.data.active,
      confirmations: a.data.confirmations,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.confirmations - a.confirmations));
}
