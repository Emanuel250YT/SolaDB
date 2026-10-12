import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Message the wallet signs to derive the SolaDB encryption key.  Ed25519
 * signatures are deterministic (RFC 8032), so the same wallet always gets the
 * same key and no extra secret has to be stored.  Only sign it inside an
 * SolaDB app: whoever gets this signature can decrypt your files.
 */
export const KEY_DERIVATION_MESSAGE =
  'SolaDB encryption key v1 (Solana)\n\n' +
  'Signing this message derives your SolaDB encryption key. ' +
  'It costs nothing and sends no transaction. Only sign it inside a SolaDB app.';

const SEAL_VERSION = 1;
const SEAL_INFO = utf8ToBytes('soladb/seal/v1');
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptionKeyPair {
  /** X25519 secret key (32 bytes) */
  secretKey: Uint8Array;
  /** X25519 public key (32 bytes), the value published in the Identity account */
  publicKey: Uint8Array;
}

/** Anything that can sign raw bytes with the wallet's ed25519 key */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

/** Derive the wallet's X25519 key pair from its signature of KEY_DERIVATION_MESSAGE */
export async function deriveEncryptionKeyPair(signMessage: SignMessage): Promise<EncryptionKeyPair> {
  const signature = await signMessage(utf8ToBytes(KEY_DERIVATION_MESSAGE));
  if (signature.length !== 64) throw new Error('Expected a 64-byte ed25519 signature');
  return keyPairFromSecret(sha256(signature));
}

export function keyPairFromSecret(secretKey: Uint8Array): EncryptionKeyPair {
  if (secretKey.length !== KEY_BYTES) throw new Error('X25519 secret keys are 32 bytes');
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function sealKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephemeralPublic, recipientPublic), SEAL_INFO, KEY_BYTES);
}

/**
 * Encrypt `plaintext` for the owner of `recipientPublicKey` (X25519 + HKDF-SHA256
 * + AES-256-GCM with an ephemeral sender key).
 *
 * Layout: version (1) | ephemeral public key (32) | nonce (12) | ciphertext + tag
 */
export function seal(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== KEY_BYTES) {
    throw new Error('SolaDB encryption keys are 32-byte X25519 public keys');
  }
  const ephemeralSecret = randomBytes(KEY_BYTES);
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, recipientPublicKey);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = gcm(sealKey(shared, ephemeralPublic, recipientPublicKey), nonce).encrypt(plaintext);
  return concatBytes(Uint8Array.of(SEAL_VERSION), ephemeralPublic, nonce, ciphertext);
}

/** Bytes added by `seal` */
export const SEAL_OVERHEAD = 1 + KEY_BYTES + NONCE_BYTES + 16;

/** Decrypt a value produced by `seal` for `keys.publicKey` */
export function open(keys: EncryptionKeyPair, sealed: Uint8Array): Uint8Array {
  if (sealed.length < SEAL_OVERHEAD || sealed[0] !== SEAL_VERSION) {
    throw new Error('Not a SolaDB sealed payload');
  }
  const ephemeralPublic = sealed.subarray(1, 1 + KEY_BYTES);
  const nonce = sealed.subarray(1 + KEY_BYTES, 1 + KEY_BYTES + NONCE_BYTES);
  const ciphertext = sealed.subarray(1 + KEY_BYTES + NONCE_BYTES);
  const shared = x25519.getSharedSecret(keys.secretKey, ephemeralPublic);
  return gcm(sealKey(shared, ephemeralPublic, keys.publicKey), nonce).decrypt(ciphertext);
}

/** Fresh random 32-byte data-encryption key */
export function randomKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/** AES-256-GCM with a random nonce. Layout: nonce (12) | ciphertext + tag */
export function encryptBytes(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  return concatBytes(nonce, gcm(key, nonce).encrypt(plaintext));
}

export function decryptBytes(key: Uint8Array, data: Uint8Array): Uint8Array {
  return gcm(key, data.subarray(0, NONCE_BYTES)).decrypt(data.subarray(NONCE_BYTES));
}

/** Bytes added by encryptBytes */
export const ENCRYPTION_OVERHEAD = NONCE_BYTES + 16;

export { sha256 };
