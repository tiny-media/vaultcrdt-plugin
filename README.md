# VaultCRDT Plugin

VaultCRDT synchronises Markdown notes between Obsidian vaults on desktop and mobile. You can edit offline; edits merge when devices reconnect. When text cannot be safely merged, the plugin preserves it in a `… (conflict …).md` copy and adds an inbox entry rather than silently discarding it.

It also syncs supported images (including SVG, sanitised on the originating device), PDFs and audio. App settings, themes and CSS snippets can optionally sync through per-device toggles, off by default. A status panel shows sync activity; a quiet-mode inbox keeps conflicts and other items for review.

**Requirements:** an Obsidian vault, Obsidian 1.12.0 or later, and a VaultCRDT server, self-hosted by you or hosted by someone you trust.

**Limits:**

- No end-to-end encryption yet: the server sees note text. This is a trusted-operator model; use HTTPS for encryption in transit.
- No hosting service is provided and there is no public cloud service; run the server or ask someone you trust to run it.
- Attachments above 10 MiB for images/PDFs or 25 MiB for audio stay local. Unsupported file types, such as Canvas and `.txt`, do not sync.
- Obsidian settings outside the exact allowlist do not sync; plugin settings, plugin secrets and workspace state are excluded.
- Mobile sync runs while Obsidian is in the foreground; background sync is not guaranteed. Do not run another sync service on the same vault.

## Install

Community-directory submission is in progress. Install with BRAT:

1. Back up your vault. In Obsidian → **Settings → Community plugins**, turn off restricted mode.
2. Browse for **BRAT**, install it and enable it.
3. In BRAT options, use **Beta plugin list → +**, enter `tiny-media/vaultcrdt-plugin`, and select **Add Plugin**.
4. Enable **VaultCRDT** in Community plugins.

See the [installation guide](docs/install-brat.md) for setup and update instructions.

## Connect

**Invite link or QR (recommended):** on an already-connected device, open **Settings → VaultCRDT → Add another device → Add device**. On the new device, open the link or scan the QR code; alternatively paste the link into setup and select **Use link**. Check the server and vault, then select **I trust this server - Join**. A single-use invite issues a device key; the additional device does not need the shared vault secret. Your server operator can also issue an invite for the first device.

**Manual setup:** expand **Enter server details by hand**, enter the server URL, vault ID and vault secret supplied by your operator, then select **Connect**.

Initial sync pulls server notes, uploads local notes, or merges when both sides have content. See [connection details](docs/install-brat.md#connect) before changing an existing connection.

## Messages and conflict files

The number next to the VaultCRDT ribbon icon counts entries in the review inbox — things that deserve a look, not necessarily errors. Entries can include conflict copies, deletion notices and sync failures. When the inbox is empty, a dot means VaultCRDT is offline; a number shows inbox entries whether online or offline.

**Why a file is called `Note (conflict 2026-06-06).md`:** a conflict copy preserves content the plugin could not safely merge or replace. This can happen with independently created notes, changes made outside Obsidian, or missing local sync data. Ordinary simultaneous text edits usually merge automatically. The original note keeps its name; the preserved text gets the conflict name. The copy is kept for you to review — conflict copies are not a version history, they appear only when merging is unsafe.

**How to resolve one:**

1. Open the inbox (command palette: *Open conflict inbox*).
2. Open the conflict copy and the original note. For some entries found at startup, the button opens only the conflict copy — look in the same folder for the filename without ` (conflict …)`, keeping the file extension.
3. Read both, and copy anything you want to keep into the original note. For drawings or attachments, compare the files themselves rather than copying text.
4. After reviewing the result, delete the conflict copy. Check Obsidian's deleted-file setting first if you want to use Trash. The inbox entry clears when the file is deleted — dismiss only removes the notice; a remaining conflict file will be listed again at startup.
5. Keep Obsidian open on both devices until syncing finishes, then check the original note on the other device.

If conflicts appear repeatedly for the same note without a cause you recognise, see the [recovery runbook](docs/recovery-runbook.md) before deleting anything.

**A note on Obsidian's built-in Sync:** the red crossed-out sync icon some
users see belongs to Obsidian's own paid *Sync* core plugin, not to VaultCRDT.
Switch it off under **Settings → Core plugins → Sync** and the icon (and its
error message) disappears.

## Keyword overview

- **Offline-first:** local edits merge on reconnect; [recovery and external edits](docs/recovery-runbook.md).
- **CRDT:** [Loro](https://loro.dev) in a Rust/WASM core with a TypeScript frontend; one `main.js` embeds the WASM module.
- **Conflict copies:** preserved text and an inbox entry for review; [resolving conflicts](docs/recovery-runbook.md#conflict-copies).
- **Device keys:** invite-based authentication without distributing the vault secret; [onboarding](docs/install-brat.md#connect).
- **Attachments lane:** whole-file sync separate from note CRDTs; [formats, caps and mobile downloads](docs/install-brat.md#attachments).
- **Per-device settings sync:** two opt-in categories with an exact allowlist; [settings and styles](docs/install-brat.md#optional-obsidian-settings-and-styles).
- **Quiet-mode inbox:** review issues without routine success popups; [status and diagnostics](docs/recovery-runbook.md#status-and-diagnostics).
- **Source build:** Bun builds the committed WASM output; [build commands](docs/install-brat.md#building-from-source).

## Server

Deployment, TLS and backups are documented in [tiny-media/vaultcrdt-server](https://github.com/tiny-media/vaultcrdt-server). The container image is `ghcr.io/tiny-media/vaultcrdt-server`; use a release compatible with the plugin's protocol. Protocol mismatches prevent connection and are shown in settings.

## License

GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
