import {
  addCodecSizePrefix,
  Address,
  Codec,
  fixCodecSize,
  getAddressCodec,
  getArrayCodec,
  getBooleanCodec,
  getBytesCodec,
  getI64Codec,
  getStructCodec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  getUtf8Codec,
  transformCodec,
} from '@solana/kit';
import idl from './idl/soladb.json';

/**
 * Borsh codecs built from the program's Anchor IDL (`idl/soladb.json`), so the
 * SDK always matches the deployed layout.  Field names are camelCased.
 */

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

interface IdlField {
  name: string;
  type: IdlType;
}

interface IdlTypeDef {
  name: string;
  type: { kind: 'struct'; fields: IdlField[] } | { kind: 'enum'; variants: { name: string }[] };
}

const types = new Map<string, IdlTypeDef>((idl.types as IdlTypeDef[]).map((t) => [t.name, t]));
const cache = new Map<string, Codec<any>>();

export const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function codecFor(type: IdlType): Codec<any> {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8':
        return getU8Codec();
      case 'u16':
        return getU16Codec();
      case 'u32':
        return getU32Codec();
      case 'u64':
        return getU64Codec();
      case 'i64':
        return getI64Codec();
      case 'bool':
        return getBooleanCodec();
      case 'pubkey':
        return getAddressCodec();
      case 'string':
        return addCodecSizePrefix(getUtf8Codec(), getU32Codec());
      case 'bytes':
        return bytesCodec;
      default:
        throw new Error(`Unsupported IDL type ${type}`);
    }
  }
  if ('array' in type) {
    const [inner, size] = type.array;
    if (inner === 'u8') return fixCodecSize(getBytesCodec(), size);
    return getArrayCodec(codecFor(inner), { size });
  }
  if ('vec' in type) return getArrayCodec(codecFor(type.vec));
  if ('defined' in type) return definedCodec(type.defined.name);
  throw new Error(`Unsupported IDL type ${JSON.stringify(type)}`);
}

/** `Vec<u8>` as a u32-prefixed byte string, decoded to a plain Uint8Array */
const bytesCodec: Codec<Uint8Array> = transformCodec(
  addCodecSizePrefix(getBytesCodec(), getU32Codec()),
  (value: Uint8Array) => value,
  (value) => new Uint8Array(value),
);

export function definedCodec(name: string): Codec<any> {
  const hit = cache.get(name);
  if (hit) return hit;
  const def = types.get(name);
  if (!def) throw new Error(`IDL type ${name} not found`);
  let codec: Codec<any>;
  if (def.type.kind === 'struct') {
    codec = getStructCodec(def.type.fields.map((f) => [camel(f.name), codecFor(f.type)] as const) as any);
  } else {
    const variants = def.type.variants.map((v) => v.name);
    codec = transformCodec(
      getU8Codec(),
      (variant: string) => {
        const index = variants.indexOf(variant);
        if (index < 0) throw new Error(`Unknown ${name} variant ${variant}`);
        return index;
      },
      (index: number) => variants[index],
    );
  }
  cache.set(name, codec);
  return codec;
}

// ── Instructions ─────────────────────────────────────────────────────────────

interface IdlInstruction {
  name: string;
  discriminator: number[];
  args: IdlField[];
}

const instructions = new Map<string, IdlInstruction>(
  (idl.instructions as IdlInstruction[]).map((ix) => [camel(ix.name), ix]),
);

export type InstructionName =
  | 'initialize'
  | 'updateConfig'
  | 'transferAdmin'
  | 'registerReplicator'
  | 'setReplicatorActive'
  | 'updateReplicatorEndpoint'
  | 'registerIdentity'
  | 'updateIdentity'
  | 'openChunk'
  | 'writeSegment'
  | 'confirmReplication'
  | 'reclaimUnreplicated'
  | 'closeChunk'
  | 'openBlob'
  | 'confirmShard'
  | 'createChallenge'
  | 'proveShard'
  | 'failChallenge'
  | 'claimShardRewards'
  | 'extendBlob'
  | 'closeBlob'
  | 'createRecord'
  | 'updateRecord'
  | 'deleteRecord'
  | 'grantAccess'
  | 'updateGrant'
  | 'revokeAccess';

export function instructionDiscriminator(name: InstructionName): Uint8Array {
  const ix = instructions.get(name);
  if (!ix) throw new Error(`Instruction ${name} not in IDL`);
  return Uint8Array.from(ix.discriminator);
}

/** Discriminator + Borsh-encoded arguments of an instruction */
export function encodeInstructionData(name: InstructionName, args: Record<string, unknown> = {}): Uint8Array {
  const ix = instructions.get(name)!;
  const parts: Uint8Array[] = [Uint8Array.from(ix.discriminator)];
  for (const arg of ix.args) {
    const value = args[camel(arg.name)];
    if (value === undefined) throw new Error(`${name}: missing argument ${camel(arg.name)}`);
    parts.push(new Uint8Array(codecFor(arg.type).encode(value)));
  }
  return concat(parts);
}

/** Decode the arguments of an instruction (data includes the discriminator) */
export function decodeInstructionData<T = Record<string, unknown>>(name: InstructionName, data: Uint8Array): T {
  const ix = instructions.get(name)!;
  let offset = 8;
  const out: Record<string, unknown> = {};
  for (const arg of ix.args) {
    const [value, next] = codecFor(arg.type).read(data, offset);
    out[camel(arg.name)] = value;
    offset = next;
  }
  return out as T;
}

export function hasDiscriminator(data: Uint8Array, discriminator: Uint8Array): boolean {
  if (data.length < discriminator.length) return false;
  for (let i = 0; i < discriminator.length; i++) if (data[i] !== discriminator[i]) return false;
  return true;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type AccountName = 'Config' | 'Identity' | 'Replicator' | 'Chunk' | 'Blob' | 'Record' | 'Grant';

const accountDiscriminators = new Map<string, Uint8Array>(
  (idl.accounts as { name: string; discriminator: number[] }[]).map((a) => [a.name, Uint8Array.from(a.discriminator)]),
);

export function accountDiscriminator(name: AccountName): Uint8Array {
  return accountDiscriminators.get(name)!;
}

export function decodeAccount<T>(name: AccountName, data: Uint8Array): T {
  if (!hasDiscriminator(data, accountDiscriminator(name))) {
    throw new Error(`Account data is not a SolaDB ${name}`);
  }
  return definedCodec(name).decode(data.subarray(8)) as T;
}

export const PROGRAM_ADDRESS = idl.address as Address;

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
