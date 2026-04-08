# Session Handoff — Conflict-Storm Follow-up landed

Datum: 2026-04-08 (Ende der achten Session)
Branch: `main`, **2 Commits vor `origin/main`**, nicht gepusht.

## Status in einem Satz

Conflict-Storm-Härtung *und* Follow-up sind beide committet — nächste Session
ist Deploy + Recovery-Entscheidung für den richardsachen-Vault + Dogfooding.

## Was gelandet ist

Zwei Commits on top von `991c222`:

1. **`3276d16` — `chore: vendor coding-agent tooling, pin-aligned to wasm-bindgen 0.2.117`**
   - Bringt `.claude/` und `.pi/` erstmals unter Versionskontrolle (rules,
     commands, settings, hooks, agent, skills, pi-ultrathink)
   - Pin-Align auf `=0.2.117` mit drin (CLAUDE.md + alle Tooling-Files) —
     also *Option A*, nicht die im letzten Handoff vorgeschlagene Option B.
     Grund: nach dem vollgelaufenen Context war ein gebündelter Commit
     sauberer als die Retro-Pin-Manöver aus dem Runsheet
   - `.claude/settings.local.json` liegt bewusst via global gitignore ausserhalb

2. **`f366dd8` — `fix(sync): stable peer-id, adopt-not-merge, and editor-first content reads`**
   - Subsumiert beide Lücken-Ebenen in einem Commit (wieder zugunsten eines
     sauberen Git-Verlaufs statt zwei kleiner Commits)
   - Stabile Loro-PeerID via `derive_peer_id` (BLAKE3-Hash, Sentinel-Mapping,
     `set_peer_id()` vor den ersten Ops) — `crates/vaultcrdt-crdt/src/document.rs`
   - `createDocument(doc_uuid, peer_id)` durch WASM-Shell und DocumentManager
     bis in SyncEngine (`settings.peerId`)
   - `ensureDeviceIdentity(settings, …)` Helper in `src/settings.ts`, von
     `main.ts::loadSettings()` aufgerufen — Startup-Invariante jetzt unit-testbar
   - Phase-2 + Phase-3 Initial-Sync adoptiert Server-Snapshot wholesale
     (kein Loro-Merge mehr); Conflict-Files nur bei echter Text-Differenz
   - `PROBE_DOC_UUID` / `PROBE_PEER_ID` Konstanten in `src/sync-initial.ts`
   - `readEffectiveLocalContent(app, editor, file)` an 4 Stellen
     (priority active, overlapping loop incl. hash-skip, local-only loop) plus
     belt-and-suspenders im Kopf von `syncOverlappingDoc`
   - Tests: 5 Rust-Unit-Tests fuer `derive_peer_id`, 5 Faelle in der neuen
     `src/__tests__/settings-identity.test.ts`, Phase-2/3-Regression plus
     stale-disk-vs-fresh-editor Abdeckung in `sync-engine.test.ts`
   - Verifikation im Commit-Zeitpunkt: 168 Plugin-Tests gruen, cargo test
     workspace 36 gruen, `wasm:check` clean, `bun run build` clean

Die einzige noch offene Aenderung war der Handoff selbst — Commit 3
(`docs(handoff): close conflict-storm follow-up cycle`) schliesst den Zyklus.

## Naechste Session — Aufgaben

1. **Push** `git push origin main` (zwei Commits warten)
2. **Plugin deployen** an die 4 Vault-Locations — siehe `reference_deploy` Memory
3. **Server-Redeploy** (unveraendert seit Zyklus 2, unproblematisch)
4. **Recovery richardsachen-Vault** — *vor* Dogfooding entscheiden:
   - Der Code-Fix heilt den existierenden Schaden (805 Conflict-Files) **nicht**.
   - Source-of-Truth-Entscheidung: Welche Seite (Desktop-Vault / Mobile-Vault /
     Server-Snapshot) ist die Wahrheit? Danach Aufraeum-Strategie
     (Conflict-Files sichten, Duplikate mergen, Loro-Snapshots ggf. verwerfen
     damit stabile PeerID greift)
5. **Dogfooding-Checkliste** abarbeiten — `dogfooding-checklist.md` im Repo-Root
   ist noch leer, muss vorher befuellt werden (sinnvolle Pfade: frischer Edit
   auf Device A waehrend Device B offline, Sync-Reconnect, Conflict-Provokation,
   Delete-Ack)

## Uncommittete Artefakte (bewusst liegengelassen)

Diese sind Arbeitsdokumente aus dem Zyklus und koennen in der naechsten Session
aufgeraeumt werden (oder als Referenz bleiben — keine harte Regel):

- `gpt-audit/conflict-storm-plan.md`
- `gpt-audit/conflict-storm-follow-up-plan.md`
- `gpt-audit/conflict-storm-follow-up-runsheet.md`
- `gpt-audit/delete-ack-plan.md`
- `gpt-audit/delete-ack-second-opinion.md`
- `dogfooding-checklist.md` (leer)

Gemaess gpt-audit-Workflow sind die keine offiziellen Zyklen (kein
`archive-<datum>/`). Zwei Moeglichkeiten:

- **Archivieren**: `mkdir gpt-audit/archive-2026-04-07-conflict-storm/`, die
  vier conflict-storm-Files reinziehen, `previous-cycles.md` um einen Absatz
  ergaenzen. Analog fuer delete-ack.
- **Wegwerfen**: wenn die Informationen ausschliesslich im Commit-Message und
  Handoff leben, sind die Plan-/Runsheet-Files redundant.

Entscheidung auf die naechste Session verschoben, weil das nichts am
Code-Zustand aendert.

## Verifikation, falls nochmal noetig

```bash
cargo fmt --all
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace
bun run wasm:check
bun run test
bun run build
# verify_plugin (pi-coding-agent)
```

Alles war zum Commit-Zeitpunkt gruen. Wenn in der naechsten Session etwas
dazwischenkommt, hier erneut durchlaufen.

## Offene Edge Cases / parkend

- **Vault-Klon-Caveat**: `peerId` liegt vault-lokal in `data.json`. Wer Vault
  inkl. Plugin-Konfig auf ein zweites Geraet kopiert, schleppt dieselbe
  Loro-PeerID mit. Memory: `project_peerid_clone_caveat.md`. Loesung ist ein
  Klon-Detection-Hook spaeter — nicht jetzt.
- **Snapshot-Migration**: bestehende `.loro`-Files enthalten Ops von frueheren
  zufaelligen Loro-PeerIDs. Praktisch unkritisch (die Fix-Logik greift beim
  naechsten vollen Initial-Sync), aber fuer den richardsachen-Vault evtl.
  Teil der Recovery-Strategie (vgl. Punkt 4 oben).
- **Delete-Ack** (`gpt-audit/delete-ack-*.md`): separates Thema, in dieser
  Session nicht angefasst. Wenn die delete-ack-Plan-Files nicht
  aufgeraeumt werden, beim naechsten `/audit`-Start darauf zurueckkommen.

## Deferred (unveraendert)

- **#7 Multi-Editor-Konsistenz** — public release
- **#8 WS-Token-Logging** — public release

Siehe `gpt-audit/archive-2026-04-06/claude-response.md`.
