#!/usr/bin/env bash
# Build the WASM module from crates/vaultcrdt-wasm and write artifacts into
# this repo's wasm/ directory. Run from the repo root or via `bun run wasm`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/wasm"

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
"$WASM_BINDGEN" --target web \
  --out-dir "$OUT_DIR" \
  target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm

echo "WASM artifacts written to $OUT_DIR"
