/**
 * gzip with the platform's CompressionStream (browsers, Node ≥ 18): no
 * dependency.  Files are compressed before encryption, since ciphertext does
 * not compress; text, JSON or CSV often shrink 3–10×, while PDFs, images
 * and archives are kept as they are.
 */

export const canCompress = () => typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream('gzip'));

/** Smallest saving worth keeping the compressed copy for */
const MIN_SAVING = 0.1;
/** Above this the whole file would be held twice in memory: sent as it is */
const MAX_COMPRESS_BYTES = 256 * 1024 * 1024;

/** The gzip copy when it saves at least 10 %, else null */
export async function maybeCompress(data: Uint8Array): Promise<Uint8Array | null> {
  if (!canCompress() || data.length < 512 || data.length > MAX_COMPRESS_BYTES) return null;
  const compressed = await gzip(data);
  return compressed.length <= data.length * (1 - MIN_SAVING) ? compressed : null;
}
