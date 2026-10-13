import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Address, generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import {
  SolaDBClient,
  assembleChunk,
  chunkAccountSize,
  decodeAccount,
  decodeInstructionData,
  decodeManifest,
  definedCodec,
  encodeInstructionData,
  encodeManifest,
  encryptBytes,
  decryptBytes,
  FileManifest,
  instructionDiscriminator,
  keyPairFromSecret,
  open,
  quoteChunk,
  randomKey,
  seal,
  sha256,
  splitFee,
  extractErrorCode,
  SOLADB_ERRORS,
  createSolaDBRpc,
  ChunkAccount,
  DIRECT_ABORT_DELAY,
  gunzip,
  isClosable,
  isDirect,
  maybeCompress,
} from '../src';
import idl from '../src/idl/soladb.json';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

test('instruction discriminators come from the IDL', () => {
  const fromIdl = (idl.instructions as { name: string; discriminator: number[] }[]).find((i) => i.name === 'write_segment')!;
  assert.deepEqual([...instructionDiscriminator('writeSegment')], fromIdl.discriminator);
});

test('open_chunk args encode as Borsh in declaration order', async () => {
  const writer = (await generateKeyPairSigner()).address;
  const contentHash = bytes(32);
  const data = encodeInstructionData('openChunk', {
    args: { contentHash, size: 1000, segmentSize: 900, replicas: 3, writer, maxFee: 66_000n },
  });
  // 8 discriminator + 32 hash + 4 size + 2 segment + 1 replicas + 32 writer + 8 max_fee
  assert.equal(data.length, 87);
  const view = new DataView(data.buffer);
  assert.deepEqual(data.subarray(8, 40), contentHash);
  assert.equal(view.getUint32(40, true), 1000);
  assert.equal(view.getUint16(44, true), 900);
  assert.equal(data[46], 3);
  assert.deepEqual(data.subarray(47, 79), new Uint8Array(getAddressEncoder().encode(writer)));
  assert.equal(view.getBigUint64(79, true), 66_000n);
});

test('write_segment round-trips', () => {
  const payload = bytes(3000);
  const data = encodeInstructionData('writeSegment', { index: 7, data: payload });
  assert.equal(data.length, 8 + 4 + 4 + 3000);
  const decoded = decodeInstructionData<{ index: number; data: Uint8Array }>('writeSegment', data);
  assert.equal(decoded.index, 7);
  assert.deepEqual(decoded.data, payload);
});

test('Chunk accounts decode with the documented offsets', async () => {
  const owner = (await generateKeyPairSigner()).address;
  const writer = (await generateKeyPairSigner()).address;
  const chunk = {
    owner,
    contentHash: bytes(32, 9),
    writer,
    state: 'Hot',
    needsReplicas: true,
    reclaimed: false,
    bump: 254,
    requiredReplicas: 3,
    confirmedReplicas: 1,
    segmentSize: 3_800,
    segmentsTotal: 70,
    segmentsWritten: 70,
    size: 262_172,
    rewardPerReplica: 19_800n,
    openedAt: 1_760_000_000n,
    completedAt: 1_760_000_010n,
    reclaimableAt: 1_760_604_800n,
    segments: new Uint8Array(9).fill(0xff),
    replicators: [owner],
  };
  const body = new Uint8Array(definedCodec('Chunk').encode(chunk));
  const discriminator = (idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === 'Chunk')!.discriminator;
  const data = new Uint8Array([...discriminator, ...body]);
  assert.equal(data[104], 1, 'state at offset 104');
  assert.equal(data[105], 1, 'needs_replicas at offset 105');
  const decoded = decodeAccount<typeof chunk>('Chunk', data);
  assert.equal(decoded.state, 'Hot');
  assert.equal(decoded.replicators[0], owner);
  assert.equal(decoded.rewardPerReplica, 19_800n);
  // a full account is allocated for every replica up front
  assert.equal(chunkAccountSize(70, 3), data.length + 64);
});

test('fee split matches the program', () => {
  // 2 lamports per byte, expressed per MiB
  const config = { baseFeePerReplica: 20_000n, pricePerMib: 2_097_152n, protocolFeeBps: 1_000 };
  const fee = quoteChunk(config, 1_000, 3);
  assert.equal(fee, 66_000n);
  // pro rata per MiB, rounded up to the lamport (mirrors Config::quote)
  const cheap = { baseFeePerReplica: 7_000n, pricePerMib: 20_000n };
  assert.equal(quoteChunk(cheap, 1, 1), 7_001n);
  assert.equal(quoteChunk(cheap, 1_048_576, 2), 54_000n);
  assert.equal(quoteChunk(cheap, 524_288, 1), 17_000n);
  assert.deepEqual(splitFee(config, fee, 3), { protocolFee: 6_600n, rewardPerReplica: 19_800n });
  // rounding dust goes to the protocol
  assert.deepEqual(splitFee(config, 100_001n, 3), { protocolFee: 10_001n, rewardPerReplica: 30_000n });
});

test('manifest binary encoding round-trips (inline and index)', () => {
  const base: FileManifest = {
    v: 2,
    name: 'informe-2026.pdf',
    mime: 'application/pdf',
    size: 1_234_567,
    chunkSize: 262_144,
    sha256: bytes(32, 2),
    dek: bytes(32, 3),
    createdAt: 1_760_000_000,
    chunkCount: 5,
    chunks: [1, 2, 3, 4, 5].map((s) => bytes(32, s)),
  };
  assert.deepEqual(decodeManifest(encodeManifest(base)), base);
  const flagged: FileManifest = { ...base, direct: true, compression: 'gzip' };
  assert.deepEqual(decodeManifest(encodeManifest(flagged)), flagged);
  const indexed = { ...base, chunkCount: 40, chunks: [], index: bytes(32, 7) };
  const decoded = decodeManifest(encodeManifest(indexed));
  assert.equal(decoded.chunkCount, 40);
  assert.deepEqual(decoded.index, indexed.index);
  assert.deepEqual(decoded.chunks, []);
});

test('manifest names are truncated to fit', () => {
  const m = decodeManifest(
    encodeManifest({
      v: 2, name: 'á'.repeat(300), mime: 'x', size: 1, chunkSize: 1, sha256: bytes(32), dek: bytes(32),
      createdAt: 1, chunkCount: 1, chunks: [bytes(32)],
    }),
  );
  assert.ok(new TextEncoder().encode(m.name).length <= 200);
});

test('seal / open and chunk encryption', () => {
  const alice = keyPairFromSecret(bytes(32, 5));
  const bob = keyPairFromSecret(bytes(32, 6));
  const message = new TextEncoder().encode('manifest');
  assert.deepEqual(open(alice, seal(alice.publicKey, message)), message);
  assert.throws(() => open(bob, seal(alice.publicKey, message)));

  const dek = randomKey();
  const plain = bytes(5000);
  assert.deepEqual(decryptBytes(dek, encryptBytes(dek, plain)), plain);
});

test('ledger segments reassemble and are verified', () => {
  const data = bytes(10_000);
  const segments = [0, 1, 2].map((index) => ({
    index,
    data: data.subarray(index * 3800, (index + 1) * 3800),
    signature: `sig${index}`,
    slot: 1n,
  }));
  assert.deepEqual(assembleChunk(segments, sha256(data)), data);
  assert.throws(() => assembleChunk(segments.slice(1), sha256(data)), /missing/);
  assert.throws(() => assembleChunk(segments, sha256(bytes(10))), /content hash/);
});

test('program error codes are extracted from RPC errors and statuses', () => {
  const code = SOLADB_ERRORS.SegmentAlreadyWritten;
  assert.equal(extractErrorCode({ InstructionError: [0, { Custom: code }] }), code);
  assert.equal(extractErrorCode({ context: { logs: [`Program x failed: custom program error: 0x${code.toString(16)}`] } }), code);
});

test('segment size fills the transaction', async () => {
  const signer = await generateKeyPairSigner();
  const client = new SolaDBClient({ rpc: 'http://127.0.0.1:1', signer, signMessage: async () => new Uint8Array(64) });
  const v0 = await client.segmentSize(0);
  assert.ok(v0 > 900 && v0 < 1232, `v0 segment ${v0}`);
  // v1 needs the program size from the RPC: stub it
  (client as any).loadedDataLimit = 524_288;
  const v1 = await client.segmentSize(1);
  assert.ok(v1 > 3_800 && v1 < 4_096, `v1 segment ${v1}`);
  console.log(`segment sizes: v0 ${v0} bytes, v1 ${v1} bytes`);
});

test('addresses in fixtures are valid', async () => {
  const a: Address = (await generateKeyPairSigner()).address;
  assert.equal(typeof a, 'string');
});

test('the RPC client backs off and retries rate-limited requests', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(429);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      const { id } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 123 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const rpc = createSolaDBRpc(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { baseDelayMs: 5 });
    assert.equal(await rpc.getSlot().send(), 123n);
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test('gzip is only kept when it saves at least 10 %', async () => {
  const text = new TextEncoder().encode('fecha,monto,concepto\n'.repeat(5_000));
  const packed = await maybeCompress(text);
  assert.ok(packed && packed.length < text.length / 10);
  assert.deepEqual(await gunzip(packed), text);
  const noise = crypto.getRandomValues(new Uint8Array(4_096));
  assert.equal(await maybeCompress(noise), null, 'incompressible data is sent as it is');
  assert.equal(await maybeCompress(new Uint8Array(100)), null, 'tiny files are not worth it');
});

test('direct chunks: closable after the abort delay without confirmations', () => {
  const base = {
    state: 'Hot',
    segmentSize: 0,
    confirmedReplicas: 0,
    requiredReplicas: 2,
    openedAt: 1_000n,
    reclaimableAt: 1_000n + 604_800n,
  } as unknown as ChunkAccount;
  assert.equal(isDirect(base), true);
  assert.equal(isClosable(base, 1_000n + DIRECT_ABORT_DELAY - 1n), false);
  assert.equal(isClosable(base, 1_000n + DIRECT_ABORT_DELAY), true);
  assert.equal(isClosable({ ...base, confirmedReplicas: 1 }, 1_000n + DIRECT_ABORT_DELAY), false);
  assert.equal(isClosable({ ...base, segmentSize: 3_864 }, 1_000n + DIRECT_ABORT_DELAY), false);
});
