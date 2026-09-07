# VaultCRDT recovery and conflict runbook

Preserve content first, then investigate. Do not share passwords, device keys, admin tokens, invite links or unchecked logs.

## Ground rules

1. Keep Obsidian open on the affected device. Avoid deleting files while the situation is unclear.
2. Copy important local text into a new Markdown file with a different name.
3. Check Trash and the other synced device before permanently deleting anything.
4. For support, record the device, operating system, time, affected path and approximate action. Share paths only if they contain no sensitive information.

## Conflict copies

A file such as `Note (conflict 2026-06-06).md` means the plugin preserved text it could not safely merge or replace. The conflict inbox links to the preserved copy. Ordinary concurrent note edits with shared CRDT history can merge without a conflict file; independently created notes, external edits or missing local state may need a copy.

1. Open the original and the conflict copy.
2. Compare their contents and move the text you want to keep into the intended note.
3. Delete the conflict copy only after reviewing it.
4. Open Obsidian on a second device and check that the resolved content arrives.

Compressed Excalidraw Markdown files (`*.excalidraw.md`) also get conflict copies for detected concurrent changes rather than merging compressed drawing payloads. This does not add support for standalone `.excalidraw` files or Canvas files.

Attachments are whole files, not text CRDTs. Before downloading a remote replacement, the plugin can preserve a differing local attachment as a conflict copy. Do not assume this provides a complete attachment version history. Optional `.obsidian` files use last-write-wins without conflict copies; back them up before enabling their sync.

## A note was deleted on another device

Remote deletion normally moves the local note to Trash. If the plugin finds unsynced or differing local content, it keeps the note and can recreate it on the server; the inbox records the outcome.

A `deleted on another device` refusal means the server has a tombstone for that path and rejected a local push. The plugin attempts to rename the local note to `<name> (deleted-remote).md` and sync it under that new name; the original path stays deleted.

If the rename fails or the warning appears without a preserved copy:

1. Stop editing the affected path and save important text under a new filename.
2. Check local Trash.
3. Open the other device and let it sync.
4. Inspect the preserved note before deliberately recreating anything at the old path.

## A file changed outside Obsidian

Changes from an external editor or git are observed while Obsidian is running with the plugin active. Changes made while it is closed may be missed by the startup fast path when the server version is unchanged.

1. Preserve the current text before troubleshooting.
2. Open the affected note in Obsidian and make an edit; the next push reconciles its current contents.
3. Let external tools write only while Obsidian is running, and verify the result on another device.
4. Do not run a second sync service on the same vault.

## A note is missing on another device

1. Open Obsidian on the receiving device and keep it in the foreground.
2. Check the network connection and **Open status panel**.
3. Check the connection and protocol status in VaultCRDT settings.
4. Leave the sending device open until its pending changes have synced.
5. If the note was deleted, check Trash and the conflict inbox on both devices.
6. If it remains missing, record the path, devices, time and last action before contacting support.

## Missing attachments on mobile

Mobile downloads attachments on demand from the opened note's links and embeds. A note arriving does not mean every attachment in the vault is already on disk. Desktop downloads pending attachments eagerly; enabled `.obsidian` settings and styles download eagerly on both device classes.

1. Check that the attachment is a [supported format within its cap](install-brat.md#attachments) and has uploaded from the source device.
2. Open the note that links to it and keep Obsidian in the foreground while it downloads.
3. If needed, reopen the note after catch-up. The plugin also rechecks the active note as its metadata changes.
4. Use an unambiguous vault-relative attachment path. A basename shared by several attachments is not enough for mobile lookup.
5. Check server blob support and connectivity. Do not delete local originals to force a download.

## Settings or themes did not arrive

Check the [exact allowlist and per-device toggles](install-brat.md#optional-obsidian-settings-and-styles). Both categories default to off. A custom configuration directory, nested snippet folders, workspace state and plugin settings are not eligible. Files above 2 MiB are not uploaded.

Concurrent settings/style edits are whole-file last-write-wins, not merged by JSON key. Restore desired settings from a known-good backup if a concurrent change replaced them; no conflict copy is made for these files.

## Server restore

A restored server may be older than its clients. Devices returning after a long offline period may offer older content or deletions.

1. Pause simultaneous editing across devices.
2. After the restore, open one known-good device and let it sync.
3. Bring the remaining devices online one at a time and inspect the result.
4. Preserve unexpected conflict copies or tombstone-related files before cleanup.
5. Discuss the restore with the server operator; use the server repository's backup and restore instructions.

## Vault copied or restored from backup

Copying a complete vault, including hidden plugin settings, can duplicate its peer identity and device credentials. Two devices using the same peer identity can disrupt operation ordering.

1. On exactly one device — the copied or restored one — open **Settings → VaultCRDT → Developer**.
2. Under **Reset device identity**, select **Reset identity** and confirm.
3. The device receives a fresh peer ID. Notes and local CRDT history remain intact.

This resets the CRDT peer identity, not the authentication device key. For a new device, prefer a fresh plugin setup and invite rather than copying plugin credentials. If copied credentials need replacing, ask the operator about issuing a new invite and retiring the old credential.

## Status and diagnostics

Use **Open status panel** for connection and sync activity, and **Open conflict inbox** to review conflicts, deletions and failures. These command-palette entries also work on phones. Routine success notifications stay quiet; issues are retained for review.

Under **Settings → VaultCRDT → Developer**, **Copy diagnostics report** copies a redacted report. The command **Export diagnostics bundle** writes a diagnostic bundle. Review diagnostics before sharing, and send only what is needed.

Useful support information:

- Device and operating system.
- Time and timezone.
- Affected path, if safe to disclose.
- Whether the issue followed startup, editing, deletion, renaming, offline use or a restore.
- A screenshot of the relevant status or inbox entry, with private details removed.

Do not send vault secrets, device keys, admin tokens, authentication tokens, invite QR codes or full logs without review.
