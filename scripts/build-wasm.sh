#!/usr/bin/env bash
# Build the WASM module from crates/vaultcrdt-wasm and write artifacts into
# this repo's wasm/ directory. Run from the repo root or via `bun run wasm`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/wasm"

cd "$ROOT"
cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web \
  --out-dir "$OUT_DIR" \
  target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm

echo "WASM artifacts written to $OUT_DIR"
