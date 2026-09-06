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
WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
if ! command -v "$WASM_BINDGEN" >/dev/null 2>&1; then
  if [ -x "$HOME/.cargo/bin/wasm-bindgen" ]; then
    WASM_BINDGEN="$HOME/.cargo/bin/wasm-bindgen"
  else
    echo "wasm-bindgen CLI not found; install exact project version with:" >&2
    echo "  cargo install wasm-bindgen-cli --version 0.2.128 --locked" >&2
    exit 127
  fi
fi
cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release
# Flags must match scripts/build-wasm.sh exactly, or this check reports drift
# that is really a flag mismatch.
"$WASM_BINDGEN" --target web \
  --omit-default-module-path \
  --remove-name-section \
  --remove-producers-section \
  --out-dir "$TMPDIR" \
  target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm

if diff -r "$TMPDIR" "$PLUGIN_WASM" >/dev/null; then
  echo "OK: committed WASM artifacts are fresh"
else
  echo "STALE: committed WASM artifacts differ from a fresh build" >&2
  diff -r "$TMPDIR" "$PLUGIN_WASM" || true
  exit 1
fi
