import {
  Address,
  Commitment,
  getBase58Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  decompileTransactionMessage,
  Rpc,
  Signature,
  SolanaRpcApi,
} from '@solana/kit';
import { decodeInstructionData, hasDiscriminator, instructionDiscriminator, PROGRAM_ADDRESS } from './codec';
import { sha256 } from './crypto';
import { toHex } from './manifest';

/** One `write_segment` found in the ledger */
export interface LedgerSegment {
  index: number;
  data: Uint8Array;
  signature: string;
  slot: bigint;
}

export interface ReadLedgerOptions {
  /** Commitment for history reads (default "confirmed"; replicators use "finalized") */
  commitment?: Commitment;
  /** Parallel getTransaction requests (default 8) */
  concurrency?: number;
  program?: Address;
}

const WRITE_SEGMENT = instructionDiscriminator('writeSegment');

/** Instructions of a wire transaction: top level plus CPI (inner) ones */
function instructionsOf(
  response: any,
): Array<{ program: Address; accounts: Address[]; data: Uint8Array }> {
  const bytes = getBase64Encoder().encode(response.transaction[0]);
  const { messageBytes } = getTransactionDecoder().decode(bytes);
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const out: Array<{ program: Address; accounts: Address[]; data: Uint8Array }> = [];

  try {
    const message = decompileTransactionMessage(compiled as any);
    for (const ix of message.instructions as any[]) {
      out.push({
        program: ix.programAddress,
        accounts: (ix.accounts ?? []).map((a: any) => a.address),
        data: new Uint8Array(ix.data ?? []),
      });
    }
  } catch {
    // v0 messages with lookup tables: fall through to the inner-instruction pass only
  }

  const keys: Address[] = [
    ...((compiled as any).staticAccounts as Address[]),
    ...((response.meta?.loadedAddresses?.writable ?? []) as Address[]),
    ...((response.meta?.loadedAddresses?.readonly ?? []) as Address[]),
  ];
  for (const group of response.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      out.push({
        program: keys[ix.programIdIndex],
        accounts: (ix.accounts ?? []).map((i: number) => keys[i]),
        data: new Uint8Array(getBase58Encoder().encode(ix.data)),
      });
    }
  }
  return out;
}

/**
 * Every successful `write_segment` for `chunk`, read back from the ledger
 * through `getSignaturesForAddress` + `getTransaction`.  The program accepts
 * each index once, so the result is unambiguous.
 */
export async function readSegments(
  rpc: Rpc<SolanaRpcApi>,
  chunk: Address,
  options: ReadLedgerOptions = {},
): Promise<LedgerSegment[]> {
  const commitment = options.commitment ?? 'confirmed';
  const program = options.program ?? PROGRAM_ADDRESS;
  const concurrency = options.concurrency ?? 8;

  const signatures: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(chunk, { limit: 1000, commitment: commitment as 'confirmed' | 'finalized', ...(before ? { before } : {}) })
      .send();
    for (const entry of page) if (entry.err === null) signatures.push({ signature: entry.signature, slot: entry.slot });
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }

  const segments = new Map<number, LedgerSegment>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < signatures.length) {
      const { signature, slot } = signatures[cursor++];
      const response = await rpc
        .getTransaction(signature, {
          encoding: 'base64',
          maxSupportedTransactionVersion: 1,
          commitment: commitment as 'confirmed' | 'finalized',
        } as any)
        .send();
      if (!response || (response as any).meta?.err) continue;
      for (const ix of instructionsOf(response)) {
        if (ix.program !== program || !hasDiscriminator(ix.data, WRITE_SEGMENT) || ix.accounts[1] !== chunk) continue;
        const { index, data } = decodeInstructionData<{ index: number; data: Uint8Array }>('writeSegment', ix.data);
        if (!segments.has(index)) segments.set(index, { index, data, signature, slot });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, signatures.length)) }, worker));
  return [...segments.values()].sort((a, b) => a.index - b.index);
}

/**
 * Rebuild a chunk from its segments and check it against `contentHash`.
 * Every segment but the last has the same length, so the layout follows from
 * the data itself (the chunk account may already be closed).
 */
export function assembleChunk(segments: LedgerSegment[], contentHash: Uint8Array): Uint8Array {
  if (segments.length === 0) throw new Error('No segments found in the ledger');
  segments.forEach((s, i) => {
    if (s.index !== i) throw new Error(`Segment ${i} is missing from the ledger`);
  });
  const total = segments.reduce((n, s) => n + s.data.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of segments) {
    out.set(s.data, offset);
    offset += s.data.length;
  }
  if (toHex(sha256(out)) !== toHex(contentHash)) {
    throw new Error('Chunk rebuilt from the ledger does not match its content hash');
  }
  return out;
}

/** Fetch a chunk straight from the ledger (works while the RPC keeps its history) */
export async function readChunkFromLedger(
  rpc: Rpc<SolanaRpcApi>,
  chunk: Address,
  contentHash: Uint8Array,
  options: ReadLedgerOptions = {},
): Promise<Uint8Array> {
  return assembleChunk(await readSegments(rpc, chunk, options), contentHash);
}
