import { address, Address } from '@solana/kit';
import {
  soladbInstructions,
  ConfigAccount,
  ConfigParams,
  fetchAccount,
  pdas,
  ReplicatorAccount,
} from '../sdk/src';
import {
  airdrop,
  clusterArg,
  connect,
  explorerFor,
  loadDeployer,
  loadEnv,
  loadKeypair,
  PROGRAM_ADDRESS,
  sol,
  SOL,
  writeDeployment,
} from './lib/common';

/**
 * Configures a deployed SolaDB program and writes deployments/solana-<cluster>.json.
 * Idempotent: creates the config on first run, then updates it when the
 * pricing variables change; registers replicators that are not registered yet.
 *
 * Usage:
 *   npm run init:devnet        (after scripts/deploy.sh devnet)
 *   npm run init:localnet      (against scripts/localnet.sh)
 *
 * Env (all optional):
 *   DEPLOYER_KEYPAIR             admin = program upgrade authority (default ~/.config/solana/id.json,
 *                                .localnet/admin.json on localnet)
 *   TREASURY_ADDRESS             receives the protocol share (default: the admin)
 *   UPLOAD_BASE_FEE_PER_REPLICA  lamports per replica per chunk (default 10000: covers the confirmation)
 *   UPLOAD_PRICE_PER_MIB         lamports per MiB per replica, pro rata (default 20000 ≈ 0.02 SOL/GiB/replica)
 *   PROTOCOL_FEE_BPS             default 1000 (10 %)
 *   REPLICATION_THRESHOLD_PCT    default 60
 *   REPLICATION_WINDOW_SECONDS   default 604800 (7 days)
 *   EPOCH_SECONDS                blob storage epoch (default 2592000 = 30 days)
 *   PRICE_PER_MIB_EPOCH          lamports per MiB of shard per epoch (default 200 ≈ 0.0002 SOL/GiB/month)
 *   CHALLENGE_WINDOW_SLOTS       slots to answer a storage challenge (default 300, max 450)
 *   CHALLENGE_COOLDOWN_SECONDS   between challenges of one shard (default 3600)
 *   CHALLENGER_BOUNTY_BPS        share of forfeited rewards for reporting a failed challenge (default 1000)
 *   REPLICATOR_KEYPAIR           replicator wallet to register (its address)
 *   REPLICATOR_ADDRESSES         extra comma-separated replicator addresses
 *   REPLICATOR_ENDPOINT          public URL of the node (default http://localhost:3000)
 *   SOLADB_NODE_URLS             public node URLs advertised to SDK users (default REPLICATOR_ENDPOINT)
 */
const main = async () => {
  loadEnv();
  const cluster = clusterArg();
  const { url, rpc, sender } = connect(cluster);
  const admin = await loadDeployer(cluster);
  const ix = soladbInstructions();

  console.log(`Cluster:  ${cluster} (${url})`);
  console.log(`Program:  ${PROGRAM_ADDRESS}`);
  console.log(`Admin:    ${admin.address}`);

  const program = await rpc.getAccountInfo(PROGRAM_ADDRESS, { encoding: 'base64' }).send();
  if (!program.value?.executable) throw new Error(`Program ${PROGRAM_ADDRESS} is not deployed on ${cluster}; run scripts/deploy.sh ${cluster}`);

  if (cluster === 'localnet' && (await rpc.getBalance(admin.address).send()).value < 10n * SOL) {
    await airdrop(rpc, admin.address, 100n * SOL);
  }
  console.log(`Balance:  ${sol((await rpc.getBalance(admin.address).send()).value)}`);

  // ── 1. Config ──────────────────────────────────────────────────────────────
  const params: ConfigParams = {
    treasury: address(process.env.TREASURY_ADDRESS || admin.address),
    baseFeePerReplica: BigInt(process.env.UPLOAD_BASE_FEE_PER_REPLICA || '10000'),
    pricePerMib: BigInt(process.env.UPLOAD_PRICE_PER_MIB || '20000'),
    protocolFeeBps: Number(process.env.PROTOCOL_FEE_BPS || '1000'),
    replicationThresholdPct: Number(process.env.REPLICATION_THRESHOLD_PCT || '60'),
    replicationWindow: BigInt(process.env.REPLICATION_WINDOW_SECONDS || String(7 * 86_400)),
    epochSeconds: BigInt(process.env.EPOCH_SECONDS || String(30 * 86_400)),
    pricePerMibEpoch: BigInt(process.env.PRICE_PER_MIB_EPOCH || '200'),
    challengeWindowSlots: BigInt(process.env.CHALLENGE_WINDOW_SLOTS || '300'),
    challengeCooldown: BigInt(process.env.CHALLENGE_COOLDOWN_SECONDS || '3600'),
    challengerBountyBps: Number(process.env.CHALLENGER_BOUNTY_BPS || '1000'),
  };

  // The treasury must stay rent-exempt to receive small protocol fees
  const minimum = await rpc.getMinimumBalanceForRentExemption(0n).send();
  if ((await rpc.getBalance(params.treasury).send()).value < minimum) {
    throw new Error(`Treasury ${params.treasury} needs at least ${sol(minimum)} to receive fees`);
  }

  const configAddress = await pdas.config();
  const existing = await fetchAccount<ConfigAccount>(rpc, configAddress, 'Config');
  if (!existing) {
    const signature = await sender.send({ feePayer: admin, instructions: [await ix.initialize(admin, params)], label: 'initialize' });
    console.log(`Config initialized (${signature})`);
  } else if (
    existing.data.treasury !== params.treasury ||
    existing.data.baseFeePerReplica !== params.baseFeePerReplica ||
    existing.data.pricePerMib !== params.pricePerMib ||
    existing.data.protocolFeeBps !== params.protocolFeeBps ||
    existing.data.replicationThresholdPct !== params.replicationThresholdPct ||
    existing.data.replicationWindow !== params.replicationWindow ||
    existing.data.epochSeconds !== params.epochSeconds ||
    existing.data.pricePerMibEpoch !== params.pricePerMibEpoch ||
    existing.data.challengeWindowSlots !== params.challengeWindowSlots ||
    existing.data.challengeCooldown !== params.challengeCooldown ||
    existing.data.challengerBountyBps !== params.challengerBountyBps
  ) {
    if (existing.data.admin !== admin.address) throw new Error(`Config admin is ${existing.data.admin}, not ${admin.address}`);
    const signature = await sender.send({ feePayer: admin, instructions: [await ix.updateConfig(admin, params)], label: 'update_config' });
    console.log(`Config updated (${signature})`);
  } else {
    console.log('Config already up to date');
  }
  const config = (await fetchAccount<ConfigAccount>(rpc, configAddress, 'Config'))!.data;
  console.log(
    `Pricing:  ${config.baseFeePerReplica} lamports/replica + ${config.pricePerMib} lamports/MiB, ` +
      `${config.protocolFeeBps / 100}% protocol → ${config.treasury}`,
  );
  console.log(
    `Blobs:    ${config.pricePerMibEpoch} lamports/MiB/epoch, epoch ${config.epochSeconds} s, ` +
      `challenges answered within ${config.challengeWindowSlots} slots, cooldown ${config.challengeCooldown} s`,
  );

  // ── 2. Replicators ─────────────────────────────────────────────────────────
  const endpoint = process.env.REPLICATOR_ENDPOINT || 'http://localhost:3000';
  const replicators = new Set<Address>(
    (process.env.REPLICATOR_ADDRESSES ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => address(a)),
  );
  if (process.env.REPLICATOR_KEYPAIR) replicators.add((await loadKeypair(process.env.REPLICATOR_KEYPAIR)).address);

  const registered: { authority: string; endpoint: string }[] = [];
  for (const authority of replicators) {
    const current = await fetchAccount<ReplicatorAccount>(rpc, await pdas.replicator(authority), 'Replicator');
    if (current) {
      console.log(`Replicator ${authority} already registered (${current.data.endpoint}, active=${current.data.active})`);
      registered.push({ authority, endpoint: current.data.endpoint });
      continue;
    }
    const signature = await sender.send({
      feePayer: admin,
      instructions: [await ix.registerReplicator(admin, authority, endpoint)],
      label: `register replicator ${authority}`,
    });
    console.log(`Registered replicator ${authority} → ${endpoint} (${signature})`);
    registered.push({ authority, endpoint });
  }

  // ── 3. Persist ─────────────────────────────────────────────────────────────
  const programData = await pdas.programData();
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const nodes = (process.env.SOLADB_NODE_URLS ?? (registered.length ? endpoint : ''))
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const file = writeDeployment({
    cluster,
    rpcUrl: url,
    programId: PROGRAM_ADDRESS,
    programDataAddress: programData,
    upgradeAuthority: admin.address,
    configAddress,
    deploySlot: Number(slot),
    deployedAt: new Date().toISOString(),
    pricing: {
      treasury: config.treasury,
      baseFeePerReplicaLamports: config.baseFeePerReplica.toString(),
      pricePerMibLamports: config.pricePerMib.toString(),
      protocolFeeBps: config.protocolFeeBps,
      replicationThresholdPct: config.replicationThresholdPct,
      replicationWindowSeconds: Number(config.replicationWindow),
      epochSeconds: Number(config.epochSeconds),
      pricePerMibEpochLamports: config.pricePerMibEpoch.toString(),
      challengeWindowSlots: Number(config.challengeWindowSlots),
      challengeCooldownSeconds: Number(config.challengeCooldown),
      challengerBountyBps: config.challengerBountyBps,
    },
    replicators: registered,
    nodes,
    explorer: explorerFor(cluster),
  });
  console.log(`\nDeployment written to ${file}`);
  console.log('Next: npm run export-idl   (refresh the SDK deployments)');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
