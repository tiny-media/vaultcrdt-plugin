# Next Session — VaultCRDT Stand 2026-03-26 (v0.2.13)

## TL;DR für den nächsten Agenten

**Startup-Typing-Bug (v0.2.8–v0.2.12) ist gefixt in v0.2.13.** User kann auf Android sofort tippen, Text bleibt erhalten, Server-Änderungen werden chirurgisch reingemerged.

**Lösung:** Ansatz C — Surgical Diffs via `import_and_diff` + `applyDiffToEditor(skipFallback=true)` statt `writeToVault(setValue)` für das aktive Editor-Doc. Getestet auf Android + Laptop, funktioniert.

---

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.13 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
| Server | v0.2.3 | `/home/richard/projects/vaultcrdt-server/` (GitHub: tiny-media/vaultcrdt-server) |
| Fleet | — | `/home/richard/fleet/` (Gitea: git.fryy.de/richard/fleet) |

Server deployed auf `home` via Docker Compose, erreichbar unter `https://obsidian-sync.hyys.de`.

## Aktive Vaults

| Vault | Pfad | peerId | vaultId |
|-------|------|--------|---------|
| vault-a (Test) | `~/vault-a/` | `1` | `testvaults-a-b` |
| vault-b (Test) | `~/vault-b/` | `2` | `testvaults-a-b` |
| richardsachen (Laptop) | `~/CloudOrdner/Obsidian/richardsachen/` | `richardlaptop` | `richardsachen` |
| richardsachen (Handy) | `~/Dokumente/obsidian-plugins/vaultcrdt/` (synced) | `richardhandy` | `richardsachen` |

---

## Was in v0.2.13 gefixt wurde

### Das Problem (v0.2.8–v0.2.12)

Wenn der User auf Android Obsidian startet und sofort tippt, "verschluckt" sich der Text — er verschwindet, kommt teilweise wieder, Dateien werden korrumpiert. Ursache: `syncOverlappingDoc` nutzte `writeToVault` → `editor.setValue()`, was den gesamten Editor-Buffer überschrieb und User-Keystrokes zerstörte.

### Die Lösung: Surgical Diffs (Ansatz C)

Für das **aktive Editor-Doc** wird in `syncOverlappingDoc` und `onDeltaBroadcast` (VV-Gap-Catchup) jetzt:

1. **`flushPendingEdits(path)`** — alle gepufferten Keystrokes in den CRDT + an Server pushen
2. **`import_and_diff(serverDelta)`** statt `import_snapshot` — merged UND gibt TextDelta-JSON zurück
3. **`applyDiffToEditor(diffJson, serverContent, skipFallback=true)`** — nur Server-Änderungen chirurgisch via `editor.transaction({changes})`, User-Typing bleibt erhalten
4. **`readCurrentContent` → `sync_from_disk`** — nach dem Apply, restlichen Editor-Content in CRDT aufnehmen

`skipFallback=true` verhindert, dass die Verification in `applyDiffToEditor` bei Mismatch (durch concurrent Typing) auf `editor.setValue()` zurückfällt.

Für **nicht-aktive Docs** (kein offener Editor) bleibt der alte `writeToVault`-Path — dort kann kein Typing verloren gehen.

### Geschützte Code-Pfade

| Pfad | Methode | Schutz |
|------|---------|--------|
| `syncOverlappingDoc` (active doc) | `import_and_diff` + `applyDiffToEditor(skipFallback)` | ✓ v0.2.13 |
| `onDeltaBroadcast` VV-Gap-Catchup (active doc) | `import_and_diff` + `applyDiffToEditor(skipFallback)` | ✓ v0.2.13 |
| `onDeltaBroadcast` normal | `import_and_diff` + `applyDiffToEditor` | ✓ schon vor v0.2.13 |
| Nicht-active docs | `writeToVault(setValue)` | kein Editor offen = kein Problem |

### Was NICHT geändert wurde

- Conflict-Detection-Pfade (concurrent create, external edit, disjoint VV) — diese sind Sonderfälle und nutzen weiterhin `writeToVault`. Könnte bei Edge-Cases noch Probleme geben, aber die normalen Startup-Typing-Szenarien sind abgedeckt.

---

## Versionshistorie der Startup-Typing-Fixes

| Version | Ansatz | Ergebnis |
|---------|--------|----------|
| v0.2.8 | Ghost-Push Fix (`text_matches` Guard) | Gefixt: Cache-Migration-Ghost-Pushes. Beibehalten ✓ |
| v0.2.9 | Editor-Buffer + Push-Deferral | Conflict Detection löschte CRDT. Revertiert. |
| v0.2.10 | isLiveEdit Flag | Text verschluckt sich weiterhin. Revertiert. |
| v0.2.11 | Hot-Doc-Skip | Unklar warum gescheitert. Revertiert. |
| v0.2.12 | Revert + Priority Sync + Zero-I/O | Text verschluckt sich weiterhin bei Startup-Typing. |
| **v0.2.13** | **Surgical Diffs (Ansatz C)** | **Funktioniert. User kann sofort tippen.** |

---

## Architektur-Referenz

### Code-Pfade die den Editor beschreiben

1. **syncOverlappingDoc** (active doc) → `flushPendingEdits` → `import_and_diff` → `applyDiffToEditor(skipFallback=true)` → `editor.transaction({changes})`
   - Chirurgisch: nur Server-Änderungen werden eingefügt
   - Trigger: initialSync Priority-Sync + Overlapping-Loop

2. **syncOverlappingDoc** (nicht-active doc) → `import_snapshot` → `writeToVault` → `applyToEditor` → `editor.setValue()`
   - Full replace — kein Problem weil kein Editor offen
   - Trigger: initialSync Overlapping-Loop

3. **onDeltaBroadcast** → `import_and_diff` → `applyDiffToEditor` → `editor.transaction({changes})`
   - Surgical diff, preserviert Cursor und unberührten Text
   - VV-Gap-Catchup nutzt jetzt auch surgical diffs für active doc
   - Trigger: Server-Broadcast nach initialSync

4. **pushFileDelta** → (kein Editor-Write, nur CRDT + Server-Push)
   - Liest Editor via `readCurrentContent`, synct in CRDT, pusht an Server
   - Trigger: editor-change Event (debounced 300ms)

### WASM API (WasmSyncDocument)

| Methode | Typ | Beschreibung |
|---------|-----|-------------|
| `sync_from_disk(text)` | **REPLACE** | Macht CRDT-Text = text. Erzeugt Insert/Delete-Ops. **Nie nach import_snapshot aufrufen!** |
| `text_matches(text)` | CHECK | CRDT-Text === text? Ohne JS-String-Allokation |
| `import_snapshot(data)` | IMPORT | Snapshot oder Delta importieren |
| `import_and_diff(data)` | IMPORT+DIFF | Importiert und gibt TextDelta-JSON zurück |
| `export_delta_since_vv_json(vv)` | EXPORT | Ops seit gegebenem VV |
| `export_snapshot()` | EXPORT | Full Snapshot |
| `export_vv_json()` | VV | Version Vector als JSON |
| `get_text()` | READ | Aktueller CRDT-Text |
| `insert_text(pos, text)` | OP | Einzelne Insert-Op |
| `delete_text(pos, len)` | OP | Einzelne Delete-Op |
| `version()` | READ | Aktuelle Version |

### Plugin-Dateien
```
main.ts               — Plugin-Lifecycle, Event-Handler (editor-change, modify, create, delete, rename)
sync-engine.ts         — WebSocket, initialSync, syncOverlappingDoc, onDeltaBroadcast, priority sync, surgical diffs
push-handler.ts        — Debounced pushFileDelta, flushPendingEdits, pushDocCreate
editor-integration.ts  — readCurrentContent, writeToVault (setValue), applyDiffToEditor (surgical, skipFallback)
document-manager.ts    — CRDT-Doc Cache + .loro Persistenz
state-storage.ts       — .loro File I/O, VV-Cache v3 (contentHash)
conflict-utils.ts      — vvCovers, vvEquals, hasSharedHistory, conflictPath, fnv1aHash
```

### Sync-Flow (initialSync v0.2.13)
```
1. Build local file index (metadata only)
2. request_doc_list → Server-VVs + Tombstones
3. Load VV-Cache v3
4. ★ Priority sync: active editor doc FIRST via syncOverlappingDoc (surgical diffs)
5. Server-only docs → parallel download (max 5)
6. Overlapping docs (skip already-synced priority doc):
   - Tier 0: VV match → SKIP (zero I/O, trust cached hash)
   - VV mismatch → vault.read() + syncOverlappingDoc (surgical if active, else full)
7. Local-only docs → doc_create
8. Flush offline deletes, trash tombstones
9. Save VV-Cache, clean orphans
10. initialSyncRunning = false
11. Process queued broadcasts (surgical diffs for active doc)
```

---

## Erkenntnisse aus den bisherigen Debug-Sessions

- **mtime auf Android instabil**: Niemals mtime für Caching verwenden.
- **sync_from_disk ist REPLACE, nicht MERGE**: Darf nie nach import_snapshot aufgerufen werden (Ausnahme: nach applyDiffToEditor, um concurrent Typing aufzufangen).
- **writeToVault hat await vor setValue**: Event-Loop-Gap wo User-Events durchkommen.
- **Ghost-Pushes (leere 22b Deltas) erzeugen VV-Einträge**: Gefixt mit text_matches Guard (v0.2.8).
- **applyDiffToEditor Verification-Fallback**: `setValue`-Fallback bei Mismatch zerstört concurrent Typing. Gelöst mit `skipFallback=true` für initialSync-Pfade.
- **Priority Sync allein reicht nicht**: User kann zu einem anderen Doc wechseln während initialSync läuft. `isActiveEditorDoc` wird dynamisch geprüft.

---

## Ziel des Users

> "es soll sich smooth und snappy anfühlen"

Kein harter Lock/Freeze beim Startup. Der User soll sofort tippen können und nichts verlieren. Server-Änderungen sollen sauber reingemerged werden ohne den Editor zu "zerreißen".

**Status: Erreicht in v0.2.13** ✓

---

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy Server: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Logs: `ssh home "docker logs vaultcrdt 2>&1 | tail -50"`
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
