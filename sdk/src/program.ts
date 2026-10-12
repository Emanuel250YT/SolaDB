import {
  AccountRole,
  Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  Instruction,
  TransactionSigner,
} from '@solana/kit';
import { encodeInstructionData, PROGRAM_ADDRESS } from './codec';

/** On-chain account layouts (camelCased from the IDL) */

export type ChunkState = 'Pending' | 'Hot' | 'Cool';

export interface ConfigAccount {
  admin: Address;
  treasury: Address;
  baseFeePerReplica: bigint;
  pricePerByte: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
  bump: number;
}

export interface ConfigParams {
  treasury: Address;
  baseFeePerReplica: bigint;
  pricePerByte: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
}

export interface IdentityAccount {
  user: Address;
  encryptionKey: Uint8Array;
  registeredAt: bigint;
  updatedAt: bigint;
  recordNonce: bigint;
  bump: number;
}

export interface ReplicatorAccount {
  authority: Address;
  active: boolean;
  bump: number;
  registeredAt: bigint;
  confirmations: bigint;
  lamportsEarned: bigint;
  endpoint: string;
}

export interface ChunkAccount {
  owner: Address;
  contentHash: Uint8Array;
  writer: Address;
  state: ChunkState;
  needsReplicas: boolean;
  reclaimed: boolean;
  bump: number;
  requiredReplicas: number;
  confirmedReplicas: number;
  segmentSize: number;
  segmentsTotal: number;
  segmentsWritten: number;
  size: number;
  rewardPerReplica: bigint;
  openedAt: bigint;
  completedAt: bigint;
  reclaimableAt: bigint;
  segments: Uint8Array;
  replicators: Address[];
}

export interface RecordAccount {
  owner: Address;
  nonce: bigint;
  createdAt: bigint;
  updatedAt: bigint;
  viewerCount: number;
  bump: number;
  schema: string;
  content: Uint8Array;
}

export interface GrantAccount {
  record: Address;
  owner: Address;
  viewer: Address;
  grantedAt: bigint;
  updatedAt: bigint;
  bump: number;
  content: Uint8Array;
}

/** Byte offsets used in getProgramAccounts filters */
export const OFFSETS = {
  chunk: { owner: 8, state: 104, needsReplicas: 105 },
  record: { owner: 8 },
  grant: { record: 8, owner: 40, viewer: 72 },
  replicator: { authority: 8, active: 40 },
} as const;

export const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address;

// ── PDAs ─────────────────────────────────────────────────────────────────────

const text = (s: string) => new TextEncoder().encode(s);
const addr = (a: Address) => getAddressEncoder().encode(a);

async function pda(seeds: Uint8Array[], programAddress: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({ programAddress, seeds });
  return address;
}

export const pdas = {
  config: (program = PROGRAM_ADDRESS) => pda([text('config')], program),
  identity: (user: Address, program = PROGRAM_ADDRESS) => pda([text('identity'), addr(user) as Uint8Array], program),
  replicator: (authority: Address, program = PROGRAM_ADDRESS) =>
    pda([text('replicator'), addr(authority) as Uint8Array], program),
  chunk: (owner: Address, contentHash: Uint8Array, program = PROGRAM_ADDRESS) =>
    pda([text('chunk'), addr(owner) as Uint8Array, contentHash], program),
  record: (owner: Address, nonce: bigint, program = PROGRAM_ADDRESS) =>
    pda([text('record'), addr(owner) as Uint8Array, getU64Encoder().encode(nonce) as Uint8Array], program),
  grant: (record: Address, viewer: Address, program = PROGRAM_ADDRESS) =>
    pda([text('grant'), addr(record) as Uint8Array, addr(viewer) as Uint8Array], program),
  programData: (program = PROGRAM_ADDRESS) =>
    pda([addr(program) as Uint8Array], 'BPFLoaderUpgradeab1e11111111111111111111111' as Address),
};

// ── Instruction builders ─────────────────────────────────────────────────────

type Meta = { address: Address; role: AccountRole; signer?: TransactionSigner };

const readonly = (address: Address): Meta => ({ address, role: AccountRole.READONLY });
const writable = (address: Address): Meta => ({ address, role: AccountRole.WRITABLE });
const signer = (s: TransactionSigner, isWritable = true): Meta => ({
  address: s.address,
  role: isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
  signer: s,
});

function instruction(accounts: Meta[], data: Uint8Array, programAddress: Address): Instruction {
  return { programAddress, accounts, data } as Instruction;
}

export interface OpenChunkArgs {
  contentHash: Uint8Array;
  size: number;
  segmentSize: number;
  replicas: number;
  writer: Address;
  maxFee: bigint;
}

/**
 * Builders for every SolaDB instruction.  Signer accounts carry their
 * TransactionSigner so `signTransactionMessageWithSigners` can find them.
 */
export function soladbInstructions(program: Address = PROGRAM_ADDRESS) {
  const ix = (accounts: Meta[], data: Uint8Array) => instruction(accounts, data, program);
  return {
    async initialize(admin: TransactionSigner, params: ConfigParams) {
      return ix(
        [
          signer(admin),
          writable(await pdas.config(program)),
          readonly(program),
          readonly(await pdas.programData(program)),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('initialize', { params }),
      );
    },

    async updateConfig(admin: TransactionSigner, params: ConfigParams) {
      return ix([signer(admin, false), writable(await pdas.config(program))], encodeInstructionData('updateConfig', { params }));
    },

    async registerReplicator(admin: TransactionSigner, authority: Address, endpoint: string) {
      return ix(
        [
          signer(admin),
          readonly(await pdas.config(program)),
          readonly(authority),
          writable(await pdas.replicator(authority, program)),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('registerReplicator', { endpoint }),
      );
    },

    async setReplicatorActive(admin: TransactionSigner, authority: Address, active: boolean) {
      return ix(
        [signer(admin, false), readonly(await pdas.config(program)), writable(await pdas.replicator(authority, program))],
        encodeInstructionData('setReplicatorActive', { active }),
      );
    },

    async updateReplicatorEndpoint(authority: TransactionSigner, endpoint: string) {
      return ix(
        [signer(authority, false), writable(await pdas.replicator(authority.address, program))],
        encodeInstructionData('updateReplicatorEndpoint', { endpoint }),
      );
    },

    async registerIdentity(user: TransactionSigner, encryptionKey: Uint8Array) {
      return ix(
        [signer(user), writable(await pdas.identity(user.address, program)), readonly(SYSTEM_PROGRAM_ADDRESS)],
        encodeInstructionData('registerIdentity', { encryptionKey }),
      );
    },

    async updateIdentity(user: TransactionSigner, encryptionKey: Uint8Array) {
      return ix(
        [signer(user, false), writable(await pdas.identity(user.address, program))],
        encodeInstructionData('updateIdentity', { encryptionKey }),
      );
    },

    async openChunk(owner: TransactionSigner, treasury: Address, args: OpenChunkArgs) {
      return ix(
        [
          signer(owner),
          readonly(await pdas.identity(owner.address, program)),
          readonly(await pdas.config(program)),
          writable(await pdas.chunk(owner.address, args.contentHash, program)),
          writable(treasury),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('openChunk', { args }),
      );
    },

    writeSegment(writer: TransactionSigner, chunk: Address, index: number, data: Uint8Array) {
      return ix([signer(writer, false), writable(chunk)], encodeInstructionData('writeSegment', { index, data }));
    },

    async confirmReplication(authority: TransactionSigner, chunk: Address) {
      return ix(
        [
          signer(authority),
          writable(await pdas.replicator(authority.address, program)),
          writable(chunk),
          readonly(await pdas.config(program)),
        ],
        encodeInstructionData('confirmReplication'),
      );
    },

    reclaimUnreplicated(owner: TransactionSigner, chunk: Address) {
      return ix([signer(owner), writable(chunk)], encodeInstructionData('reclaimUnreplicated'));
    },

    closeChunk(owner: TransactionSigner, chunk: Address) {
      return ix([signer(owner), writable(chunk)], encodeInstructionData('closeChunk'));
    },

    async createRecord(owner: TransactionSigner, nonce: bigint, schema: string, content: Uint8Array) {
      return ix(
        [
          signer(owner),
          writable(await pdas.identity(owner.address, program)),
          writable(await pdas.record(owner.address, nonce, program)),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('createRecord', { schema, content }),
      );
    },

    updateRecord(owner: TransactionSigner, record: Address, content: Uint8Array) {
      return ix(
        [signer(owner), writable(record), readonly(SYSTEM_PROGRAM_ADDRESS)],
        encodeInstructionData('updateRecord', { content }),
      );
    },

    deleteRecord(owner: TransactionSigner, record: Address) {
      return ix([signer(owner), writable(record)], encodeInstructionData('deleteRecord'));
    },

    async grantAccess(owner: TransactionSigner, record: Address, viewer: Address, content: Uint8Array) {
      return ix(
        [
          signer(owner),
          writable(record),
          readonly(await pdas.identity(viewer, program)),
          writable(await pdas.grant(record, viewer, program)),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('grantAccess', { content }),
      );
    },

    async updateGrant(owner: TransactionSigner, record: Address, viewer: Address, content: Uint8Array) {
      return ix(
        [signer(owner), writable(await pdas.grant(record, viewer, program)), readonly(SYSTEM_PROGRAM_ADDRESS)],
        encodeInstructionData('updateGrant', { content }),
      );
    },

    async revokeAccess(owner: TransactionSigner, record: Address, viewer: Address) {
      return ix(
        [signer(owner), writable(record), writable(await pdas.grant(record, viewer, program))],
        encodeInstructionData('revokeAccess'),
      );
    },
  };
}

/** System program transfer (lamports from a signer) */
export function transferSol(from: TransactionSigner, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [signer(from), writable(to)],
    data,
  } as Instruction;
}

// ── Economics (mirrors Config::quote / split_fee) ────────────────────────────

export function quoteChunk(config: Pick<ConfigAccount, 'baseFeePerReplica' | 'pricePerByte'>, size: number, replicas: number): bigint {
  return BigInt(replicas) * (config.baseFeePerReplica + BigInt(size) * config.pricePerByte);
}

export function splitFee(config: Pick<ConfigAccount, 'protocolFeeBps'>, fee: bigint, replicas: number) {
  const protocol = (fee * BigInt(config.protocolFeeBps)) / 10_000n;
  const rewardPerReplica = (fee - protocol) / BigInt(replicas);
  return { protocolFee: fee - rewardPerReplica * BigInt(replicas), rewardPerReplica };
}

/** Size of a Chunk account (mirrors Chunk::space) */
export function chunkAccountSize(segments: number, replicas: number): number {
  return 8 + 32 * 3 + 6 + 2 + 4 * 3 + 8 * 4 + 4 + Math.ceil(segments / 8) + 4 + 32 * replicas;
}

export function recordAccountSize(schemaLength: number, contentLength: number): number {
  return 8 + 32 + 8 * 3 + 4 + 1 + 4 + schemaLength + 4 + contentLength;
}

export function grantAccountSize(contentLength: number): number {
  return 8 + 32 * 3 + 8 * 2 + 1 + 4 + contentLength;
}
