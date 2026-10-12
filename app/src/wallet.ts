import type { SignMessage } from '@soladb/sdk';
import { type Address, address, createSignableMessage, type KeyPairSigner, type TransactionSigner } from '@solana/kit';
import { createMessageSignerFromWalletAccount, createTransactionSignerFromWalletAccount } from '@solana/wallet-account-signer';
import { SolanaSignMessage, SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
} from '@wallet-standard/features';
import { getOrCreateUiWalletAccountForStandardWalletAccount } from '@wallet-standard/ui-registry';
import type { SolanaChain } from './network';

/**
 * Wallet layer: Wallet Standard wallets (Phantom, Solflare, Backpack…) and
 * the burner wallet, both turned into what SolaDBClient needs — a kit
 * TransactionSigner and, for extensions, a signMessage function.
 */

export interface WalletSession {
  kind: 'standard' | 'burner';
  /** Wallet name as the wallet reports it (untrusted: render as text) */
  name: string;
  address: Address;
  signer: TransactionSigner;
  /** Undefined for the burner: a KeyPairSigner signs messages itself */
  signMessage?: SignMessage;
  disconnect(): Promise<void>;
}

/** What the session owner hears about: another account, or none (disconnected) */
export type SessionChange = (next: WalletSession | null) => void;

// ── Discovery ───────────────────────────────────────────────────────────────

function hasFeature(wallet: Wallet, feature: string): boolean {
  return Object.hasOwn(wallet.features, feature);
}

/** Wallets that can connect and sign Solana transactions */
export function isSolanaWallet(wallet: Wallet): boolean {
  return (
    wallet.chains.some((chain) => chain.startsWith('solana:')) &&
    hasFeature(wallet, StandardConnect) &&
    hasFeature(wallet, SolanaSignTransaction)
  );
}

export function listWallets(): Wallet[] {
  return getWallets().get().filter(isSolanaWallet);
}

/** Call `listener` whenever a wallet registers or goes away; returns the unsubscribe */
export function watchWallets(listener: (wallets: Wallet[]) => void): () => void {
  const { on } = getWallets();
  const update = () => listener(listWallets());
  const offRegister = on('register', update);
  const offUnregister = on('unregister', update);
  return () => {
    offRegister();
    offUnregister();
  };
}

/** Wallet icons are data: URIs supplied by the extension; accept images only */
export function safeIcon(wallet: Wallet): string | undefined {
  return /^data:image\/(svg\+xml|png|webp|gif|jpeg);base64,[a-z0-9+/=\s]+$/i.test(wallet.icon) ? wallet.icon : undefined;
}

// ── Wallet Standard sessions ────────────────────────────────────────────────

function sessionFor(wallet: Wallet, account: WalletAccount, chain: SolanaChain, unsubscribe: () => void): WalletSession {
  if (!account.chains.includes(chain)) {
    throw new Error(
      `${wallet.name} does not offer ${chain} for this account. ` +
        (chain === 'solana:localnet' ? 'Use the burner wallet on localnet.' : 'Pick another wallet or account.'),
    );
  }
  if (!account.features.includes(SolanaSignTransaction)) {
    throw new Error(`${wallet.name} cannot sign transactions for this account.`);
  }
  // SolaDB's wallet transactions are v0 (the 4 KiB v1 segment writes are signed by a session key)
  const versions = (wallet.features as SolanaSignTransactionFeature)[SolanaSignTransaction].supportedTransactionVersions;
  if (Array.isArray(versions) && !versions.includes(0)) {
    throw new Error(`${wallet.name} cannot sign version 0 transactions, which SolaDB uses.`);
  }
  const uiAccount = getOrCreateUiWalletAccountForStandardWalletAccount(wallet, account);
  const signer = createTransactionSignerFromWalletAccount(uiAccount, chain);

  // SolaDB derives the encryption key from one message signature (solana:signMessage)
  const canSignMessages = account.features.includes(SolanaSignMessage);
  const signMessage: SignMessage = async (message) => {
    if (!canSignMessages) {
      throw new Error(`${wallet.name} cannot sign messages, which SolaDB needs to derive your encryption key.`);
    }
    const messageSigner = createMessageSignerFromWalletAccount(uiAccount);
    const [signed] = await messageSigner.modifyAndSignMessages([createSignableMessage(message)]);
    const signature = signed?.signatures[messageSigner.address];
    if (!signature) throw new Error(`${wallet.name} returned no signature.`);
    return new Uint8Array(signature);
  };

  return {
    kind: 'standard',
    name: wallet.name,
    address: address(account.address),
    signer,
    signMessage,
    async disconnect() {
      unsubscribe();
      if (hasFeature(wallet, StandardDisconnect)) {
        await (wallet.features as StandardDisconnectFeature)[StandardDisconnect].disconnect();
      }
    },
  };
}

/** The first account the wallet authorized that can sign on `chain` (else the first one) */
function pickAccount(accounts: readonly WalletAccount[], chain: SolanaChain): WalletAccount | undefined {
  return accounts.find((a) => a.chains.includes(chain)) ?? accounts[0];
}

/**
 * Connect to a Wallet Standard wallet.  With `silent`, only an already
 * authorized wallet answers (no prompt) and null means "not authorized".
 * `onChange` hears about account switches and disconnects made in the wallet.
 */
export async function connectWallet(
  wallet: Wallet,
  chain: SolanaChain,
  { silent = false, onChange }: { silent?: boolean; onChange?: SessionChange } = {},
): Promise<WalletSession | null> {
  if (!isSolanaWallet(wallet)) throw new Error(`${wallet.name} is not a Solana wallet.`);
  const { accounts } = await (wallet.features as StandardConnectFeature)[StandardConnect].connect({ silent });
  const account = pickAccount(accounts, chain) ?? pickAccount(wallet.accounts, chain);
  if (!account) {
    if (silent) return null;
    throw new Error(`${wallet.name} did not share any account.`);
  }

  let current = account.address;
  let off: () => void = () => {};
  const unsubscribe = () => off();
  if (hasFeature(wallet, StandardEvents) && onChange) {
    off = (wallet.features as StandardEventsFeature)[StandardEvents].on('change', ({ accounts: next }) => {
      if (!next) return;
      const replacement = pickAccount(next, chain);
      if (!replacement) {
        off();
        onChange(null);
        return;
      }
      if (replacement.address === current) return;
      current = replacement.address;
      try {
        onChange(sessionFor(wallet, replacement, chain, unsubscribe));
      } catch {
        off();
        onChange(null);
      }
    });
  }

  try {
    return sessionFor(wallet, account, chain, unsubscribe);
  } catch (err) {
    off();
    throw err;
  }
}

// ── Burner sessions ─────────────────────────────────────────────────────────

export function burnerSession(signer: KeyPairSigner): WalletSession {
  return {
    kind: 'burner',
    name: 'Burner wallet',
    address: signer.address,
    signer,
    async disconnect() {
      /* nothing to tell: the key stays in this browser for next time */
    },
  };
}
