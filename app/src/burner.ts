import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
  lamports,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';

/**
 * Burner wallet for localnet and devnet: a key pair generated once and kept in
 * this browser's storage, so the app works without a wallet extension.  The
 * secret sits in localStorage in plain text — test only, never real funds.
 */

const STORAGE_KEY = 'soladb:burner:v1';
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The subset of Web Storage the burner needs (injectable for tests) */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Burner {
  signer: KeyPairSigner;
  /** false when storage is unavailable: the key lasts for this visit only */
  persisted: boolean;
}

/** localStorage, or undefined where it is blocked (private mode, sandboxed frames) */
export function browserStorage(): KeyStore | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  return Uint8Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

let ephemeralSeed: Uint8Array | undefined;

/** Load the burner key, creating (and storing) it on first use */
export async function loadBurner(store: KeyStore | undefined = browserStorage()): Promise<Burner> {
  let seed: Uint8Array | undefined;
  try {
    seed = fromHex(store?.getItem(STORAGE_KEY) ?? '');
  } catch {
    /* storage blocked: fall through to a fresh key */
  }
  let persisted = Boolean(seed);
  if (!seed) {
    seed = ephemeralSeed ?? crypto.getRandomValues(new Uint8Array(32));
    try {
      if (store) {
        store.setItem(STORAGE_KEY, toHex(seed));
        persisted = true;
      }
    } catch {
      /* private mode: keep the key in memory for this visit */
    }
    if (!persisted) ephemeralSeed = seed;
  }
  return { signer: await createKeyPairSignerFromPrivateKeyBytes(seed), persisted };
}

/** Delete the stored burner key (its SOL is lost unless sent elsewhere first) */
export function forgetBurner(store: KeyStore | undefined = browserStorage()): void {
  ephemeralSeed = undefined;
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the cluster's faucet for SOL and wait until the airdrop is confirmed.
 * Localnet always pays; the public devnet faucet is rate limited and may refuse.
 */
export async function requestAirdrop(
  rpc: Rpc<SolanaRpcApi>,
  recipient: Address,
  sol: bigint,
  { timeoutMs = 60_000 } = {},
): Promise<Signature> {
  const signature = await rpc.requestAirdrop(recipient, lamports(sol * LAMPORTS_PER_SOL), { commitment: 'confirmed' }).send();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) {
      throw new Error(`The airdrop failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
  }
  throw new Error('The airdrop was not confirmed in time. Check the balance again in a moment.');
}
