import './style.css';
import {
  SolaDBClient,
  type ChunkStatus,
  type ConfigAccount,
  type FileEntry,
  type AnyManifest,
  type FileQuote,
  type UploadMode,
} from '@soladb/sdk';
import { type Address, isAddress } from '@solana/kit';
import { loadBurner, requestAirdrop } from './burner';
import { bytes, displayName, errorMessage, plural, safeFileName, safeMime, short, sol } from './format';
import {
  createRpc,
  explorerUrl,
  listReplicators,
  NetworkProblem,
  type NetworkEnv,
  probeProgram,
  type ReplicatorInfo,
  resolveNetwork,
  solscanUrl,
} from './network';
import { burnerSession, connectWallet, listWallets, safeIcon, watchWallets, type WalletSession } from './wallet';

// ── Network ─────────────────────────────────────────────────────────────────

// VITE_SOLADB_CLUSTER / VITE_SOLANA_RPC_URL / VITE_SOLADB_DEPLOYMENT / VITE_SOLADB_NODE_URLS (see .env.example)
const NETWORK = resolveNetwork(import.meta.env as NetworkEnv);
const rpc = createRpc(NETWORK);

/** Max file size in the demo; ledger uploads stay small (about 17 segment transactions per 64 KiB chunk) */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LEDGER_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const AIRDROP_SOL = NETWORK.cluster === 'localnet' ? 5n : 1n;
const BURNER = 'burner';

// ── State ───────────────────────────────────────────────────────────────────

interface FileView {
  entry: FileEntry;
  manifest?: AnyManifest;
  chunks?: ChunkStatus[];
  /** Wallets holding a grant (owner only, loaded when the share panel opens) */
  viewers?: Address[];
  error?: string;
}

interface Notice {
  text: string;
  /** Command that fixes it, shown as code */
  command?: string;
}

const state = {
  wallets: listWallets(),
  session: undefined as WalletSession | undefined,
  client: undefined as SolaDBClient | undefined,
  burnerPersisted: true,
  /** Bumped on every connect/disconnect so stale background work stops */
  generation: 0,
  registered: false,
  unlocked: false,
  balance: undefined as bigint | undefined,
  busy: false,
  /** SolaDB is deployed and initialized on the cluster (undefined while checking) */
  ready: undefined as boolean | undefined,
  config: undefined as ConfigAccount | undefined,
  notice: undefined as Notice | undefined,
  file: undefined as File | undefined,
  replicas: 1,
  /** auto = erasure-coded blob on the nodes when one answers, else the ledger */
  mode: 'auto' as UploadMode,
  /** Blob storage prepaid, in program epochs */
  epochs: 12,
  quote: undefined as FileQuote | undefined,
  progress: [] as { stage: string; text: string }[],
  files: new Map<string, FileView>(),
  watching: new Set<string>(),
  downloading: '',
  replicators: [] as ReplicatorInfo[],
  nodeUrl: readSetting('soladb:node', ''),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Addresses are the only chain values that go into markup, and only after
 * isAddress (base58, so nothing to escape).  Names, MIME types, endpoints and
 * wallet names only ever reach the page through textContent.
 */
function addr(value: string): string {
  return isAddress(value) ? value : '';
}

function link(href: string, label: string, className = ''): string {
  return `<a ${className ? `class="${className}" ` : ''}href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;
}

function accountLink(account: string, label = short(account), className = 'hex'): string {
  return addr(account) ? link(explorerUrl(NETWORK, 'address', account), label, className) : '';
}

/** Replace a section's markup only when it changed (keeps focus and selections); `fill` sets text every time */
function setHtml(el: HTMLElement, html: string, fill?: (root: HTMLElement) => void): void {
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  fill?.(el);
}

function setText(root: ParentNode, selector: string, value: string): void {
  for (const node of root.querySelectorAll<HTMLElement>(selector)) {
    if (node.textContent !== value) node.textContent = value;
  }
}

function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: the setting lasts for this visit only */
  }
}

function toast(message: string, isError = false): void {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.textContent = message;
  $('toasts')?.append(el);
  setTimeout(() => el.remove(), isError ? 9000 : 5000);
}

async function run(task: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await task();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err), true);
  } finally {
    state.busy = false;
    render();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCool(chunks: ChunkStatus[]): boolean {
  return chunks.every((c) => c.state === 'Cool' || c.state === 'Closed');
}

function noSolHint(): string {
  return NETWORK.testOnly ? ' Use “Airdrop” to get test SOL.' : ' Add some SOL to pay network fees and the refundable rent.';
}

function windowText(): string {
  const seconds = Number(state.config?.replicationWindow ?? 0n);
  if (!seconds) return 'its replication window';
  return seconds % 3600 === 0 ? `its ${plural(seconds / 3600, 'hour')} replication window` : `its ${plural(Math.round(seconds / 60), 'minute')} replication window`;
}

// ── Network checks ──────────────────────────────────────────────────────────

async function checkNetwork(): Promise<void> {
  if (NETWORK.problem) {
    state.ready = false;
    state.notice = { text: NETWORK.problem };
  } else if (!NETWORK.deployment) {
    state.ready = false;
    state.notice = {
      text: `SolaDB is not deployed on ${NETWORK.name} yet. Deploy and initialize the program, then regenerate the SDK deployments (or set VITE_SOLADB_DEPLOYMENT):`,
      command: `npm run deploy:${NETWORK.cluster} && npm run init:${NETWORK.cluster} && npm run export-idl`,
    };
  } else {
    try {
      state.config = await probeProgram(NETWORK, rpc);
      state.ready = true;
      state.notice = undefined;
    } catch (err) {
      state.ready = false;
      const kind = err instanceof NetworkProblem ? err.kind : 'rpc';
      state.notice = {
        text: errorMessage(err),
        command:
          kind === 'uninitialized' ? `npm run init:${NETWORK.cluster}` : NETWORK.cluster === 'localnet' ? 'npm run localnet' : undefined,
      };
    }
  }
  render();
  if (state.ready) await refreshReplicators();
}

async function refreshReplicators(): Promise<void> {
  try {
    state.replicators = await listReplicators(NETWORK, rpc);
  } catch (err) {
    console.warn('Could not list replicators', err);
  }
  render();
}

function requireReady(): void {
  if (state.ready === false) throw new Error(state.notice?.text ?? `SolaDB is not available on ${NETWORK.name}.`);
}

// ── Wallet ──────────────────────────────────────────────────────────────────

function nodeUrls(): string[] {
  return [...new Set([state.nodeUrl, ...NETWORK.nodeUrls].filter(Boolean))];
}

function resetAccount(): void {
  state.generation++;
  state.registered = false;
  state.unlocked = false;
  state.balance = undefined;
  state.file = undefined;
  state.quote = undefined;
  state.progress = [];
  state.files.clear();
  state.watching.clear();
}

/** Start using a connected wallet: one SolaDBClient per account */
async function adopt(session: WalletSession): Promise<void> {
  resetAccount();
  state.session = session;
  state.client = new SolaDBClient({
    signer: session.signer,
    signMessage: session.signMessage,
    deployment: NETWORK.deployment,
    rpc,
    programId: NETWORK.programId,
    nodeUrls: nodeUrls(),
    chunkSize: CHUNK_BYTES,
    // The burner signs without prompts, so it writes the segments itself
    sessionWriter: session.kind !== 'burner',
  });
  render();
  const generation = state.generation;
  const [registered] = await Promise.all([state.client.isRegistered(), refreshBalance()]);
  if (generation === state.generation) state.registered = registered;
}

async function connect(choice: string): Promise<void> {
  if (!NETWORK.deployment) throw new Error(`SolaDB is not deployed on ${NETWORK.name} yet.`);
  let session: WalletSession | null;
  if (choice === BURNER) {
    if (!NETWORK.testOnly) throw new Error('The burner wallet only exists on localnet and devnet.');
    const burner = await loadBurner();
    state.burnerPersisted = burner.persisted;
    session = burnerSession(burner.signer);
  } else {
    const wallet = state.wallets[Number(choice)];
    if (!wallet) throw new Error('That wallet is not available any more. Reload the page and try again.');
    session = await connectWallet(wallet, NETWORK.chain, { onChange: (next) => void switchAccount(next) });
  }
  if (!session) throw new Error('The wallet did not share an account.');
  writeSetting('soladb:wallet', choice === BURNER ? BURNER : session.name);
  await adopt(session);
  toast(`Connected ${short(session.address)} with ${session.name}.`);
}

/** The wallet switched accounts (or disconnected) on its own */
async function switchAccount(next: WalletSession | null): Promise<void> {
  if (!next) {
    resetAccount();
    state.session = undefined;
    state.client = undefined;
    render();
    toast('Your wallet disconnected.');
    return;
  }
  try {
    await adopt(next);
    toast(`Switched to ${short(next.address)}. Unlock your key again for this account.`);
  } catch (err) {
    toast(errorMessage(err), true);
  }
  render();
}

/** Reconnect the wallet used last time without prompting (already authorized wallets only) */
let reconnectTried = false;
async function reconnect(): Promise<void> {
  const remembered = readSetting('soladb:wallet', '');
  if (reconnectTried || state.session || state.busy || !remembered || !NETWORK.deployment) return;
  const index = state.wallets.findIndex((w) => w.name === remembered);
  if (remembered !== BURNER && index === -1) return; // the extension may register later
  reconnectTried = true;
  state.busy = true;
  render();
  try {
    if (remembered === BURNER) {
      if (!NETWORK.testOnly) return;
      const burner = await loadBurner();
      state.burnerPersisted = burner.persisted;
      await adopt(burnerSession(burner.signer));
    } else {
      const session = await connectWallet(state.wallets[index], NETWORK.chain, {
        silent: true,
        onChange: (next) => void switchAccount(next),
      });
      if (session) await adopt(session);
    }
  } catch (err) {
    console.warn('Silent reconnect failed', err);
  } finally {
    state.busy = false;
    render();
  }
}

async function disconnect(): Promise<void> {
  const session = state.session;
  resetAccount();
  state.session = undefined;
  state.client = undefined;
  writeSetting('soladb:wallet', '');
  render();
  await session?.disconnect().catch((err) => console.warn('Wallet disconnect failed', err));
  toast('Disconnected.');
}

async function refreshBalance(): Promise<void> {
  const session = state.session;
  if (!session) return;
  try {
    const { value } = await rpc.getBalance(session.address, { commitment: 'confirmed' }).send();
    if (state.session === session) state.balance = value;
  } catch (err) {
    console.warn('Could not read the balance', err);
  }
  render();
}

async function airdrop(): Promise<void> {
  const session = requireSession();
  if (!NETWORK.testOnly) throw new Error('Airdrops only exist on localnet and devnet.');
  toast(`Asking the ${NETWORK.name} faucet for ${AIRDROP_SOL} SOL…`);
  await requestAirdrop(rpc, session.address, AIRDROP_SOL);
  await refreshBalance();
  toast(`Received ${AIRDROP_SOL} test SOL.`);
}

async function unlock(): Promise<void> {
  const client = requireClient();
  requireReady();
  if (!state.registered && state.balance === 0n) throw new Error(`This wallet has no SOL on ${NETWORK.name}.${noSolHint()}`);
  // A signature (re-)derives the key; register publishes it, or rotates it if the one on-chain differs
  const signature = await client.register();
  if (!state.registered) toast(signature ? 'Encryption key registered on Solana.' : 'Your key was already registered.');
  else if (signature) toast('Your registered key was updated to match this wallet.');
  state.registered = true;
  state.unlocked = true;
  void refreshBalance();
  await refreshFiles();
}

function requireSession(): WalletSession {
  if (!state.session) throw new Error('Connect a wallet first.');
  return state.session;
}

function requireClient(): SolaDBClient {
  if (!state.client) throw new Error('Connect a wallet first.');
  return state.client;
}

// ── Upload ──────────────────────────────────────────────────────────────────

async function chooseFile(file: File | undefined): Promise<void> {
  state.file = file;
  state.quote = undefined;
  state.progress = [];
  render();
  if (!file || !state.client) return;
  if (file.size > MAX_FILE_BYTES) {
    toast(`This demo accepts files up to ${bytes(MAX_FILE_BYTES)}. Pick a smaller file.`, true);
    state.file = undefined;
    render();
    return;
  }
  await updateQuote();
}

async function updateQuote(): Promise<void> {
  const client = state.client;
  const file = state.file;
  if (!client || !file) return;
  requireReady();
  state.quote = await client.quoteFile(file.size, state.replicas, state.mode, { epochs: state.epochs });
  render();
}

function setProgress(stage: string, text: string): void {
  const line = state.progress.find((p) => p.stage === stage);
  if (line) line.text = text;
  else state.progress = [...state.progress, { stage, text }];
  render();
}

async function upload(): Promise<void> {
  const client = requireClient();
  const session = requireSession();
  const file = state.file;
  if (!file) throw new Error('Choose a file first.');
  requireReady();
  const quote = state.quote ?? (await client.quoteFile(file.size, state.replicas, state.mode, { epochs: state.epochs }));
  if (quote.mode === 'ledger' && file.size > MAX_LEDGER_BYTES) {
    throw new Error(`Ledger uploads are limited to ${bytes(MAX_LEDGER_BYTES)} in this demo. Choose "Direct to nodes" or a smaller file.`);
  }
  await refreshBalance();
  if (state.balance !== undefined && state.balance < quote.total) {
    throw new Error(`This upload needs about ${sol(quote.total)} and the wallet holds ${sol(state.balance)}.${noSolHint()}`);
  }

  state.progress = [];
  setProgress('encrypt', 'Compressing and encrypting in your browser…');
  const generation = state.generation;
  const data = new Uint8Array(await file.arrayBuffer());
  const burner = session.kind === 'burner';
  const result = await client.uploadFile(data, {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    replicas: state.replicas,
    mode: quote.mode,
    epochs: state.epochs,
    onProgress: (p) => {
      if (p.stage === 'sign') {
        setProgress(
          'sign',
          burner
            ? `Signing ${plural(p.total, 'transaction')} with the burner key`
            : `Approve ${plural(p.total, 'transaction')} in your wallet: open the chunk accounts, pay the fee, save the sealed record`,
        );
      }
      if (p.stage === 'open') setProgress('open', `Opened the chunk accounts and saved the record (${p.done}/${p.total})`);
      if (p.stage === 'segments') {
        setProgress('segments', `Wrote encrypted segments to the Solana ledger (${p.done}/${p.total})${burner ? '' : ', signed by a one-time session key'}`);
      }
      if (p.stage === 'push') {
        setProgress('push', quote.mode === 'blob'
          ? `Sent erasure-coded shards to the nodes, one shard per node (${p.done}/${p.total})`
          : `Sent encrypted chunks straight to replicator nodes (${p.done}/${p.total})`);
      }
      if (p.stage === 'done') {
        setProgress(
          'done',
          quote.mode === 'blob'
            ? `Done. Any ${quote.layout?.k} of the ${(quote.layout?.k ?? 0) + (quote.layout?.m ?? 0)} nodes can rebuild your file; they prove it periodically to get paid.`
            : quote.mode === 'direct'
              ? 'Done. The nodes confirm on-chain; the chunk deposit comes back to your wallet by itself.'
              : 'Done. Replicators rebuild the chunks from the ledger next.',
        );
      }
    },
  });

  toast(`Uploaded ${file.name}. Replicators are picking it up.`);
  if (generation !== state.generation) return; // the wallet switched accounts meanwhile
  state.file = undefined;
  state.quote = undefined;
  state.progress = [];
  const entry: FileEntry = { recordId: result.recordId, owner: client.address, shared: false, createdAt: Math.floor(Date.now() / 1000) };
  state.files.set(result.recordId, { entry });
  void refreshBalance();
  await loadFile(result.recordId);
  void watchUntilCool(result.recordId);
}

// ── Files ───────────────────────────────────────────────────────────────────

async function refreshFiles(): Promise<void> {
  const client = requireClient();
  const generation = state.generation;
  const entries = await client.listFiles();
  if (generation !== state.generation) return;

  // Owned beats shared when the same record shows up twice; drop anything that is not an address
  const fresh = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (!isAddress(entry.recordId) || !isAddress(entry.owner)) continue;
    const seen = fresh.get(entry.recordId);
    if (!seen || (seen.shared && !entry.shared)) fresh.set(entry.recordId, entry);
  }
  for (const id of [...state.files.keys()]) if (!fresh.has(id)) state.files.delete(id);
  for (const [id, entry] of fresh) state.files.set(id, { ...state.files.get(id), entry });
  render();

  // A few at a time: public RPCs rate-limit bursts
  const ids = [...fresh.keys()];
  await Promise.all(
    Array.from({ length: Math.min(3, ids.length) }, async () => {
      for (let id = ids.shift(); id; id = ids.shift()) await loadFile(id);
    }),
  );
  for (const [id, view] of state.files) if (view.chunks && !isCool(view.chunks)) void watchUntilCool(id);
}

async function loadFile(recordId: string): Promise<void> {
  const client = state.client;
  const view = state.files.get(recordId);
  if (!client || !view) return;
  try {
    const status = await client.fileStatus(recordId);
    view.manifest = status.manifest;
    view.chunks = status.chunks;
    view.error = undefined;
  } catch (err) {
    view.error = errorMessage(err);
  }
  render();
}

/** Poll the chunk accounts until every chunk is Cool (or closed) */
async function watchUntilCool(recordId: string): Promise<void> {
  if (state.watching.has(recordId)) return;
  state.watching.add(recordId);
  const generation = state.generation;
  try {
    for (let i = 0; i < 200; i++) {
      await sleep(3000);
      const client = state.client;
      const view = state.files.get(recordId);
      if (generation !== state.generation || !client || !view?.chunks) return;
      const chunks = await client.chunkStatus(view.chunks.map((c) => c.address)).catch(() => undefined);
      if (!chunks || generation !== state.generation) continue;
      view.chunks = chunks;
      render();
      if (isCool(chunks)) {
        toast(`${view.manifest ? displayName(view.manifest.name) : 'Your file'} is replicated.`);
        return;
      }
    }
  } finally {
    if (generation === state.generation) state.watching.delete(recordId);
  }
}

async function download(recordId: string): Promise<void> {
  state.downloading = recordId;
  render();
  try {
    const file = await requireClient().downloadFile(recordId);
    const name = safeFileName(file.name);
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: safeMime(file.mime) }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Downloaded ${name}, decrypted and verified.`);
  } finally {
    state.downloading = '';
  }
}

async function share(recordId: string, viewer: string): Promise<void> {
  const client = requireClient();
  if (!isAddress(viewer)) throw new Error('Enter a valid Solana address.');
  if (viewer === client.address) throw new Error('That is your own wallet: you can already open this file.');
  if (!(await client.isRegistered(viewer))) {
    throw new Error(`${short(viewer)} has no SolaDB key yet. Ask them to open SolaDB and create one first.`);
  }
  await client.share(recordId, viewer);
  toast(`Shared with ${short(viewer)}. They can open it from their own vault.`);
  void refreshBalance();
  await loadViewers(recordId);
}

async function revoke(recordId: string, viewer: string): Promise<void> {
  if (!isAddress(viewer)) throw new Error('Not a valid Solana address.');
  await requireClient().revoke(recordId, viewer);
  toast(`Revoked ${short(viewer)}. A copy they already opened stays with them.`);
  void refreshBalance();
  await loadViewers(recordId);
}

async function loadViewers(recordId: string): Promise<void> {
  const client = state.client;
  const view = state.files.get(recordId);
  if (!client || !view || view.entry.shared) return;
  try {
    view.viewers = (await client.viewers(recordId)).filter((v) => isAddress(v));
  } catch (err) {
    console.warn('Could not list viewers', err);
    view.viewers ??= [];
  }
  render();
}

async function reclaim(recordId: string): Promise<void> {
  const { closed } = await requireClient().reclaimDeposits(recordId);
  if (closed === 0) {
    toast(`No chunk can be closed yet. A chunk settles once every replica confirmed it, or after ${windowText()}.`);
    return;
  }
  toast(`Closed ${plural(closed, 'chunk account')}. The rent is back in your wallet; replicators keep the data.`);
  void refreshBalance();
  await loadFile(recordId);
}

async function removeFile(recordId: string): Promise<void> {
  const view = state.files.get(recordId);
  const name = view?.manifest ? displayName(view.manifest.name) : 'this file';
  const unsettled = (view?.chunks ?? []).filter(
    (c) => c.state !== 'Closed' && c.state !== 'Pending' && c.confirmedReplicas < c.requiredReplicas,
  ).length;
  const warning = unsettled
    ? `\n\n${plural(unsettled, 'chunk')} still wait for replicas, so their rent stays locked. Wait until every replica confirmed to recover all of it.`
    : '';
  const ok = confirm(
    `Delete “${name}”?\n\nThis revokes every grant, deletes the record and closes the settled chunks, returning their rent. ` +
      `Replicators may keep the encrypted copies they hold.${warning}`,
  );
  if (!ok) return;
  await requireClient().deleteFile(recordId);
  state.files.delete(recordId);
  toast(`Deleted ${name}.`);
  void refreshBalance();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render(): void {
  renderTopbar();
  renderNotice();
  renderIdentity();
  renderUpload();
  renderFiles();
  renderFooter();
}

function renderTopbar(): void {
  const network = $('network');
  if (network) {
    network.textContent = NETWORK.name;
    network.classList.toggle('is-live', state.ready === true);
  }
  const account = $<HTMLButtonElement>('account');
  if (account) {
    const session = state.session;
    account.textContent = session
      ? `${short(session.address)} · ${state.balance === undefined ? '…' : sol(state.balance)}`
      : 'Connect wallet';
    account.title = session ? 'Copy address' : '';
    account.disabled = state.busy && !session;
  }
}

function renderNotice(): void {
  const notice = $('notice');
  if (!notice) return;
  notice.hidden = !state.notice;
  if (!state.notice) return;
  setHtml(notice, `<span data-text="notice"></span>${state.notice.command ? ' <code data-text="command"></code>' : ''}`, (root) => {
    setText(root, '[data-text="notice"]', state.notice?.text ?? '');
    setText(root, '[data-text="command"]', state.notice?.command ?? '');
  });
}

function renderIdentity(): void {
  const el = $('identity');
  if (!el) return;
  const disabled = state.busy ? 'disabled' : '';
  const session = state.session;

  if (!session) {
    const blocked = !NETWORK.deployment || Boolean(NETWORK.problem);
    const wallets = state.wallets
      .map(
        (_, i) =>
          `<button class="wallet-option" type="button" data-action="connect" data-wallet="${i}" ${disabled || (blocked ? 'disabled' : '')}>
            <img class="wallet-icon" data-wallet-icon="${i}" alt="" hidden /><span data-wallet-name="${i}"></span>
          </button>`,
      )
      .join('');
    const burner = NETWORK.testOnly
      ? `<button class="wallet-option wallet-burner" type="button" data-action="connect" data-wallet="${BURNER}" ${disabled || (blocked ? 'disabled' : '')}>
          <span class="wallet-icon wallet-icon-burner" aria-hidden="true"></span><span>Burner wallet (test only)</span>
        </button>`
      : '';
    setHtml(
      el,
      `
      <p class="muted">Connect a Solana wallet on ${esc(NETWORK.name)}. You need a little SOL for network fees and the refundable rent deposits.</p>
      <div class="wallets" id="wallet-picker">${wallets}${burner}</div>
      ${state.wallets.length === 0 ? '<p class="muted small">No Solana wallet extension found. Install Phantom, Solflare or Backpack and reload.</p>' : ''}
      ${NETWORK.testOnly ? '<p class="muted small">The burner wallet keeps a throwaway key in this browser’s storage, so anyone using this browser can spend from it. Test SOL only.</p>' : ''}`,
      (root) => {
        state.wallets.forEach((wallet, i) => {
          setText(root, `[data-wallet-name="${i}"]`, wallet.name);
          const img = root.querySelector<HTMLImageElement>(`[data-wallet-icon="${i}"]`);
          const icon = safeIcon(wallet);
          if (img && icon && img.getAttribute('src') !== icon) img.src = icon;
          if (img) img.hidden = !icon;
        });
      },
    );
    return;
  }

  const walletLine = `
    <div class="wallet-line">
      <span class="wallet-name" data-text="wallet"></span>
      ${accountLink(session.address, short(session.address))}
      <span class="muted">${state.balance === undefined ? '…' : esc(sol(state.balance))}</span>
      <span class="wallet-actions">
        ${NETWORK.testOnly ? `<button class="button button-quiet button-small" type="button" data-action="airdrop" ${disabled}>Airdrop ${AIRDROP_SOL} SOL</button>` : ''}
        <button class="button button-quiet button-small" type="button" data-action="disconnect" ${disabled}>Disconnect</button>
      </span>
    </div>
    ${
      session.kind === 'burner'
        ? `<p class="muted small">Burner wallet: its key lives in this browser’s storage. Use it on ${esc(NETWORK.name)} with test SOL only.${
            state.burnerPersisted ? '' : ' Storage is blocked here, so this burner disappears when you close the tab.'
          }</p>`
        : ''
    }`;
  const fill = (root: HTMLElement) => setText(root, '[data-text="wallet"]', session.kind === 'burner' ? 'Burner wallet' : session.name);

  if (state.unlocked) {
    setHtml(el, `${walletLine}<p>Your encryption key is registered and unlocked for this visit. Files are encrypted before they leave this tab.</p>`, fill);
    return;
  }
  const warning = `<p class="warning">Only sign the “SolaDB encryption key” message inside SolaDB apps: whoever gets that signature can decrypt your files.</p>`;
  setHtml(
    el,
    walletLine +
      (state.registered
        ? `<p class="muted">Sign one message to unlock your key. It costs nothing, sends no transaction, and the key never leaves this tab.</p>
           <button class="button" type="button" data-action="unlock" ${disabled}>Unlock my files</button>${warning}`
        : `<p class="muted">Your wallet signs one message to create your encryption key (always the same key for this wallet), then publishes
             its public half on Solana in one transaction, which also locks a small rent deposit for your identity account.</p>
           <button class="button" type="button" data-action="unlock" ${disabled}>Create my encryption key</button>${warning}`),
    fill,
  );
}

function renderUpload(): void {
  const el = $('upload');
  if (!el) return;
  $('step-upload')?.classList.toggle('is-locked', !state.unlocked);
  if (!state.unlocked) {
    setHtml(el, `<p class="muted">Unlock your key first.</p>`);
    return;
  }
  const disabled = state.busy ? 'disabled' : '';
  const file = state.file;
  const quote = state.quote;
  const chunks = file ? (quote?.chunks ?? Math.max(1, Math.ceil(file.size / CHUNK_BYTES))) : 0;
  const active = state.replicators.filter((r) => r.active).length;
  const modes: [UploadMode, string][] = [
    ['auto', 'Automatic'],
    ['blob', 'Nodes, erasure coded (cheapest)'],
    ['ledger', 'Solana ledger'],
  ];
  const epochDays = state.config ? Number(state.config.epochSeconds) / 86_400 : 30;
  const durations = [1, 3, 6, 12, 24].map((n) => [n, n * epochDays] as const);
  const durationLabel = (days: number) => (days >= 365 ? `${+(days / 365).toFixed(1)} yr` : days >= 28 ? `${Math.round(days / 30)} mo` : `${+days.toFixed(2)} days`);
  const protocolPct = state.config ? state.config.protocolFeeBps / 100 : undefined;
  const burner = state.session?.kind === 'burner';
  setHtml(
    el,
    `
    <label class="dropzone" id="dropzone">
      <input type="file" id="file-input" ${disabled} />
      <span>${
        file
          ? `<strong data-text="file-name"></strong><br />${esc(bytes(file.size))} in ${plural(chunks, 'encrypted chunk')}`
          : `Drop a file here or choose one (up to ${esc(bytes(MAX_FILE_BYTES))}, ${esc(bytes(MAX_LEDGER_BYTES))} on the ledger)`
      }</span>
    </label>
    <div class="row">
      <label for="replicas">Copies</label>
      <select id="replicas" ${disabled}>
        ${[1, 2, 3, 5].map((n) => `<option value="${n}" ${n === state.replicas ? 'selected' : ''}>${plural(n, 'replica')}</option>`).join('')}
      </select>
      <span class="muted small">${plural(active, 'active replicator node')} on ${esc(NETWORK.name)}</span>
    </div>
    <div class="row">
      <label for="mode">Storage</label>
      <select id="mode" ${disabled}>
        ${modes.map(([value, label]) => `<option value="${value}" ${value === state.mode ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${
        quote
          ? `<span class="muted small">${
              quote.mode === 'blob'
                ? `Split into ${(quote.layout?.k ?? 0) + (quote.layout?.m ?? 0)} shards on different nodes; any ${quote.layout?.k} rebuild it. Solana keeps one root, the payment and who can read it.`
                : quote.mode === 'direct'
                  ? 'Chunks go straight to the nodes; Solana keeps the hash, the payment and who can read it.'
                  : 'Chunks are written to the Solana ledger, readable before any node has copied them.'
            }</span>`
          : ''
      }
    </div>
    ${
      quote?.mode === 'blob'
        ? `<div class="row">
            <label for="epochs">Keep for</label>
            <select id="epochs" ${disabled}>
              ${durations.map(([n, days]) => `<option value="${n}" ${n === state.epochs ? 'selected' : ''}>${durationLabel(days)}</option>`).join('')}
            </select>
            <span class="muted small">Prepaid; extend it any time before it ends.</span>
          </div>`
        : ''
    }
    ${
      quote
        ? `<dl class="quote">
            <dt>${quote.mode === 'blob' ? 'Storage fee' : 'Upload fee'}</dt><dd>${esc(sol(quote.uploadFee))}${protocolPct !== undefined ? ` <span class="muted">(${protocolPct}% protocol, the rest pays the ${quote.mode === 'blob' ? 'shard holders' : 'replicas'})</span>` : ''}</dd>
            <dt>Network fees</dt><dd>about ${esc(sol(quote.networkFee))}</dd>
            <dt>Real cost</dt><dd>${esc(sol(quote.uploadFee + quote.networkFee))} <span class="muted">(at most: compressible files cost less)</span></dd>
            <dt>Deposit</dt><dd>${esc(sol(quote.chunkRent))} <span class="muted">(${quote.mode === 'blob' ? 'comes back when the storage ends' : 'comes back by itself once replicated'})</span></dd>
            <dt>Record deposit</dt><dd>${esc(sol(quote.recordRent))} <span class="muted">(back when you delete the file)</span></dd>
            <dt>Transactions</dt><dd>${burner ? 'no prompts' : 'one wallet prompt'}${
              quote.mode !== 'ledger' ? ', nothing written to the ledger' : `, then ${plural(quote.segments, 'segment write')} to the ledger`
            }</dd>
          </dl>`
        : ''
    }
    <button class="button" type="button" data-action="upload" ${!file || state.busy ? 'disabled' : ''}>Encrypt and upload</button>
    ${state.progress.length ? `<ol class="progress">${state.progress.map((p) => `<li>${esc(p.text)}</li>`).join('')}</ol>` : ''}`,
    (root) => setText(root, '[data-text="file-name"]', file?.name ?? ''),
  );
}

function renderFiles(): void {
  const el = $('files');
  if (!el) return;
  $('step-files')?.classList.toggle('is-locked', !state.unlocked);
  if (!state.unlocked) {
    setHtml(el, `<p class="muted">Your files and the ones shared with you show up here.</p>`);
    return;
  }
  const files = [...state.files.values()].sort((a, b) => b.entry.createdAt - a.entry.createdAt);
  if (files.length === 0) {
    setHtml(
      el,
      `<p class="muted">No files yet. Upload one above, or ask someone to share a file with ${esc(short(state.session?.address ?? ''))}.</p>
      <button class="button button-quiet button-small" type="button" data-action="refresh" ${state.busy ? 'disabled' : ''}>Check again</button>`,
    );
    return;
  }

  // Keyed, in-place updates: status polling must not reset a half-typed share address
  if (!el.querySelector('ul.file-list')) {
    setHtml(el, `<ul class="file-list"></ul><button class="button button-quiet button-small" type="button" data-action="refresh">Refresh</button>`);
  }
  const list = el.querySelector<HTMLUListElement>('ul.file-list');
  if (!list) return;
  const items = new Map<string, HTMLLIElement>();
  for (const li of [...list.children] as HTMLLIElement[]) {
    if (state.files.has(li.dataset.id ?? '')) items.set(li.dataset.id!, li);
    else li.remove();
  }
  files.forEach((view, index) => {
    const li = items.get(view.entry.recordId) ?? createFileItem(view);
    if (list.children[index] !== li) list.insertBefore(li, list.children[index] ?? null);
    updateFileItem(li, view);
  });
  for (const control of el.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
    if (!control.dataset.action || control.dataset.action === 'refresh') control.disabled = state.busy;
  }
}

function createFileItem(view: FileView): HTMLLIElement {
  const { entry } = view;
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.id = entry.recordId;
  const solscan = solscanUrl(NETWORK, 'address', entry.recordId);
  li.innerHTML = `
    <div class="file-head">
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </div>
    <div class="file-status"></div>
    <div class="row">
      <button class="button button-small" type="button" data-action="download">Download</button>
      ${
        entry.shared
          ? ''
          : `<details class="share">
              <summary class="button button-quiet button-small">Share</summary>
              <form class="row share-form">
                <input name="viewer" placeholder="Solana address of a registered wallet" spellcheck="false" autocomplete="off" aria-label="Address to share with" />
                <button class="button button-small" type="submit">Give access</button>
              </form>
              <p class="muted small">Sharing seals the file key to their published key. Revoking stops access through SolaDB, but cannot take back a copy they already opened.</p>
              <ul class="viewers"></ul>
            </details>
            <button class="button button-quiet button-small" type="button" data-action="reclaim">Reclaim deposits</button>
            <button class="button button-quiet button-small button-danger" type="button" data-action="delete">Delete</button>`
      }
      <span class="file-meta">Record ${accountLink(entry.recordId)}${solscan ? ` · ${link(solscan, 'Solscan')}` : ''}</span>
    </div>
    <details class="chunks">
      <summary>Chunks and replicas</summary>
      <ol class="chunk-list"></ol>
    </details>`;
  return li;
}

const STATE_LABEL: Record<ChunkStatus['state'], string> = {
  Pending: 'Writing',
  Hot: 'Hot',
  Cool: 'Cool',
  Closed: 'Closed, rent returned',
};

function fileStatusText(chunks: ChunkStatus[] | undefined): string {
  if (!chunks) return '';
  if (chunks.every((c) => c.state === 'Closed')) return 'Settled';
  if (isCool(chunks)) return 'Replicated';
  if (chunks.some((c) => c.state === 'Pending')) return 'Writing';
  return 'Waiting for replicas';
}

function updateFileItem(li: HTMLLIElement, view: FileView): void {
  const { entry, manifest, chunks } = view;
  const status = fileStatusText(chunks);
  const origin = entry.shared ? `Shared by ${short(entry.owner)}` : 'Yours';

  setText(li, '.file-name', manifest ? displayName(manifest.name) : view.error ? 'Unreadable file' : 'Decrypting…');
  setText(li, '.file-head .file-meta', [manifest ? bytes(manifest.size) : '', origin, status].filter(Boolean).join(' · '));

  const holder = li.querySelector<HTMLElement>('.file-status');
  if (holder) {
    setHtml(
      holder,
      view.error
        ? `<p class="muted" data-text="error"></p>`
        : `<div class="strip" role="img" aria-label="${esc(status)}">${(chunks ?? [])
            .map(
              (c) =>
                `<span class="cell ${c.state === 'Cool' ? 'is-cool' : c.state === 'Closed' ? 'is-closed' : c.state === 'Pending' ? 'is-pending' : ''}" data-replicas="${c.confirmedReplicas}/${c.requiredReplicas}" title="${esc(STATE_LABEL[c.state])}: ${c.confirmedReplicas} of ${c.requiredReplicas} replicas"></span>`,
            )
            .join('')}</div>`,
      (root) => setText(root, '[data-text="error"]', view.error ?? ''),
    );
  }

  const chunkList = li.querySelector<HTMLElement>('.chunk-list');
  if (chunkList) {
    setHtml(
      chunkList,
      (chunks ?? [])
        .map(
          (c, i) => `
          <li>
            <span class="chunk-state">#${i + 1} ${esc(STATE_LABEL[c.state])}</span>
            ${c.state === 'Closed' ? '' : `<span class="muted">${c.confirmedReplicas} of ${c.requiredReplicas} replicas</span>`}
            ${accountLink(c.address)}
            ${c.replicators.length ? `<span class="muted">kept by</span> ${c.replicators.map((r) => accountLink(r)).join(' ')}` : ''}
          </li>`,
        )
        .join('') || '<li class="muted">Loading…</li>',
    );
  }

  const viewers = li.querySelector<HTMLElement>('.viewers');
  if (viewers) {
    setHtml(
      viewers,
      view.viewers === undefined
        ? ''
        : view.viewers.length === 0
          ? '<li class="muted small">Nobody else has access yet.</li>'
          : view.viewers
              .map(
                (v) =>
                  `<li>${accountLink(v)}<button class="button button-quiet button-small" type="button" data-action="revoke" data-viewer="${addr(v)}">Revoke</button></li>`,
              )
              .join(''),
    );
  }

  const downloadButton = li.querySelector<HTMLButtonElement>('[data-action="download"]');
  if (downloadButton) {
    downloadButton.disabled = state.busy || !manifest;
    downloadButton.textContent = state.downloading === entry.recordId ? 'Downloading…' : 'Download';
  }
  const reclaimButton = li.querySelector<HTMLButtonElement>('[data-action="reclaim"]');
  if (reclaimButton) reclaimButton.disabled = state.busy || !chunks || chunks.every((c) => c.state === 'Closed');
  for (const button of li.querySelectorAll<HTMLButtonElement>('[data-action="delete"], [data-action="revoke"]')) {
    button.disabled = state.busy;
  }
}

function renderFooter(): void {
  const input = $<HTMLInputElement>('node-url');
  if (input && document.activeElement !== input) input.value = state.nodeUrl;

  const contracts = $('contracts');
  if (contracts) {
    const program = NETWORK.programId;
    const solscan = solscanUrl(NETWORK, 'address', program);
    setHtml(
      contracts,
      `SolaDB program ${accountLink(program)} on ${esc(NETWORK.name)}${solscan ? ` · ${link(solscan, 'Solscan')}` : ''}`,
    );
  }

  const details = $('replicators');
  const list = $('replicator-list');
  if (details && list) {
    details.hidden = state.replicators.length === 0;
    const summary = details.querySelector('summary');
    const active = state.replicators.filter((r) => r.active).length;
    if (summary) summary.textContent = `${plural(state.replicators.length, 'replicator node')} (${active} active)`;
    setHtml(
      list,
      state.replicators
        .map(
          (r, i) => `
          <li>
            ${accountLink(r.authority)}
            <span class="hex endpoint" data-endpoint="${i}"></span>
            <span class="${r.active ? 'badge is-live' : 'badge'}">${r.active ? 'active' : 'inactive'}</span>
            <span class="muted">${esc(plural(Number(r.confirmations), 'confirmation'))}</span>
          </li>`,
        )
        .join(''),
      (root) => state.replicators.forEach((r, i) => setText(root, `[data-endpoint="${i}"]`, r.endpoint)),
    );
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function fileId(target: HTMLElement): string {
  return target.closest<HTMLElement>('li.file')?.dataset.id ?? '';
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-action]');
  if (!target || (target as HTMLButtonElement).disabled) return;
  const action = target.dataset.action;
  if (action === 'connect') void run(() => connect(target.dataset.wallet ?? ''));
  if (action === 'disconnect') void run(disconnect);
  if (action === 'airdrop') void run(airdrop);
  if (action === 'unlock') void run(unlock);
  if (action === 'upload') void run(upload);
  if (action === 'refresh') void run(refreshFiles);
  if (action === 'download') void run(() => download(fileId(target)));
  if (action === 'reclaim') void run(() => reclaim(fileId(target)));
  if (action === 'delete') void run(() => removeFile(fileId(target)));
  if (action === 'revoke') void run(() => revoke(fileId(target), target.dataset.viewer ?? ''));
});

$('account')?.addEventListener('click', () => {
  const session = state.session;
  if (!session) {
    $('step-identity')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector<HTMLButtonElement>('#wallet-picker button:not(:disabled)')?.focus({ preventScroll: true });
    return;
  }
  navigator.clipboard
    ?.writeText(session.address)
    .then(() => toast('Address copied.'))
    .catch(() => toast(session.address));
});

document.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'file-input') void run(() => chooseFile((target as HTMLInputElement).files?.[0]));
  if (target.id === 'replicas') {
    state.replicas = Number((target as HTMLSelectElement).value) || 1;
    void run(updateQuote);
  }
  if (target.id === 'mode') {
    state.mode = (target as HTMLSelectElement).value as UploadMode;
    void run(updateQuote);
  }
  if (target.id === 'epochs') {
    state.epochs = Number((target as HTMLSelectElement).value) || 12;
    void run(updateQuote);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (form.classList.contains('share-form')) {
    event.preventDefault();
    const viewer = String(new FormData(form).get('viewer') ?? '').trim();
    void run(async () => {
      await share(fileId(form), viewer);
      form.reset();
    });
  }
});

// <details> toggle does not bubble: listen in the capture phase
document.addEventListener(
  'toggle',
  (event) => {
    const details = event.target as HTMLDetailsElement;
    if (details.classList?.contains('share') && details.open) void loadViewers(fileId(details));
  },
  true,
);

$('node-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = ($<HTMLInputElement>('node-url')?.value ?? '').trim().replace(/\/$/, '');
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    toast('Enter an http(s) URL, or leave it empty.', true);
    return;
  }
  state.nodeUrl = url;
  writeSetting('soladb:node', url);
  state.client?.setNodeUrls(nodeUrls());
  toast(url ? `Downloads try ${url} first.` : 'Downloads use the replicators recorded on-chain.');
});

for (const type of ['dragover', 'dragleave', 'drop'] as const) {
  document.addEventListener(type, (event) => {
    const zone = (event.target as HTMLElement).closest?.('#dropzone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.toggle('is-over', type === 'dragover');
    if (type === 'drop' && !state.busy) void run(() => chooseFile((event as DragEvent).dataTransfer?.files?.[0]));
  });
}

// Leaving mid-upload strands the session key's small balance and half-written chunks
window.addEventListener('beforeunload', (event) => {
  if (state.busy && state.progress.length > 0) event.preventDefault();
});

// ── Start ───────────────────────────────────────────────────────────────────

watchWallets((wallets) => {
  state.wallets = wallets;
  render();
  void reconnect();
});
render();
void checkNetwork().then(reconnect);
