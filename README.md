# VaultCRDT Plugin

An Obsidian plugin that synchronises vault notes across devices via a self-hosted server. Synchronisation uses Conflict-free Replicated Data Types (CRDT) via the [Loro](https://loro.dev) library, which allows concurrent edits from multiple clients to be merged without data loss.

This plugin does not connect to any cloud service. It requires a running instance of [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server) that you operate yourself.

## Status

Pre-release (0.2.x). The protocol and storage format may change between versions. Not yet listed in the Obsidian community plugin directory.

## Requirements

- Obsidian 1.12 or later (tested with 1.8.9+)
- A running instance of vaultcrdt-server with a valid API key

## Installation

Manual installation until the plugin is accepted in the community directory:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/tiny-media/vaultcrdt-plugin/releases/latest).
2. Create a folder at `<your-vault>/.obsidian/plugins/vaultcrdt/`.
3. Place both files in that folder.
4. Restart Obsidian and enable the plugin under Settings > Community plugins.

## Configuration

Open Settings > VaultCRDT and set:

- **Server URL** — WebSocket URL of your vaultcrdt-server instance, e.g. `wss://your-server.example.com`
- **Vault ID** — identifier for this vault on the server
- **Vault Secret** — shared secret for this vault (must be identical on every device)

## Sync Modes

On first connect, a modal prompts you to choose how the initial sync should proceed:

| Mode | Behaviour |
|---|---|
| Pull | Downloads all documents from the server. Local files not on the server are not uploaded. |
| Push | Uploads all local documents to the server. Remote documents not present locally are not downloaded. |
| Merge | Bidirectional: downloads remote documents and uploads local documents. CRDT merge resolves concurrent edits. |

After the initial sync, all modes behave identically: edits are synchronised bidirectionally in real time.

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

The WASM module (`wasm/`) is pre-built and committed to the repository. To rebuild it from the Rust source, see [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server).

## Tests

```
bun run test
```

## License

GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
