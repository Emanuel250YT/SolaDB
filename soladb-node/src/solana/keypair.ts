import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createKeyPairSignerFromBytes, KeyPairSigner } from '@solana/kit';

/**
 * Parse a Solana secret key in the solana-keygen format: a JSON array of 64
 * bytes (32-byte seed followed by the 32-byte public key).
 */
export function parseSecretKey(raw: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Replicator secret key is not valid JSON (expected a solana-keygen byte array)');
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length === 64 &&
    parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
  if (!valid) {
    throw new Error('Replicator secret key must be a JSON array of 64 bytes (solana-keygen format)');
  }
  return Uint8Array.from(parsed as number[]);
}

function expandHome(file: string): string {
  return file.startsWith('~/') || file === '~' ? path.join(os.homedir(), file.slice(1)) : file;
}

/**
 * Load the replicator authority.  REPLICATOR_SECRET_KEY (inline byte array)
 * wins over REPLICATOR_KEYPAIR (path to a keypair file); one is required.
 */
export async function loadReplicatorSigner(options: {
  keypairPath?: string;
  secretKey?: string;
}): Promise<KeyPairSigner> {
  if (options.secretKey?.trim()) {
    return createKeyPairSignerFromBytes(parseSecretKey(options.secretKey));
  }
  if (options.keypairPath?.trim()) {
    const file = path.resolve(expandHome(options.keypairPath.trim()));
    if (!fs.existsSync(file)) throw new Error(`REPLICATOR_KEYPAIR ${file} does not exist`);
    return createKeyPairSignerFromBytes(parseSecretKey(fs.readFileSync(file, 'utf8')));
  }
  throw new Error(
    'Set REPLICATOR_KEYPAIR (path to a Solana keypair JSON) or REPLICATOR_SECRET_KEY (its JSON byte array)',
  );
}
