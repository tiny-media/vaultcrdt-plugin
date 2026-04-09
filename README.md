# VaultCRDT Plugin

An Obsidian plugin that synchronises vault notes across devices via a self-hosted server. Synchronisation uses Conflict-free Replicated Data Types (CRDT) via the [Loro](https://loro.dev) library, which allows concurrent edits from multiple clients to be merged without data loss.

This plugin does not connect to any cloud service. It requires a running instance of [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server) that you operate yourself.

## Status

Pre-release (0.3.x). The protocol and storage format may change between versions. Not yet listed in the Obsidian community plugin directory.

## Requirements

- Obsidian 1.12 or later
- A running instance of [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server)

## Installation

Install via **BRAT** (recommended) — see [docs/install-brat.md](docs/install-brat.md) for step-by-step instructions.

Or install manually:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/tiny-media/vaultcrdt-plugin/releases/latest).
2. Create a folder at `<your-vault>/.obsidian/plugins/vaultcrdt/`.
3. Place both files in that folder.
4. Restart Obsidian and enable the plugin under Settings > Community plugins.

## Setup

On first launch, a Setup screen asks for three things:

- **Server** — URL of your VaultCRDT server (e.g. `https://sync.example.com`)
- **Vault Name** — identifies this vault on the server (e.g. `family-notes`)
- **Password** — shared password for this vault (same on every device)

Your server admin provides these details. The plugin verifies the credentials before connecting.

## Initial sync

The first sync is fully automatic:

| Situation | Behaviour |
|---|---|
| Fresh device, server has notes | Downloads all notes from the server (pull) |
| Server empty, device has notes | Uploads all local notes to the server (push) |
| Both have notes | Bidirectional merge — CRDT resolves concurrent edits |

After the initial sync, all changes are synchronised bidirectionally in real time.

## Conflict handling

When two clients diverge without a shared CRDT history (e.g. one client is offline for a long time and the local state is cleared), the plugin creates a conflict copy rather than silently overwriting. The conflict file is named `<original> (conflict <date>).md` and both versions are preserved.

## What it does not do

- End-to-end encryption. Data is transmitted in plaintext over the WebSocket connection. Use TLS (WSS) on the server to encrypt data in transit.
- Binary file sync. Only Markdown notes and text files are synchronised.

## Network usage

This plugin establishes a persistent WebSocket connection to the server URL you configure. It transmits the content of your vault notes to that server. No data is sent to any third party. The server you configure is solely under your control.

## Building from source

Requires [Bun](https://bun.sh).

```
bun install
bun run build
```

The WASM module (`wasm/`) is pre-built and committed to the repository, so `bun run build` works without a Rust toolchain. The Rust CRDT engine now lives in this repo under `crates/` — to rebuild the WASM artifacts from source:

```
bun run wasm         # rebuild wasm/ from crates/
bun run wasm:check   # verify committed wasm/ matches a fresh build
```

This requires Rust (stable) with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the version pinned in `Cargo.toml`.

## Tests

```
bun run test
```

## License

GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
