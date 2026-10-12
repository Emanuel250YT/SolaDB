<p align="center">
  <img src="docs/banner.svg" alt="SolaDB — private, replicated file storage on Solana" width="100%">
</p>

# SolaDB

> **SolaDB** is private, replicated file storage built on [Solana](https://solana.com).
> Files are encrypted in the user's browser, written to the Solana ledger in
> 4 KiB transactions, and kept by replicator nodes that get paid for every copy
> they confirm. While a chunk waits in the ledger it is **Hot**; once enough
> replicators confirm it, it is **Cool**.

| Component | Purpose |
| --- | --- |
| `programs/soladb` | Anchor 1.2 program `SoLA2LWHLmxARYxNKqtUaKMyttMwZ7WwnSHEgf47vu2`. Three modules in one program: **identity** (the X25519 key others seal data to), **storage** (chunks, segments, replication and its economics) and **records** (sealed file manifests and per-reader grants). |
| `soladb-node` | NestJS replicator: finds chunks that need replicas, rebuilds them from the ledger, checks their sha256, stores them (RocksDB + Oracle), confirms on-chain (and is paid on the spot), serves data over HTTP. |
| `sdk/` (`@soladb/sdk`) | TypeScript SDK and `soladb` CLI on `@solana/kit` 8: wallet-derived keys, end-to-end encryption, upload with a session key and v1 transactions, download (replicators or the ledger), share, revoke, reclaim rent. |
| `app/` | Browser demo with Wallet Standard (Phantom, Solflare, Backpack…) plus a test-only burner wallet. |

## Deployments

The program address is fixed (`SoLA2LWHLmxARYxNKqtUaKMyttMwZ7WwnSHEgf47vu2`, vanity keypair kept out of git in `.keys/`).

| Cluster | Status | Details |
| --- | --- | --- |
| Devnet | Not deployed yet (needs ~4.5 SOL of devnet SOL for the 410 KB program) | `deployments/solana-devnet.json` after `npm run deploy:devnet` |
| Mainnet | Not deployed | `npm run deploy:mainnet` |

## How it works

```
 Browser / CLI (SDK)
  │  1. derive X25519 key from a wallet message signature → register_identity
  │  2. encrypt file (AES-256-GCM, random key), split into chunks (256 KiB)
  │  3. ONE wallet batch:  fund session key + open_chunk × N (pays fee) + create_record (sealed manifest)
  │  4. session key:       write_segment(index, bytes) × M   ── v1 transactions, 3 864 bytes each
  ▼
soladb program ── Chunk PDA: sha256, segment bitmap, escrowed rewards      (bytes live in the ledger: Hot)
  │                               │
  │  fee: 10% treasury,           ▼
  │  90% escrowed per replica   Replicator nodes (soladb-node)
  │                               │  getProgramAccounts(needs_replicas = 1)      ← work queue
  │                               │  getSignaturesForAddress(chunk) + getTransaction → segments
  │                               │  rebuild, verify sha256, store (RocksDB + Oracle)
  │                               ▼
  │  confirm_replication ──── reward moves from the chunk escrow to the node in the same tx
  ◄──────────────────────────────┘
  │  ≥ 60 % of replicas confirmed → Cool
  ▼
 Reader: Record (or Grant) → open sealed manifest → GET /chunk/:address/data → verify + decrypt
         (no replicator yet? the SDK rebuilds the chunk from the ledger)
 Share:  grant_access(record, viewer, manifest sealed to the viewer's key)
 Done:   close_chunk / delete_record refund the rent of their accounts
```

### Hot and Cool on Solana

- A chunk's bytes never live in account state. Each `write_segment` carries one slice in its **instruction data**, so the ledger holds the chunk while it is **Hot**. The `Chunk` account keeps only the commitment (sha256), the layout, a bitmap of written segments, the replicas that confirmed and the escrowed rewards.
- The program accepts each segment index once, so every replicator rebuilds exactly the same bytes, and the last write flips the chunk from `Pending` to `Hot` and sets `needs_replicas`.
- Once `replication_threshold_pct` (60 %) of the requested replicas confirm, the chunk is **Cool**: the ledger copy is no longer needed. Confirmations stay open until every requested replica exists.

### Economics

Each chunk costs `replicas × (base_fee_per_replica + size × price_per_byte)` lamports, paid in `open_chunk` (with a `max_fee` guard):

- `protocol_fee_bps` (default 10 %) goes straight to the treasury.
- The rest is escrowed **inside the chunk account**, one reward per requested replica. `confirm_replication` moves the reward to the replicator in the same transaction (no withdraw step, no pull payments).
- After `replication_window` (default 7 days) the uploader can `reclaim_unreplicated` the rewards of unfilled slots, or `close_chunk` to get the escrow **and** the account rent back. A `Pending` upload can be aborted (closed) at any time; a fully replicated chunk can be closed right away.
- Record and grant accounts lock rent that comes back on `delete_record` / `revoke_access`.

Default pricing (`scripts/init.ts`): 20 000 lamports per replica per chunk (covers the node's 5 000-lamport confirmation) + 2 lamports per byte per replica (≈ 0.002 SOL per MB per replica).

Measured on a local validator (`npm run measure-costs`, 2 replicas, default pricing; rent at the local 6 960 lamports/byte, devnet/mainnet currently charge 5 080 and SIMD-0437 lowers it further):

| File | Tx format | Chunks | Segment txs | Upload fee | Rent deposit (refundable) | Network fees | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 KiB | v1 | 1 | 1 | 0.000044 SOL | 0.005478 SOL | 0.000015 SOL | 1.7 s |
| 100 KiB | v1 | 1 | 27 | 0.000450 SOL | 0.005512 SOL | 0.000145 SOL | 3.3 s |
| 100 KiB | v0 | 1 | 102 | 0.000450 SOL | 0.005575 SOL | 0.000520 SOL | 8.1 s |
| 1 MiB | v1 | 4 | 272 | 0.004355 SOL | 0.013843 SOL | 0.001375 SOL | 19.2 s |
| 1 MiB | v0 | 4 | 1 040 | 0.004355 SOL | 0.014512 SOL | 0.005215 SOL | 70.6 s |

| Instruction | Compute units |
| --- | --- |
| `register_identity` | 6 813 |
| `open_chunk` + `create_record` (1 chunk) | 27 793 |
| `write_segment` (v1, 3 864 bytes) | 3 722 |
| `confirm_replication` | 9 195 |

### Privacy model

- Chunks are AES-256-GCM ciphertext under a random per-file key. The ledger is public and permanent, so encryption is the protection.
- The file key and chunk list (the manifest, a compact binary format) are sealed with X25519 + HKDF-SHA256 + AES-256-GCM to the owner's key and stored in a `Record` account. Each reader gets their own sealed copy in a `Grant` account.
- The X25519 key comes from the wallet's ed25519 signature of a fixed message (deterministic, RFC 8032), so there are no extra secrets to store. Only sign that message inside SolaDB apps.

## Solana specifics

| Topic | How SolaDB handles it |
| --- | --- |
| Transaction size | Segment writes use **v1 transactions** (SIMD-0296/0385, 4 096 bytes, live on mainnet since 15 Sep 2026): 3 864 data bytes per tx versus 1 010 with v0. `segmentTxVersion: 0` falls back for RPCs that do not accept v1 yet. v1 messages carry an explicit compute-unit limit and loaded-accounts-data limit. |
| Wallet prompts | The wallet signs **one batch per upload** (open + pay every chunk, create the record, fund a session key). A throwaway session key, set as the chunk `writer`, signs the segment transactions locally and returns its leftover lamports at the end. The CLI writes with its own keypair. |
| Finding work | Replicators query `getProgramAccounts` with a memcmp on `needs_replicas` (offset 105): the chunk accounts are the work queue, no log cursor to persist. |
| Reading the bytes | `getSignaturesForAddress(chunk)` + `getTransaction(maxSupportedTransactionVersion: 1)`, decoding `write_segment` instruction data (top level and CPI). The SDK uses the same path as a fallback when no replicator has a chunk yet. Ledger history depends on the RPC: use one with full history (or rely on replicators) for old Hot chunks. |
| History window | Segments are read from transaction history, which RPC nodes prune (the local test validator after ~10 000 shreds unless started with a larger `--limit-ledger-size`, as `scripts/localnet.sh` does). Replicators must copy a chunk while it is Hot; after that only replicators (and history-keeping RPCs) have it. A node backs off from chunks whose history is gone instead of retrying them in a loop. |
| Reorg safety | Replicators read at `finalized` commitment by default (a chunk turns Cool ~14 s after upload on a local validator). |
| Rent | Chunk, record and grant accounts are sized exactly and refund their rent when closed. Amounts come from `getMinimumBalanceForRentExemption`, so the ongoing rent reductions (SIMD-0437) apply automatically. |
| Duplicate accounts (Anchor 1.0) | The treasury is marked `dup`, so an uploader can also be the treasury. |
| Initialization | Only the program **upgrade authority** can create the config (checked against ProgramData), so nobody can front-run `initialize`. |
| sBPF | Built as sBPF v3 (Anchor 1.2 default). |

## Getting started

Prerequisites: Rust, [Agave CLI](https://docs.anza.xyz/cli/install) ≥ 4.3 (v1 transactions on the local validator need ≥ 4.2), Anchor 1.2.1 (`avm install 1.2.1`), Node.js ≥ 22. On Windows use WSL for the Rust/Solana part.

```sh
npm install                 # sdk + app workspaces (+ tsx for scripts)
anchor build                # program → target/deploy/soladb.so, target/idl/soladb.json
cargo test -p soladb        # 24 program tests on LiteSVM
npm run build:sdk
```

### Local rehearsal (everything on your machine)

```sh
npm run localnet            # terminal 1: solana-test-validator with the program; admin = .localnet/admin.json
npm run init:localnet       # config + pricing → deployments/solana-localnet.json
npm run test:sdk            # SDK unit tests + 10 end-to-end tests against the validator
npm run measure-costs       # compute units and cost per file size
```

Then run a node against it (see below) and `NODE_URL=http://localhost:3000 npm run e2e:localnet`.

### Deploy and configure

```sh
cp .env.example .env        # DEPLOYER_KEYPAIR, REPLICATOR_KEYPAIR, REPLICATOR_ENDPOINT, pricing
npm run deploy:devnet       # solana program deploy (vanity id) → init.ts → export-idl.ts
npm run fund-replicator:devnet
```

`init.ts` is idempotent: it creates the config, updates it when the pricing variables change, registers replicators and writes `deployments/solana-<cluster>.json`. `export-idl.ts` copies the IDL into the SDK and regenerates `sdk/src/deployments.ts`.

### Run a replicator node

With Docker (node + Oracle):

```sh
cp soladb-node/.env.example soladb-node/.env   # SOLANA_RPC_URL, NODE_ENDPOINT, …
ORACLE_SYS_PASSWORD=... ORACLE_PASSWORD=... docker compose up -d --build
```

The replicator keypair is mounted from `./.keys/devnet-replicator.json` (override with `REPLICATOR_KEYPAIR_FILE`).

Without Docker (file-based stores, for development):

```sh
npm run build:sdk
cd soladb-node && npm install && npm run build
CHUNK_STORE=fs METADATA_STORE=file REPLICATOR_KEYPAIR=../.keys/devnet-replicator.json npm run start:prod
```

The node exposes:

- `GET  /status`: cluster, program, replicator registration, balance, confirmations, earnings, last scan
- `POST /query`: JSON query language (filter, sort, paginate) over stored chunks
- `GET  /chunk/:address/meta`: chunk metadata (local, else on-chain)
- `GET  /chunk/:address/data`: raw (encrypted) chunk bytes; CORS enabled for browsers
- `GET  /docs`: Swagger/OpenAPI UI

Replicator settings worth knowing: `MIN_REWARD_LAMPORTS` (skip cheap chunks), `SOLANA_COMMITMENT` (default `finalized`), `UPDATE_ENDPOINT_ON_START` (publish `NODE_ENDPOINT` on-chain).

### SDK

```ts
import { createSolanaRpc } from '@solana/kit';
import { SolaDBClient, DEPLOYMENTS } from '@soladb/sdk';

// signer: any Kit TransactionSigner (KeyPairSigner, a Wallet Standard account signer…)
const soladb = new SolaDBClient({ signer, signMessage, deployment: DEPLOYMENTS.devnet });
await soladb.register();                                         // one message signature + one tx
const quote = await soladb.quoteFile(bytes.length, 2);           // upload fee, refundable rent, network fees
const { recordId } = await soladb.uploadFile(bytes, { name: 'report.pdf', replicas: 2 });
await soladb.share(recordId, friendAddress);                     // friend must be registered
const { data } = await soladb.downloadFile(recordId);            // verified + decrypted
await soladb.reclaimDeposits(recordId);                          // once replicated: rent back
await soladb.reclaimAllDeposits();                               // every settled chunk, incl. deleted files
```

### CLI

```sh
npm run build:sdk
export SOLADB_CLUSTER=devnet SOLADB_KEYPAIR=~/.config/solana/id.json
node sdk/dist/cli.js register
node sdk/dist/cli.js quote ./contract.pdf --replicas 2
node sdk/dist/cli.js upload ./contract.pdf --replicas 2 --wait
node sdk/dist/cli.js ls
node sdk/dist/cli.js share <recordId> <address>
node sdk/dist/cli.js download <recordId> -o copy.pdf
node sdk/dist/cli.js reclaim <recordId>     # or no id: every settled chunk you own
```

### Demo app

```sh
npm run app:dev        # http://localhost:5173, devnet by default
```

For a local validator set `VITE_SOLADB_CLUSTER=localnet` (see `app/.env.example`) and use the burner wallet (test only) with its airdrop button.

## Repository layout

```
programs/soladb/
  src/instructions/admin.rs       config, pricing, replicator registry
  src/instructions/identity.rs    X25519 encryption keys
  src/instructions/storage.rs     open_chunk, write_segment, confirm_replication, reclaim, close
  src/instructions/records.rs     sealed manifests, grants
  src/state.rs                    accounts (Config, Identity, Replicator, Chunk, Record, Grant)
  tests/soladb.rs                 LiteSVM tests
idl/soladb.json                   Anchor IDL (source of the SDK codecs)
sdk/                              @soladb/sdk + soladb CLI (+ unit and localnet e2e tests)
app/                              browser demo (Vite)
soladb-node/                      NestJS replicator node (+ Dockerfile)
scripts/                          localnet, deploy, init, fund-replicator, e2e, measure-costs, export-idl
deployments/                      deployed addresses, e2e results, measured costs
docker-compose.yml                replicator + Oracle
```

After changing the program, run `anchor build` and `npm run export-idl`.

## Origins

SolaDB started as the Solana port of [AvaDB](https://github.com/Emanuel250YT/AvaDB), the same Hot/Cool design first built for Avalanche and then for Monad (EVM). What changed on the way to Solana:

| AvaDB on Monad (EVM) | SolaDB on Solana |
| --- | --- |
| 3 contracts (IdentityRegistry, AvaDBStorage, AvaDB) | 1 program, PDAs per identity / chunk / record / grant / replicator |
| Chunk bytes in event logs (48 KiB per tx) | Chunk bytes in `write_segment` instruction data (3 864 bytes per v1 tx) |
| `keccak256(data)` checked on-chain | sha256 committed at `open_chunk`, checked by replicators and readers |
| `eth_getLogs` poller + persisted cursor | `getProgramAccounts` work queue (stateless) |
| Pull payments (`withdrawRewards`) | Reward paid inside `confirm_replication` |
| Protocol fees accrue, `withdrawProtocolFees` | Protocol share transferred to the treasury in `open_chunk` |
| Storage costs gas forever | Accounts refund their rent when closed |
| Key from a secp256k1 signature | Key from an ed25519 message signature |

## License

[MIT](LICENSE)
