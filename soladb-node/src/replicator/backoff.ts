/**
 * Why a chunk could not be replicated:
 *   invalid    — the ledger bytes do not hash to the chunk's content hash
 *                (buggy or malicious uploader); permanent, retried rarely
 *   incomplete — a segment is missing from the RPC's history
 *   error      — anything else (RPC, storage, transaction)
 */
export type FailureKind = 'invalid' | 'incomplete' | 'error';

export interface BackoffPolicy {
  /** Skip a chunk with invalid ledger data for this long */
  invalidMs: number;
  /** First retry after an `incomplete` / `error` failure; doubles each time */
  baseMs: number;
  /** Retry delay cap */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  invalidMs: 60 * 60_000,
  baseMs: 10_000,
  maxMs: 10 * 60_000,
};

export interface BackoffEntry {
  kind: FailureKind;
  /** Consecutive failures */
  attempts: number;
  /** Epoch ms of the next attempt */
  retryAt: number;
  error: string;
}

export interface BackoffSummary {
  invalid: number;
  incomplete: number;
  error: number;
  /** Up to 20 entries, soonest retry first */
  chunks: Array<{ chunk: string; kind: FailureKind; attempts: number; retryAt: string; error: string }>;
}

export function classifyFailure(err: unknown): FailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (/does not match its content hash/i.test(message)) return 'invalid';
  if (/Segment \d+ is missing|No segments found/i.test(message)) return 'incomplete';
  return 'error';
}

/**
 * Per-chunk retry schedule.  A chunk that keeps failing is not rebuilt from
 * the ledger on every poll: invalid data waits `invalidMs`, other failures
 * back off exponentially from `baseMs` to `maxMs`.
 */
export class ChunkBackoff {
  private readonly entries = new Map<string, BackoffEntry>();

  constructor(private readonly policy: BackoffPolicy = DEFAULT_BACKOFF) { }

  /** Record a failure and schedule the next attempt */
  fail(chunk: string, err: unknown, now = Date.now()): BackoffEntry {
    const kind = classifyFailure(err);
    const attempts = (this.entries.get(chunk)?.attempts ?? 0) + 1;
    const delay =
      kind === 'invalid'
        ? this.policy.invalidMs
        : Math.min(this.policy.baseMs * 2 ** (attempts - 1), this.policy.maxMs);
    const entry: BackoffEntry = {
      kind,
      attempts,
      retryAt: now + delay,
      error: err instanceof Error ? err.message : String(err),
    };
    this.entries.set(chunk, entry);
    return entry;
  }

  /** true while the chunk must not be retried */
  isBlocked(chunk: string, now = Date.now()): boolean {
    const entry = this.entries.get(chunk);
    return entry !== undefined && entry.retryAt > now;
  }

  get(chunk: string): BackoffEntry | undefined {
    return this.entries.get(chunk);
  }

  clear(chunk: string): void {
    this.entries.delete(chunk);
  }

  /** Forget chunks that no longer need replicas */
  retain(present: Set<string>): void {
    for (const chunk of this.entries.keys()) {
      if (!present.has(chunk)) this.entries.delete(chunk);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  summary(): BackoffSummary {
    const out: BackoffSummary = { invalid: 0, incomplete: 0, error: 0, chunks: [] };
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].retryAt - b[1].retryAt);
    for (const [chunk, entry] of sorted) {
      out[entry.kind]++;
      if (out.chunks.length < 20) {
        out.chunks.push({
          chunk,
          kind: entry.kind,
          attempts: entry.attempts,
          retryAt: new Date(entry.retryAt).toISOString(),
          error: entry.error,
        });
      }
    }
    return out;
  }
}
