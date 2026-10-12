import {
  Address,
  Commitment,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  Rpc,
  SolanaRpcApi,
} from '@solana/kit';
import { accountDiscriminator, AccountName, decodeAccount, PROGRAM_ADDRESS } from './codec';

export interface FetchedAccount<T> {
  address: Address;
  data: T;
  lamports: bigint;
}

const fromBase64 = (value: string) => new Uint8Array(getBase64Encoder().encode(value));

/** Fetch and decode one SolaDB account; null when it does not exist */
export async function fetchAccount<T>(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
  name: AccountName,
  commitment: Commitment = 'confirmed',
): Promise<FetchedAccount<T> | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment }).send();
  if (!value) return null;
  return { address, data: decodeAccount<T>(name, fromBase64(value.data[0])), lamports: value.lamports };
}

/** Fetch many accounts of one type (null for missing ones), 100 per request */
export async function fetchAccounts<T>(
  rpc: Rpc<SolanaRpcApi>,
  addresses: Address[],
  name: AccountName,
  commitment: Commitment = 'confirmed',
): Promise<(FetchedAccount<T> | null)[]> {
  const out: (FetchedAccount<T> | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(batch, { encoding: 'base64', commitment }).send();
    value.forEach((account, j) => {
      out.push(
        account
          ? { address: batch[j], data: decodeAccount<T>(name, fromBase64(account.data[0])), lamports: account.lamports }
          : null,
      );
    });
  }
  return out;
}

export interface MemcmpFilter {
  offset: number;
  bytes: Uint8Array;
}

/** getProgramAccounts for one account type, with extra memcmp filters */
export async function listAccounts<T>(
  rpc: Rpc<SolanaRpcApi>,
  name: AccountName,
  filters: MemcmpFilter[] = [],
  options: { program?: Address; commitment?: Commitment } = {},
): Promise<FetchedAccount<T>[]> {
  const base58 = getBase58Decoder();
  const all = [{ offset: 0, bytes: accountDiscriminator(name) }, ...filters];
  const accounts = await rpc
    .getProgramAccounts(options.program ?? PROGRAM_ADDRESS, {
      encoding: 'base64',
      commitment: options.commitment ?? 'confirmed',
      filters: all.map((f) => ({
        memcmp: { offset: BigInt(f.offset), bytes: base58.decode(f.bytes) as any, encoding: 'base58' as const },
      })),
    })
    .send();
  return (accounts as any[]).map((a) => ({
    address: a.pubkey as Address,
    data: decodeAccount<T>(name, fromBase64(a.account.data[0])),
    lamports: a.account.lamports as bigint,
  }));
}

export const addressBytes = (address: Address) => new Uint8Array(getAddressEncoder().encode(address));
