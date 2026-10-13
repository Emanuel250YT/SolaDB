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
import { sha256 } from './crypto';

/** On-chain account layouts (camelCased from the IDL) */

export type ChunkState = 'Pending' | 'Hot' | 'Cool';

export interface ConfigAccount {
  admin: Address;
  treasury: Address;
  baseFeePerReplica: bigint;
  /** Lamports per MiB per replica, charged pro rata to the byte */
  pricePerMib: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
  bump: number;
  /** Blob storage is prepaid per epoch of this many seconds */
  epochSeconds: bigint;
  /** Lamports per MiB of shard per epoch, pro rata */
  pricePerMibEpoch: bigint;
  /** Slots a holder has to answer a challenge after its target slot */
  challengeWindowSlots: bigint;
  /** Seconds between two challenges of one shard slot */
  challengeCooldown: bigint;
  /** Share of forfeited rewards paid to whoever reports a failed challenge */
  challengerBountyBps: number;
}

export interface ConfigParams {
  treasury: Address;
  baseFeePerReplica: bigint;
  pricePerMib: bigint;
  protocolFeeBps: number;
  replicationThresholdPct: number;
  replicationWindow: bigint;
  epochSeconds: bigint;
  pricePerMibEpoch: bigint;
  challengeWindowSlots: bigint;
  challengeCooldown: bigint;
  challengerBountyBps: number;
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

export type BlobState = 'Hot' | 'Cool';

export interface ShardSlot {
  /** The default address (11111111111111111111111111111111) = vacant */
  holder: Address;
  provenAt: bigint;
  claimedUntil: bigint;
  lastChallengeAt: bigint;
  /** 0 = no open challenge */
  challengeSlot: bigint;
  challengeDeadline: bigint;
}

/** Erasure-coded payload (docs/blob-protocol.md) */
export interface BlobAccount {
  owner: Address;
  root: Uint8Array;
  state: BlobState;
  needsHolders: boolean;
  bump: number;
  dataShards: number;
  totalShards: number;
  held: number;
  shardSize: bigint;
  payloadSize: bigint;
  epochs: number;
  rewardPerShardEpoch: bigint;
  openedAt: bigint;
  expiresAt: bigint;
  slots: ShardSlot[];
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
  blob: { owner: 8, state: 72, needsHolders: 73 },
} as const;

/** A vacant shard slot's holder */
export const VACANT = '11111111111111111111111111111111' as Address;
export const SLOT_HASHES_ADDRESS = 'SysvarS1otHashes111111111111111111111111111' as Address;
/** Mirrors CHALLENGE_DELAY_SLOTS */
export const CHALLENGE_DELAY_SLOTS = 2n;

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
  blob: (owner: Address, root: Uint8Array, program = PROGRAM_ADDRESS) =>
    pda([text('blob'), addr(owner) as Uint8Array, root], program),
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

/** Seconds after which an unconfirmed direct chunk can be closed (mirrors DIRECT_ABORT_DELAY) */
export const DIRECT_ABORT_DELAY = 600n;

/** Largest direct chunk (mirrors MAX_DIRECT_CHUNK_SIZE) */
export const MAX_DIRECT_CHUNK_SIZE = 16 * 1024 * 1024;

/** A direct chunk's bytes go straight to replicators, never to the ledger */
export const isDirect = (chunk: Pick<ChunkAccount, 'segmentSize'>) => chunk.segmentSize === 0;

/** The owner may close this chunk now (mirrors close_chunk) */
export function isClosable(chunk: ChunkAccount, now: bigint = BigInt(Math.floor(Date.now() / 1000))): boolean {
  return (
    chunk.state === 'Pending' ||
    (isDirect(chunk) && chunk.confirmedReplicas === 0 && now >= chunk.openedAt + DIRECT_ABORT_DELAY) ||
    chunk.confirmedReplicas === chunk.requiredReplicas ||
    now >= chunk.reclaimableAt
  );
}

export interface OpenBlobArgs {
  root: Uint8Array;
  dataShards: number;
  totalShards: number;
  shardSize: bigint;
  payloadSize: bigint;
  epochs: number;
  maxFee: bigint;
}

export interface OpenChunkArgs {
  contentHash: Uint8Array;
  size: number;
  /** Bytes per write_segment; 0 = direct chunk (sent straight to replicators) */
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

    /** `owner` = the chunk's owner: the last confirmation refunds the chunk's rent to it */
    async confirmReplication(authority: TransactionSigner, chunk: Address, owner: Address) {
      return ix(
        [
          signer(authority),
          writable(await pdas.replicator(authority.address, program)),
          writable(chunk),
          readonly(await pdas.config(program)),
          writable(owner),
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

    // ── blobs ──────────────────────────────────────────────────────────────

    async openBlob(owner: TransactionSigner, treasury: Address, args: OpenBlobArgs) {
      return ix(
        [
          signer(owner),
          readonly(await pdas.identity(owner.address, program)),
          readonly(await pdas.config(program)),
          writable(await pdas.blob(owner.address, args.root, program)),
          writable(treasury),
          readonly(SYSTEM_PROGRAM_ADDRESS),
        ],
        encodeInstructionData('openBlob', { args }),
      );
    },

    async confirmShard(authority: TransactionSigner, blob: Address, index: number) {
      return ix(
        [signer(authority, false), writable(await pdas.replicator(authority.address, program)), writable(blob)],
        encodeInstructionData('confirmShard', { index }),
      );
    },

    async createChallenge(challenger: TransactionSigner, blob: Address, index: number) {
      return ix(
        [signer(challenger, false), writable(blob), readonly(await pdas.config(program))],
        encodeInstructionData('createChallenge', { index }),
      );
    },

    proveShard(prover: TransactionSigner, blob: Address, index: number, segment: Uint8Array, shardProof: Uint8Array[], topProof: Uint8Array[]) {
      return ix(
        [signer(prover, false), writable(blob), readonly(SLOT_HASHES_ADDRESS)],
        encodeInstructionData('proveShard', { index, segment, shardProof, topProof }),
      );
    },

    async failChallenge(reporter: TransactionSigner, blob: Address, index: number) {
      return ix(
        [signer(reporter), writable(blob), readonly(await pdas.config(program))],
        encodeInstructionData('failChallenge', { index }),
      );
    },

    async claimShardRewards(holder: TransactionSigner, blob: Address, index: number) {
      return ix(
        [
          signer(holder),
          writable(await pdas.replicator(holder.address, program)),
          writable(blob),
          readonly(await pdas.config(program)),
        ],
        encodeInstructionData('claimShardRewards', { index }),
      );
    },

    async extendBlob(owner: TransactionSigner, blob: Address, treasury: Address, epochs: number, maxFee: bigint) {
      return ix(
        [signer(owner), writable(blob), readonly(await pdas.config(program)), writable(treasury), readonly(SYSTEM_PROGRAM_ADDRESS)],
        encodeInstructionData('extendBlob', { epochs, maxFee }),
      );
    },

    async closeBlob(owner: TransactionSigner, blob: Address) {
      return ix([signer(owner), writable(blob), readonly(await pdas.config(program))], encodeInstructionData('closeBlob'));
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

const MIB = 1_048_576n;

export function quoteChunk(config: Pick<ConfigAccount, 'baseFeePerReplica' | 'pricePerMib'>, size: number, replicas: number): bigint {
  const storage = (BigInt(size) * config.pricePerMib + MIB - 1n) / MIB;
  return BigInt(replicas) * (config.baseFeePerReplica + storage);
}

/** Blob price (mirrors Config::quote_blob) */
export function quoteBlob(
  config: Pick<ConfigAccount, 'baseFeePerReplica' | 'pricePerMibEpoch'>,
  shardSize: bigint,
  totalShards: number,
  epochs: number,
): bigint {
  const storage = (shardSize * config.pricePerMibEpoch * BigInt(epochs) + MIB - 1n) / MIB;
  return BigInt(totalShards) * (config.baseFeePerReplica + storage);
}

/** Protocol share and per-slot, per-epoch reward of a blob fee (mirrors open_blob) */
export function splitBlobFee(config: Pick<ConfigAccount, 'protocolFeeBps'>, fee: bigint, totalShards: number, epochs: number) {
  const slotEpochs = BigInt(totalShards) * BigInt(epochs);
  const protocol = (fee * BigInt(config.protocolFeeBps)) / 10_000n;
  const rewardPerShardEpoch = (fee - protocol) / slotEpochs;
  return { protocolFee: fee - rewardPerShardEpoch * slotEpochs, rewardPerShardEpoch };
}

/** Size of a Blob account (mirrors Blob::space) */
export function blobAccountSize(totalShards: number): number {
  return 8 + 32 * 2 + 6 + 8 * 2 + 4 + 8 * 3 + 4 + 72 * totalShards;
}

/** Reward of one slot over [from, to), prorated per second (mirrors Blob::reward_between) */
export function rewardBetween(blob: Pick<BlobAccount, 'rewardPerShardEpoch'>, epochSeconds: bigint, from: bigint, to: bigint): bigint {
  if (to <= from || epochSeconds <= 0n) return 0n;
  return (blob.rewardPerShardEpoch * (to - from)) / epochSeconds;
}

/** The segment a challenge asks for: sha256(slotHash ‖ blob ‖ [index]) as u64 LE mod segments */
export function challengedSegment(slotHash: Uint8Array, blob: Address, index: number, segments: bigint): bigint {
  const seed = sha256(Uint8Array.from([...slotHash, ...(addr(blob) as Uint8Array), index]));
  return new DataView(seed.buffer, seed.byteOffset, 8).getBigUint64(0, true) % segments;
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
