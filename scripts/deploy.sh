#!/usr/bin/env bash
# Deploy (or upgrade) the SolaDB program, then configure it.
#
#   scripts/deploy.sh devnet          # or mainnet
#
# Needs the Solana CLI (Agave ≥ 4.3) and an `anchor build` (target/deploy/soladb.so).
# Env:
#   DEPLOYER_KEYPAIR   fee payer + upgrade authority (default ~/.config/solana/id.json)
#   PROGRAM_KEYPAIR    keypair of the program address, needed for the first deploy
#                      (default .keys/soladb-program-keypair.json)
#   DEVNET_RPC_URL / MAINNET_RPC_URL   RPC overrides
#   PRIORITY_MICRO_LAMPORTS            compute-unit price for the deploy transactions
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLUSTER=${1:?usage: scripts/deploy.sh devnet|mainnet}
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

case "$CLUSTER" in
  devnet)  RPC=${DEVNET_RPC_URL:-https://api.devnet.solana.com} ;;
  mainnet) RPC=${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com} ;;
  *) echo "unknown cluster $CLUSTER"; exit 1 ;;
esac

DEPLOYER=${DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}
PROGRAM_KEYPAIR=${PROGRAM_KEYPAIR:-$ROOT/.keys/soladb-program-keypair.json}
SO=${SOLADB_SO:-$ROOT/target/deploy/soladb.so}
PROGRAM_ID=$(sed -n 's/^declare_id!("\([^"]*\)");/\1/p' "$ROOT/programs/soladb/src/lib.rs")

[ -f "$SO" ] || { echo "Missing $SO — run anchor build"; exit 1; }
echo "Cluster:   $CLUSTER ($RPC)"
echo "Program:   $PROGRAM_ID ($(stat -c %s "$SO") bytes)"
echo "Deployer:  $(solana-keygen pubkey "$DEPLOYER") — $(solana balance -u "$RPC" -k "$DEPLOYER")"

ARGS=(program deploy "$SO" -u "$RPC" -k "$DEPLOYER" --upgrade-authority "$DEPLOYER")
[ -n "${PRIORITY_MICRO_LAMPORTS:-}" ] && ARGS+=(--with-compute-unit-price "$PRIORITY_MICRO_LAMPORTS")
if solana program show "$PROGRAM_ID" -u "$RPC" >/dev/null 2>&1; then
  echo "Upgrading existing program…"
  ARGS+=(--program-id "$PROGRAM_ID")
else
  [ -f "$PROGRAM_KEYPAIR" ] || { echo "First deploy needs the program keypair at $PROGRAM_KEYPAIR"; exit 1; }
  [ "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" = "$PROGRAM_ID" ] || { echo "$PROGRAM_KEYPAIR is not $PROGRAM_ID"; exit 1; }
  ARGS+=(--program-id "$PROGRAM_KEYPAIR")
fi
solana "${ARGS[@]}"
solana program show "$PROGRAM_ID" -u "$RPC"

cd "$ROOT"
DEPLOYER_KEYPAIR="$DEPLOYER" npx tsx scripts/init.ts "$CLUSTER"
npx tsx scripts/export-idl.ts
