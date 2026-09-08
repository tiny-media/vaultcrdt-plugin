# 0004 — Limited Obsidian configuration sync

Status: standing, implemented. Source-checked: 2026-09-08.

## Context

Some configuration is useful across devices, but workspace layout and plugin
state are device-specific and can contain credentials or executable plugin
code. Synchronizing the whole configuration directory would cross that boundary.

## Decision

Sync only these standard `.obsidian/` paths through the blob lane:

| Per-device category | Allowed paths |
| --- | --- |
| Settings | `app.json`, `appearance.json` |
| Styles | `snippets/<name>.css`, `themes/<name>/theme.css`, `themes/<name>/manifest.json` |

Both toggles default OFF. Workspace files and `plugins/**` never sync through
the supported policy, regardless of toggle state. Custom configuration
directory names are not mapped into this lane.

The authoritative allowlist is Rust's `is_obsidian_allowlisted_key` in
[blob_path.rs](../../crates/vaultcrdt-core/src/blob_path.rs).
[src/path-policy.ts](../../src/path-policy.ts) defines categories and
`isCategoryWriteAllowed`. [src/obsidian-sync.ts](../../src/obsidian-sync.ts)
uses adapter raw events and sweeps because these files do not have ordinary
Obsidian `TFile` create/modify events.

Configuration uses whole-file last-writer-wins (LWW), not JSON-field or Loro
merge. [src/blob-downloader.ts](../../src/blob-downloader.ts) deliberately
overwrites category files instead of making ordinary attachment conflict copies.

Enforce current per-device toggles at effect time, not only when work enters
an index or queue. Downloader, uploader and sweep gates cover pending writes,
remote tombstone removal/republish, and upload/reference/delete/rename requests.
Switching OFF blocks subsequent effects; it cannot undo a request already sent.
Switching ON resumes collection of skipped category entries.

## Consequences

- Devices can share settings or style files without sharing plugin state or
  workspace layout; these controls are local preferences, not server ACLs.
- Concurrent settings edits can overwrite one another at whole-file granularity.
- `appearance.json` carries theme/snippet activation (`cssTheme` and
  `enabledCssSnippets`). Thus Settings ON can activate already-installed local
  styles even with Styles OFF. This is a documented trade-off: the styles
  toggle controls file transfer, not all activation state.
- [obsidian-toggle-gates.test.ts](../../src/__tests__/obsidian-toggle-gates.test.ts)
  covers effect-time transitions; `obsidian-sync.test.ts`, `path-policy.test.ts`
  and Rust blob-key tests cover collection and allowed shapes.

## Review hooks

The plugin transfers opaque JSON rather than interpreting Obsidian's activation
fields. Their host-level effect is an Obsidian-format fact documented in
[install-brat.md](../install-brat.md), not a real-device assertion of CI.
Skipped index state also does not distinguish every toggle/quota rejection
reason; effect-time gating does not resolve all resume-policy questions.
