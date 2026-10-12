import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from '@solana/kit';

// ── Numbers and addresses ───────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;

export function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function sol(lamports: bigint): string {
  const value = Number(lamports) / LAMPORTS_PER_SOL;
  return `${value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 6 : 4)} SOL`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ── Downloads ───────────────────────────────────────────────────────────────

/** Control and bidi-override characters (these let "gpj.exe" show as "exe.jpg") */
const INVISIBLE = /[\x00-\x1f\x7f‎‏‪-‮⁦-⁩]/g;

/** A manifest name for display (always rendered with textContent) */
export function displayName(name: string): string {
  return name.replace(INVISIBLE, '').trim().slice(0, 200) || 'Untitled file';
}

/**
 * The name in a manifest is chosen by whoever shared the file: keep only the
 * last path segment, drop invisible characters and never return "." or "..".
 */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(INVISIBLE, '').trim();
  return !clean || clean === '.' || clean === '..' ? 'soladb-download' : clean.slice(0, 200);
}

/** A plain type/subtype MIME, or application/octet-stream */
export function safeMime(mime: string): string {
  return /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(mime) ? mime : 'application/octet-stream';
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Wallets report a rejected prompt with EIP-1193's 4001, Wallet Standard's 4001000 or just words */
export function isRejection(err: unknown): boolean {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 4; depth++) {
    if (e.code === 4001 || e.code === 4001000) return true;
    if (typeof e.message === 'string' && /user rejected|rejected the request|request rejected|approval denied|user denied|declined|cancell?ed by (the )?user/i.test(e.message)) {
      return true;
    }
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * A sentence for a toast.  Kit strips its own messages in production builds
 * ("Solana error #-32002; Decode this error by running …"), so the common
 * codes are spelled out here.
 */
export function errorMessage(err: unknown): string {
  if (isRejection(err)) return 'You rejected the request in your wallet.';
  if (isSolanaError(err)) {
    const context = err.context as Record<string, unknown>;
    if (typeof context.__serverMessage === 'string') return context.__serverMessage;
    if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
      const status = err.context.statusCode;
      return `The RPC answered HTTP ${status}${status === 429 ? ' (rate limited; try again in a minute)' : ''}.`;
    }
  }
  const e = err as { message?: unknown; logs?: unknown };
  const logs = Array.isArray(e?.logs) ? (e.logs as unknown[]).map(String) : [];
  if (logs.some((line) => /insufficient lamports|insufficient funds/i.test(line))) {
    return 'Not enough SOL in this wallet for this transaction.';
  }
  const text = typeof e?.message === 'string' ? e.message : String(err);
  return text
    .replace(/Solana error #-32002; Decode this error by running `[^`]*`/g, 'the transaction failed in simulation')
    .replace(/Solana error #(-?\d+); Decode this error by running `[^`]*`/g, 'Solana error $1 (npx @solana/errors decode -- $1)');
}
