import {
  appendTransactionMessageInstructions,
  Blockhash,
  Commitment,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getSignersFromTransactionMessage,
  getTransactionMessageSize,
  Instruction,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  pipe,
  Rpc,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  setTransactionMessagePriorityFeeLamports,
  Signature,
  SolanaRpcApi,
  Transaction,
  TransactionSigner,
} from '@solana/kit';
import idl from './idl/soladb.json';

export type TxVersion = 0 | 1;

export interface TxOptions {
  /** Transaction format.  v1 allows 4096-byte transactions (SIMD-0296). */
  version?: TxVersion;
  /** Required for v1 (unset means 0 CU).  Optional for v0. */
  computeUnitLimit?: number;
  /** Required for v1 (unset means 0 bytes).  Optional for v0. */
  loadedAccountsDataSizeLimit?: number;
  /** Total priority fee in lamports (converted to a CU price for v0) */
  priorityFeeLamports?: bigint;
}

export interface TxRequest {
  feePayer: TransactionSigner;
  instructions: Instruction[];
  options?: TxOptions;
  /** Free-form label used in errors and progress reports */
  label?: string;
}

export interface TxResult {
  signature: Signature;
  label?: string;
}

export interface SenderOptions {
  /** Commitment a transaction must reach (default "confirmed") */
  commitment?: Commitment;
  /** Give up after this long without the commitment (default 120 s) */
  timeoutMs?: number;
  /** Status poll interval (default 500 ms) */
  pollMs?: number;
  /** Transactions in flight at once (default 8) */
  concurrency?: number;
}

const errorCodes = new Map<number, string>((idl.errors as { code: number; name: string }[]).map((e) => [e.code, e.name]));
export const SOLADB_ERRORS = Object.fromEntries((idl.errors as { code: number; name: string }[]).map((e) => [e.name, e.code])) as Record<
  string,
  number
>;

/** A failed SolaDB transaction, with the program error decoded when there is one */
export class SolaDBTransactionError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly logs: string[] = [],
    readonly signature?: string,
    cause?: unknown,
  ) {
    // keep the RPC / Kit error: production builds shorten Kit messages to a code
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SolaDBTransactionError';
  }

  /** Name of the SolaDB program error (e.g. `SegmentAlreadyWritten`) */
  get programError(): string | undefined {
    return this.code === undefined ? undefined : errorCodes.get(this.code);
  }
}

/** Pull a custom program error code out of RPC errors, statuses or logs */
export function extractErrorCode(value: unknown): number | undefined {
  const seen = new Set<unknown>();
  const visit = (v: unknown): number | undefined => {
    if (v === null || v === undefined || seen.has(v)) return undefined;
    if (typeof v === 'string') {
      const m = /custom program error: 0x([0-9a-f]+)/i.exec(v);
      return m ? parseInt(m[1], 16) : undefined;
    }
    if (typeof v !== 'object') return undefined;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.Custom === 'number' || typeof o.Custom === 'bigint') return Number(o.Custom);
    if (Array.isArray(o.InstructionError)) return visit(o.InstructionError[1]);
    if (typeof o.code === 'number' && 'index' in o && o.code >= 6000) return o.code;
    for (const key of ['context', 'cause', 'logs', 'err', 'data']) {
      const found = visit(o[key]);
      if (found !== undefined) return found;
    }
    if (Array.isArray(v)) for (const item of v) {
      const found = visit(item);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(value);
}

function logsOf(error: unknown): string[] {
  const ctx = (error as { context?: { logs?: unknown } })?.context;
  return Array.isArray(ctx?.logs) ? (ctx!.logs as string[]) : [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds, signs (one signer call per batch, so wallets prompt once), sends and
 * confirms transactions by polling `getSignatureStatuses`.  Expired
 * transactions are rebuilt with a fresh blockhash and sent again.
 */
export class TransactionSender {
  private cachedBlockhash?: { value: { blockhash: Blockhash; lastValidBlockHeight: bigint }; at: number };
  readonly commitment: Commitment;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  readonly concurrency: number;

  constructor(
    readonly rpc: Rpc<SolanaRpcApi>,
    options: SenderOptions = {},
  ) {
    this.commitment = options.commitment ?? 'confirmed';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 500;
    this.concurrency = options.concurrency ?? 8;
  }

  async latestBlockhash(fresh = false) {
    if (!fresh && this.cachedBlockhash && Date.now() - this.cachedBlockhash.at < 15_000) {
      return this.cachedBlockhash.value;
    }
    const { value } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    this.cachedBlockhash = { value, at: Date.now() };
    return value;
  }

  /** Transaction message for `request` (no network access when `blockhash` is given) */
  buildMessage(request: TxRequest, blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
    const options = request.options ?? {};
    const version = options.version ?? 0;
    let message: any = pipe(
      createTransactionMessage({ version }),
      (m) => setTransactionMessageFeePayerSigner(request.feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(request.instructions, m),
    );
    if (options.computeUnitLimit !== undefined) {
      message = setTransactionMessageComputeUnitLimit(options.computeUnitLimit, message);
    }
    if (options.loadedAccountsDataSizeLimit !== undefined) {
      message = setTransactionMessageLoadedAccountsDataSizeLimit(options.loadedAccountsDataSizeLimit, message);
    }
    if (options.priorityFeeLamports && options.priorityFeeLamports > 0n) {
      if (version === 1) {
        message = setTransactionMessagePriorityFeeLamports(options.priorityFeeLamports, message);
      } else {
        const units = BigInt(options.computeUnitLimit ?? 200_000);
        const microLamports = (options.priorityFeeLamports * 1_000_000n) / units;
        message = setTransactionMessageComputeUnitPrice(microLamports, message);
      }
    }
    return message;
  }

  /** Serialized size of `request` in bytes (uses a dummy blockhash) */
  messageSize(request: TxRequest): number {
    const dummy = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };
    return getTransactionMessageSize(this.buildMessage(request, dummy));
  }

  /** Sign many messages, asking each signer once for the whole batch */
  async signAll(messages: any[]): Promise<Transaction[]> {
    const transactions: Transaction[] = messages.map((m) => compileTransaction(m) as Transaction);
    const bySigner = new Map<string, { signer: TransactionSigner; indexes: number[] }>();
    messages.forEach((m, i) => {
      for (const s of getSignersFromTransactionMessage(m) as TransactionSigner[]) {
        const entry = bySigner.get(s.address) ?? { signer: s, indexes: [] };
        entry.indexes.push(i);
        bySigner.set(s.address, entry);
      }
    });
    for (const { signer, indexes } of bySigner.values()) {
      const batch = indexes.map((i) => transactions[i]);
      if (isTransactionPartialSigner(signer)) {
        const dicts = await signer.signTransactions(batch as any);
        indexes.forEach((txIndex, j) => {
          const tx = transactions[txIndex];
          transactions[txIndex] = { ...tx, signatures: { ...tx.signatures, ...dicts[j] } } as Transaction;
        });
      } else if (isTransactionModifyingSigner(signer)) {
        const signed = await signer.modifyAndSignTransactions(batch as any);
        indexes.forEach((txIndex, j) => {
          transactions[txIndex] = signed[j] as Transaction;
        });
      } else {
        throw new Error(`Signer ${signer.address} cannot sign transactions without sending them`);
      }
    }
    return transactions;
  }

  /**
   * Send and confirm every request.  Transactions are sent `concurrency` at a
   * time and confirmed with one `getSignatureStatuses` call per poll (up to
   * 256 signatures), which keeps public RPC rate limits happy.  `isDone(code)`
   * marks program errors that mean the work already happened (e.g. a segment
   * written by an earlier try).
   */
  async sendAll(
    requests: TxRequest[],
    hooks: {
      onConfirmed?: (result: TxResult, index: number) => void;
      isDone?: (code: number | undefined) => boolean;
      maxAttempts?: number;
    } = {},
  ): Promise<TxResult[]> {
    const results: TxResult[] = new Array(requests.length);
    let pending = requests.map((_, i) => i);
    const maxAttempts = hooks.maxAttempts ?? 3;
    const done = (index: number, signature: Signature) => {
      results[index] = { signature, label: requests[index].label };
      hooks.onConfirmed?.(results[index], index);
    };

    for (let attempt = 1; pending.length > 0; attempt++) {
      const blockhash = await this.latestBlockhash(attempt > 1);
      const transactions = await this.signAll(pending.map((i) => this.buildMessage(requests[i], blockhash)));
      const expired: number[] = [];
      const inFlight = new Map<number, { signature: Signature; wire: string }>();

      // 1. send
      let cursor = 0;
      const sendWorker = async () => {
        while (cursor < pending.length) {
          const slot = cursor++;
          const index = pending[slot];
          const tx = transactions[slot] as any;
          const signature = getSignatureFromTransaction(tx);
          const wire = getBase64EncodedWireTransaction(tx);
          const outcome = await this.submit(wire, signature, requests[index].label);
          if (outcome === 'sent') inFlight.set(index, { signature, wire });
          else if (outcome === 'expired') expired.push(index);
          else if (hooks.isDone?.(outcome.code)) done(index, signature);
          else throw outcome;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, sendWorker));

      // 2. confirm (batched statuses), resending what the RPC may have dropped
      const deadline = Date.now() + this.timeoutMs;
      let lastResend = Date.now();
      while (inFlight.size > 0) {
        if (Date.now() > deadline) throw new Error(`${inFlight.size} transaction(s) not confirmed after ${this.timeoutMs} ms`);
        await sleep(this.pollMs);
        const entries = [...inFlight.entries()];
        let unseen = 0;
        for (let i = 0; i < entries.length; i += 256) {
          const batch = entries.slice(i, i + 256);
          const { value } = await this.rpc.getSignatureStatuses(batch.map(([, e]) => e.signature)).send();
          batch.forEach(([index, entry], j) => {
            const status = value[j];
            if (!status) {
              unseen++;
              return;
            }
            if (status.err) {
              const code = extractErrorCode(status.err);
              if (hooks.isDone?.(code)) {
                inFlight.delete(index);
                done(index, entry.signature);
                return;
              }
              const label = requests[index].label;
              const what = label ? `${label} (${entry.signature})` : entry.signature;
              const reason = code !== undefined ? ` (${errorCodes.get(code) ?? 'error ' + code})` : '';
              throw new SolaDBTransactionError(`${what} failed${reason}: ${JSON.stringify(status.err, jsonBigint)}`, code, [], entry.signature);
            }
            if (reachedCommitment(status.confirmationStatus, this.commitment)) {
              inFlight.delete(index);
              done(index, entry.signature);
            }
          });
        }
        if (unseen === 0) continue;
        const height = await this.rpc.getBlockHeight({ commitment: 'confirmed' }).send();
        if (height > blockhash.lastValidBlockHeight) {
          // a last look: anything still unseen after expiry never landed
          const left = [...inFlight.entries()];
          const { value } = await this.rpc.getSignatureStatuses(left.map(([, e]) => e.signature)).send();
          left.forEach(([index], j) => {
            if (!value[j]) {
              inFlight.delete(index);
              expired.push(index);
            }
          });
          continue;
        }
        if (Date.now() - lastResend > 2_000) {
          // RPC nodes drop transactions under load; resending the same bytes is idempotent
          lastResend = Date.now();
          for (const { wire } of inFlight.values()) {
            await this.rpc.sendTransaction(wire as any, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send().catch(() => undefined);
          }
        }
      }

      pending = expired;
      if (pending.length > 0 && attempt >= maxAttempts) {
        throw new Error(`${pending.length} transaction(s) expired ${maxAttempts} times without confirming`);
      }
    }
    return results;
  }

  /** Convenience for a single request */
  async send(request: TxRequest, isDone?: (code: number | undefined) => boolean): Promise<Signature> {
    const [result] = await this.sendAll([request], { isDone });
    return result.signature;
  }

  /** sendTransaction with preflight; classifies the immediate outcome */
  private async submit(wire: string, signature: Signature, label?: string): Promise<'sent' | 'expired' | SolaDBTransactionError> {
    try {
      await this.rpc
        .sendTransaction(wire as any, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0n })
        .send();
      return 'sent';
    } catch (err) {
      const text = `${(err as Error).message} ${JSON.stringify((err as any)?.context ?? {}, jsonBigint)}`;
      if (/blockhash not found|BlockhashNotFound/i.test(text)) return 'expired';
      // already landed (e.g. a resend of a confirmed transaction)
      if (/AlreadyProcessed|already been processed/i.test(text)) return 'sent';
      const code = extractErrorCode(err);
      const what = label ? `${label} (${signature})` : signature;
      const reason = code !== undefined ? ` (${errorCodes.get(code) ?? 'error ' + code})` : '';
      return new SolaDBTransactionError(`${what} failed${reason}: ${(err as Error).message}`, code, logsOf(err), signature, err);
    }
  }
}

const jsonBigint = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

function reachedCommitment(status: string | null | undefined, target: Commitment): boolean {
  const rank = { processed: 0, confirmed: 1, finalized: 2 } as Record<string, number>;
  return status != null && rank[status] >= rank[target];
}
