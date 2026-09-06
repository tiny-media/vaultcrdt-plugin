# VaultCRDT Plugin

An Obsidian plugin that synchronises Markdown notes between your devices through a server you run yourself. Merging is done with CRDTs via the [Loro](https://loro.dev) library, so concurrent edits from several devices combine without losing text. The server is a small Rust program in a companion repository, [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server). The intended scale is a few people — friends and family — not a public service.

No cloud service is involved. The plugin talks only to the server URL you configure.

## What works today

- Live sync of `.md` notes over a persistent WebSocket connection while Obsidian is open.
- Offline edits are kept locally and merged when the connection returns.
- Initial sync on a new device: pull if the server has notes, push if the server is empty, merge if both sides have notes.
- Two devices creating the same note independently produce a conflict copy named `<name> (conflict <date>).md` rather than one side winning silently.
- A note deleted on another device while it has unsynced local edits is kept and re-created on the server at the next sync.
- A note whose server copy is tombstoned is renamed to `<name> (deleted-remote).md` and synced under the new name.
- Startup never overwrites local text that the plugin cannot account for; such text goes to a conflict copy first.
- `Export diagnostics bundle` command: redacted settings, server health, recent warnings and errors, state counts. The vault password is checked to be absent before the file is written.
- Protocol version handshake: a mismatch between plugin and server closes the connection with a clear message instead of misbehaving.
- Reset device identity (Settings → Advanced) for vaults that were copied or restored from a backup.

## Limits

- Markdown notes only. Images, PDFs, Canvas, Excalidraw, `.txt` and other files are ignored.
- No end-to-end encryption. Data travels over TLS (WSS) and is stored on the server in a form the operator can read. Use only a server operator you trust.
- Nothing inside `.obsidian/` is synchronised. Each device keeps its own settings, themes and plugins.
- Changes made by other tools (git, Syncthing, an external editor) are picked up only while Obsidian is open with the plugin active. Do not run a second sync tool on the same vault.
- Mobile: sync runs while Obsidian is in the foreground. Background sync is not guaranteed.
- Plugin and server are released together. During the beta a plugin version expects a matching server version; the settings screen shows whether the protocol matches.
- Not in the Obsidian community plugin directory. Install goes through BRAT.

## Requirements

- Obsidian 1.12 or later (desktop, Android, iOS).
- A running [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server) and its server URL, vault name and password.

## Install

Install with BRAT from `https://github.com/tiny-media/vaultcrdt-plugin`. Step-by-step instructions, including first setup and adding a second device, are in [docs/install-brat.md](docs/install-brat.md).

Make a backup of the vault folder before enabling the plugin on a vault you care about.

Server setup is described in the [vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server) repository.

## Network and privacy

The plugin connects only to the server URL you configure yourself. It is used for one purpose: synchronising your notes between your devices. The plugin collects no analytics and sends no telemetry, and it contacts no other service.

Note content is stored on that server without end-to-end encryption, so whoever operates the server can read your notes in plaintext. Use a server you trust and an `https://` URL, so the traffic between your devices and the server is encrypted in transit.

## When something goes wrong

- Conflict copies, `deleted on another device` notices, missing files, server restores and duplicated vaults are covered in the [recovery runbook](docs/recovery-runbook.md). First rule: save the text you care about under a new name, then investigate.
- Run the command `Export diagnostics bundle` (command palette) and attach the file when asking for help. It contains no password. Do not send raw logs or credentials.

## Building from source

Requires [Bun](https://bun.sh).

```
bun install
bun run build
bun run test
```

The WASM module in `wasm/` is committed, so the build does not need a Rust toolchain. To rebuild it from `crates/`, use `bun run wasm` (Rust stable with the `wasm32-unknown-unknown` target and the `wasm-bindgen-cli` version pinned in `Cargo.toml`); `bun run wasm:check` verifies the committed output.

## Status

Beta, version 0.4.x. Tested on four devices by the author; tests across more devices are ongoing. The protocol and storage format may still change between versions but shouldn't until Version 2.

LLM-based agents are used for a substantial part of the coding, testing and maintenance.

## Version 2 Plans

End-to-End Encryption optional.
Support for some image formats and pdf (no svg, no video).
Support for some audio formats.

## License

GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
