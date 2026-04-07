#!/usr/bin/env bash
# Verify the committed wasm/ artifacts match a fresh build from crates/.
# Exits non-zero on drift — use as a pre-release / CI guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_WASM="$ROOT/wasm"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$ROOT"
cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web \
  --out-dir "$TMPDIR" \
  target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm

if diff -r "$TMPDIR" "$PLUGIN_WASM" >/dev/null; then
  echo "OK: committed WASM artifacts are fresh"
else
  echo "STALE: committed WASM artifacts differ from a fresh build" >&2
  diff -r "$TMPDIR" "$PLUGIN_WASM" || true
  exit 1
fi
