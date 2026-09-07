# Installing VaultCRDT via BRAT

Community-directory submission is in progress. BRAT installs the plugin directly from GitHub.

## Prerequisites

- Obsidian 1.12.0 or later on desktop, Android or iOS, with a vault open.
- A VaultCRDT server operated by you or someone you trust. There is no public hosting service.
- An invite link from your operator or an already-connected device; for manual setup, a server URL, vault ID and vault secret.

The server can read synced content: there is no end-to-end encryption yet. Use HTTPS. Server deployment and first-vault setup are covered in the [server repository](https://github.com/tiny-media/vaultcrdt-server).

Back up your vault before enabling sync. Do not use a second sync service on the same vault.

## Install

1. Open **Settings → Community plugins**. If restricted mode is on, select **Turn on community plugins**.
2. Select **Browse**, search for **BRAT**, install and enable it.
3. In BRAT options, select **Beta plugin list → +**, enter `tiny-media/vaultcrdt-plugin`, then select **Add Plugin**.
4. Enable **VaultCRDT** under Community plugins.

The same steps are available in VaultCRDT's add-device help.

## Connect

### Invite link or QR

1. On an already-connected device, open **Settings → VaultCRDT → Add another device → Add device**, or run **Invite a device** from the command palette.
2. On the new device, open the setup link or scan the QR code. You can also paste it into the **Invite link** field in setup and select **Use link**.
3. Check the server and vault shown, then select **I trust this server - Join**.

Invites are single-use and expire; the invite screen shows their approximate validity. A successful redemption gives the new device its own device key, stored locally in plugin settings. It does not need the shared vault secret. Treat invite links, QR codes and device keys as credentials; do not share them publicly.

For the first device, ask the server operator to issue an invite. If an invite expires or was already used, request another. Servers without invite support provide only a setup link that prefills the form; these connections still require the vault secret separately.

### Manual setup

Expand **Enter server details by hand** in setup:

| Field | Value |
|---|---|
| **Server** | Operator-supplied URL, such as `https://sync.example.com` |
| **Vault ID** | Exact server vault ID: lowercase letters, numbers and hyphens |
| **Vault secret** | The vault's shared secret, supplied securely by the operator |

Select **Connect**. For registering a new vault through the plugin, the **Creating a new vault?** section accepts a one-time admin token; ordinary joining does not need it. Prefer the operator's server-side vault setup instructions.

Initial sync pulls notes when only the server has content, uploads when only the local vault has content, and merges when both have notes. Keep Obsidian open until sync completes.

### Changing a connection

Use **Settings → VaultCRDT → Join a different vault → Open setup…** to run setup again. Switching vaults clears local CRDT sync state, not the Markdown files. A setup link replacing an existing connection asks for confirmation and clears local sync state. Back up first: remaining local notes can be uploaded into the new vault.

Editing the server URL in settings resets the device key and connection state. A device that joined by invite may need a new invite for the changed connection.

## Attachments

Attachments use a separate whole-file sync lane, not text CRDT merging. The server must support the blob feature.

| Type | Extensions | Per-file cap |
|---|---|---|
| Images | `jpg`, `jpeg`, `png`, `webp`, `gif`, `heic`, `heif`, `avif`, `svg` | 10 MiB |
| PDF | `pdf` | 10 MiB |
| Audio | `mp3`, `m4a`, `ogg`, `oga`, `opus`, `flac`, `wav`, `webm`, `3gp` | 25 MiB |

Files above these caps stay local. SVGs are sanitised before upload; changed sanitised bytes are also written back to the originating file. Sync eligibility does not guarantee that every device can preview or play a format.

Desktop downloads pending attachments eagerly. Mobile downloads attachments linked or embedded in the opened note rather than downloading the entire attachment collection. The active note is checked again after catch-up and relevant metadata changes. Keep Obsidian in the foreground; background sync is not guaranteed. See [missing attachments](recovery-runbook.md#missing-attachments-on-mobile) if a link remains unavailable.

## Optional Obsidian settings and styles

Under **Settings → VaultCRDT → Sync**, both toggles default to off and apply independently on each device. Enable the desired category on each device that should send and receive it.

| Toggle | Exact allowlist |
|---|---|
| **Keep app settings the same on all devices** | `.obsidian/app.json`, `.obsidian/appearance.json` |
| **Carry themes & CSS snippets over** | `.obsidian/snippets/<name>.css`, `.obsidian/themes/<theme>/theme.css`, `.obsidian/themes/<theme>/manifest.json` |

Snippet files must be directly inside `snippets`; theme files must be directly inside a single theme folder. Each file has a 2 MiB cap. The standard `.obsidian` folder name is required; a custom configuration directory is not synced.

These files use whole-file last-write-wins: concurrent changes keep one side, without JSON-key merging or conflict copies. Enabled category files download eagerly on both desktop and mobile. Turning a category off stops its sync without deleting local files.

Workspace state (`workspace.json`, `workspace-mobile.json`) and `.obsidian/plugins/` are always excluded. Plugin binaries, settings and secrets are not carried to other devices. No other configuration files are allowlisted.

## Settings and status

- **Connection:** server, reachability, vault secret or device-key authentication status, device name, add-device and reconfiguration actions.
- **Sync:** status bar indicator, the two optional configuration categories and **Run full sync**.
- **About:** plugin/server details, documentation and the trust notice.
- **Developer** (collapsed): diagnostics, read-only timing constants and caps, protocol status, IDs, storage/device information and identity reset.

Use **Open status panel** and **Open conflict inbox** from the command palette on any device, including phones without a status bar. For conflict copies, deletions and restore situations, follow the [recovery runbook](recovery-runbook.md).

## Keeping VaultCRDT up to date

BRAT checks for updates automatically. To check manually, use **Settings → BRAT → Check for updates**. The plugin and server must use compatible protocols; a mismatch prevents connection rather than attempting sync.

## Building from source

Requires [Bun](https://bun.sh):

```sh
bun install
bun run build
bun run test
```

The Rust/WASM module is committed in `wasm/` and embedded in `main.js` by the build. A normal frontend build does not need Rust. To rebuild the core from `crates/`, use `bun run wasm` with Rust stable, the `wasm32-unknown-unknown` target and the `wasm-bindgen-cli` version pinned in `Cargo.toml`. Use `bun run wasm:check` to verify the committed output.
