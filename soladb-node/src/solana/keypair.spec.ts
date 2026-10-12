import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPairSync } from 'crypto';
import { loadReplicatorSigner, parseSecretKey } from './keypair';

function keypairJson(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return JSON.stringify([...seed, ...pub]);
}

describe('replicator keypair', () => {
  let dir: string;

  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soladb-key-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('parses solana-keygen byte arrays and rejects anything else', () => {
    expect(parseSecretKey(keypairJson())).toHaveLength(64);
    expect(() => parseSecretKey('not json')).toThrow('not valid JSON');
    expect(() => parseSecretKey('[1,2,3]')).toThrow('64 bytes');
    expect(() => parseSecretKey(JSON.stringify(Array(64).fill(256)))).toThrow('64 bytes');
  });

  it('loads REPLICATOR_KEYPAIR files and REPLICATOR_SECRET_KEY (which wins)', async () => {
    const fileKey = keypairJson();
    const inlineKey = keypairJson();
    const file = path.join(dir, 'replicator.json');
    fs.writeFileSync(file, fileKey);

    const fromFile = await loadReplicatorSigner({ keypairPath: file });
    const fromInline = await loadReplicatorSigner({ secretKey: inlineKey, keypairPath: file });
    expect(fromFile.address).not.toBe(fromInline.address);
    expect((await loadReplicatorSigner({ secretKey: inlineKey })).address).toBe(fromInline.address);
  });

  it('fails clearly without a key or with a missing file', async () => {
    await expect(loadReplicatorSigner({})).rejects.toThrow('REPLICATOR_KEYPAIR');
    await expect(loadReplicatorSigner({ keypairPath: path.join(dir, 'nope.json') })).rejects.toThrow('does not exist');
    // a keypair whose public half does not match its seed
    const tampered = JSON.parse(keypairJson());
    tampered[40] ^= 1;
    await expect(loadReplicatorSigner({ secretKey: JSON.stringify(tampered) })).rejects.toThrow();
  });
});
