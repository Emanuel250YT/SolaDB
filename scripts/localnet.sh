#!/usr/bin/env bash
# Local validator with SolaDB deployed; the upgrade authority (= admin that can
# initialize the config) is .localnet/admin.json.  Extra args go to
# solana-test-validator.
#
#   anchor build && scripts/localnet.sh
#   SOLADB_SO=path/to/soladb.so SOLADB_LEDGER=/tmp/ledger scripts/localnet.sh
#
# The test validator prunes old slots by default, and chunks are rebuilt from
# transaction history, so this keeps far more of it (SOLADB_LEDGER_SHREDS).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/.localnet
mkdir -p "$DIR"
[ -f "$DIR/admin.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$DIR/admin.json"
PROGRAM_ID=$(sed -n 's/^declare_id!("\([^"]*\)");/\1/p' "$ROOT/programs/soladb/src/lib.rs")
SO=${SOLADB_SO:-$ROOT/target/deploy/soladb.so}
LEDGER=${SOLADB_LEDGER:-$DIR/ledger}
echo "SolaDB $PROGRAM_ID from $SO, admin $(solana-keygen pubkey "$DIR/admin.json")"
exec solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --limit-ledger-size "${SOLADB_LEDGER_SHREDS:-50000000}" \
  --upgradeable-program "$PROGRAM_ID" "$SO" "$DIR/admin.json" "$@"
