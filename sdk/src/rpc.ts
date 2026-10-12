import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  Rpc,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaRpcApi,
} from '@solana/kit';

export interface RpcOptions {
  /** Retries for HTTP 429 / 5xx / network errors (default 6) */
  maxRetries?: number;
  /** First backoff delay; doubles each retry up to 8 s (default 300 ms) */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(err: unknown): boolean {
  if (isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = (err.context as { statusCode: number }).statusCode;
    return status === 429 || status >= 500;
  }
  // fetch() network failures surface as TypeError
  return err instanceof TypeError;
}

/**
 * Solana RPC client that backs off and retries when the endpoint rate limits
 * (public RPCs answer 429 quickly) or blips.  JSON-RPC errors are not retried.
 */
export function createSolaDBRpc(url: string, options: RpcOptions = {}): Rpc<SolanaRpcApi> {
  const maxRetries = options.maxRetries ?? 6;
  const baseDelay = options.baseDelayMs ?? 300;
  const transport = createDefaultRpcTransport({ url });
  const retrying = (async (config: Parameters<typeof transport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (err) {
        if (attempt >= maxRetries || !retryable(err)) throw err;
        await sleep(Math.min(baseDelay * 2 ** attempt, 8_000) * (0.75 + Math.random() / 2));
      }
    }
  }) as typeof transport;
  return createSolanaRpcFromTransport(retrying) as Rpc<SolanaRpcApi>;
}
