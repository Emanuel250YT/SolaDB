import { address } from '@solana/kit';
import { transferSol } from '../sdk/src';
import { clusterArg, connect, loadDeployer, loadEnv, loadKeypair, sol, SOL } from './lib/common';

/**
 * Tops up the replicator wallet so it can pay for its confirmations
 * (5 000 lamports each; rewards are paid back in the same transaction).
 *
 * Usage: npm run fund-replicator:devnet
 * Env:   REPLICATOR_KEYPAIR or REPLICATOR_ADDRESS, REPLICATOR_MIN_BALANCE_SOL (default 0.2)
 */
const main = async () => {
  loadEnv();
  const cluster = clusterArg();
  const { rpc, sender } = connect(cluster);
  const funder = await loadDeployer(cluster);
  const target = process.env.REPLICATOR_ADDRESS
    ? address(process.env.REPLICATOR_ADDRESS)
    : (await loadKeypair(process.env.REPLICATOR_KEYPAIR ?? '.keys/devnet-replicator.json')).address;
  const wanted = BigInt(Math.round(Number(process.env.REPLICATOR_MIN_BALANCE_SOL ?? '0.2') * Number(SOL)));

  const balance = (await rpc.getBalance(target).send()).value;
  console.log(`Replicator ${target}: ${sol(balance)}`);
  if (balance >= wanted) {
    console.log('Already funded');
    return;
  }
  const amount = wanted - balance;
  const signature = await sender.send({ feePayer: funder, instructions: [transferSol(funder, target, amount)], label: 'fund replicator' });
  console.log(`Sent ${sol(amount)} from ${funder.address} (${signature})`);
  console.log(`Balance now ${sol((await rpc.getBalance(target).send()).value)}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
