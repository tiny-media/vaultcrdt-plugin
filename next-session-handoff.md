# Session Handoff — Phase B vorbereiten

Datum: 2026-04-07  
Letzter Commit: fcf8667 (v0.2.15)  
Branch: main

---

## Was diese Session gemacht hat

GPT 5.4 hat einen umfassenden Audit in `gpt-audit/` geschrieben (8 Vorschläge). Claude Opus 4.6 hat die Top-3 umgesetzt:

1. **Initial-Sync Content-Hash-Check** — `sync-initial.ts`: VV-Skip prüft jetzt zusätzlich `fnv1aHash(diskContent)` gegen gecachten Hash. Externe Änderungen werden nicht mehr verschluckt.
2. **State-Key Encoding** — `state-storage.ts`: `encodeURIComponent()` statt `__`-Separator. Keine Kollisionen mehr.
3. **Zentrale Path-Policy** — Neue `path-policy.ts` mit `isSyncablePath()`. Angewendet in `main.ts` (5 Handler), `sync-engine.ts` (2 Remote-Handler), `sync-initial.ts` (Downloads + Tombstones).

**Status: alles implementiert, 129 Tests grün, Build sauber. Noch NICHT committed.**

### Untracked neue Dateien
- `src/path-policy.ts`
- `src/__tests__/path-policy.test.ts`
- `gpt-audit/` (kompletter Audit-Ordner)

---

## Nächste Session: Phase B (Items 4, 5, 6)

Detaillierter Plan mit Ist-Zustand, Designentscheidungen und Implementierungsschritten: **`gpt-audit/next-session-phase-b.md`**

### Kurzfassung

| # | Was | Repo | Aufwand | Kern |
|---|-----|------|---------|------|
| 6 | Auth-/Secret-Härtung | vaultcrdt-server | ~45 min | Argon2id statt Klartext, Lazy Migration, generische Fehlermeldungen |
| 4 | Tombstone-Härtung | Server + Plugin | ~60-90 min | 90 Tage Retention, Anti-Resurrection-Guard, `.loro`-Cleanup |
| 5 | WASM-Build-Reproduzierbarkeit | vaultcrdt (Monorepo) | ~30 min | Build-Script, Version-Pinning, Freshness-Check |

### Empfohlener Ablauf

1. **Zuerst committen** was von Phase A noch offen ist (diese Session)
2. Items 5 + 6 können **parallel** bearbeitet werden (verschiedene Repos, null Überlappung)
3. Item 4 danach — einziges Cross-Repo-Item (Server zuerst, dann Plugin)

---

## Wichtige Kontextinfos

- **Einziger User** — kein Backwards-Compat-Zwang, Resets jederzeit möglich
- **Android mtime unzuverlässig** — nie für Caching/Skip-Logik verwenden
- **Server-Repo**: `/home/richard/projects/vaultcrdt-server`
- **Monorepo (WASM)**: `/home/richard/projects/vaultcrdt`
- **wasm-bindgen im Lock**: 0.2.114 (Cargo.toml sagt nur `"0.2"`, soll auf `"=0.2.114"` gepinnt werden)
- **Tombstone-Expiry im Server**: aktuell 7 Tage (`main.rs:22`), soll auf 90
- **Anti-Resurrection-Lücke**: `handlers.rs` ruft `remove_tombstone()` in `sync_push` (Z.186) und `doc_create` (Z.235) auf — jeder Push löscht den Tombstone

---

## Dateien zum Lesen als Einstieg

- `gpt-audit/next-session-phase-b.md` — vollständiger Plan mit Code-Skizzen
- `gpt-audit/claude-response.md` — Bewertung des GPT-Audits, Gewichtungsunterschiede
- `gpt-audit/09-decision-matrix.md` — Gesamtübersicht aller 8 Audit-Punkte
