# Claude-Antwort auf den GPT-Audit

Erstellt: 2026-04-07 (Phase A)  
Aktualisiert: 2026-04-07 (Phase B abgeschlossen — siehe unten)  
Modell: Claude Opus 4.6 (ultrathink)  
Kontext: Vollzugriff auf Plugin-Code, Server-Repo und WASM-Monorepo

---

## Gesamtbewertung des Audits

Der Audit ist solide. Die Priorisierung stimmt, die Risikoeinschätzungen sind realistisch, und die Vorschläge sind pragmatisch — kein Security-Theater, kein Over-Engineering.

Drei Punkte, die ich anders gewichte als der Audit:

1. **State-Key-Encoding wurde unterschätzt.** Der Audit nennt es "selten, aber echt". Ich würde sagen: es ist trivial zu fixen und der Kollisionsfall (`a/b.md` vs `a__b.md`) ist nicht so unwahrscheinlich bei verschachtelten Vault-Strukturen. Fix: 1 Zeile.

2. **Die Pfad-Policy ist wichtiger als dargestellt.** Der Audit behandelt sie als "Seiteneffekt-Prävention". In Wirklichkeit ist sie eine Security-Grenze: ohne Pfadvalidierung bei Remote-Nachrichten kann ein kompromittierter Server beliebige Pfade ins Vault schreiben. Das ist kein theoretisches Risiko, sondern eine fehlende Eingabevalidierung.

3. **WASM-Reproduzierbarkeit ist für den täglichen Betrieb irrelevant.** Für Release-Qualität wichtig, aber der Audit gibt ihr dieselbe Stufe wie Auth-Härtung. Ich würde sie klar darunter einordnen.

---

## Was wir umgesetzt haben (Phase A)

### 1. Initial-Sync Content-Hash-Check

**Problem:** `sync-initial.ts:174` skippte bei VV-Match, ohne den lokalen Dateiinhalt zu prüfen. Externe Änderungen (git, Syncthing, manuell) gingen still verloren.

**Fix:** Vor dem Skip wird jetzt `vault.read()` + `fnv1aHash()` ausgeführt. Skip nur bei VV-Match **und** Hash-Match. Bei Hash-Mismatch: voller Sync-Pfad.

**Nebeneffekt:** Alte v1/v2-Caches haben `contentHash: 0` (Sentinel). Da der echte Hash nie 0 ist, erzwingt der erste Start nach dem Update einen Full-Sync für alle Dateien. Danach greift der Cache wieder normal. Das ist korrekt und gewollt — lieber einmal zu viel syncen als Änderungen verschlucken.

**Variante B (mtime) bewusst verworfen:** Android-mtime ist unzuverlässig (bekanntes Problem, in Memory dokumentiert). Hash ist plattformübergreifend korrekt.

### 2. State-Key Encoding

**Problem:** `stateKey()` ersetzte `/` durch `__`. Kollision: `a/b.md` und `a__b.md` → beide `a__b.loro`.

**Fix:** `encodeURIComponent(filePath) + '.loro'`. Kollisionsfrei, reversibel, debuggbar.

**Migration:** Keine nötig. Einziger User, Test-Phase. Alte `.loro`-Dateien werden vom bestehenden `cleanOrphans()` beim nächsten Start automatisch entfernt. CRDT-State wird frisch vom Server geholt.

### 3. Zentrale Pfad-Policy

**Neue Datei:** `src/path-policy.ts` mit `isSyncablePath()`.

**Regeln:**
- Nur `.md`
- Kein `.obsidian/`, `.trash/`
- Kein `..`, `.`, leere Segmente, absolute Pfade

**Angewendet an 7 Stellen:**
- `main.ts`: 5 Event-Handler (editor-change, modify, create, delete, rename)
- `sync-engine.ts`: `onDeltaBroadcast`, `onDocDeleted` (Remote-Nachrichten vom Server)
- `sync-initial.ts`: Server-only Downloads, Tombstone-Anwendung

**Bewusst nicht umgesetzt:** Konfigurierbare Extensions. "Nur .md" ist die richtige Grenze für v1. Erweiterung auf `.txt`/`.canvas` ist später trivial durch Anpassung der einen Funktion.

---

## Was wir umgesetzt haben (Phase B)

Commits:  
- Server `124a2d7` — argon2id auth + tombstone anti-resurrection  
- Plugin `3280be4` — tombstone-aware push + .loro cleanup  
- Monorepo `b18532c` — wasm-bindgen pin + reproducible build scripts

### 4. Auth-/Secret-Härtung (Item 6)

**Umgesetzt:**
- `db::hash_secret` / `db::verify_secret` (Argon2id, PHC-String-Format via `argon2 = "0.5"`)
- `create_vault` hasht vor `INSERT OR IGNORE`
- `verify_vault` mit Lazy-Migration: legacy Klartext-Einträge werden beim ersten erfolgreichen Verify automatisch zu Argon2id-PHC upgegradet — kein separates Migrationsskript nötig
- `auth_verify` gibt einheitlich `"Authentication failed"` zurück (vorher unterschied "Invalid API key" vs "Invalid admin token" → Vault-Enumeration)
- 3 neue Tests: `test_create_vault_stores_argon2_hash`, `test_verify_vault_with_legacy_plaintext_migrates`, sowie der bestehende `test_vault_create_and_verify` läuft mit den neuen Hash-Pfaden weiter

**Real-Life-Beobachtung:** Die Lazy-Migration ist überraschend angenehm — sie verlagert die Migration vom Deploy-Zeitpunkt in den ersten erfolgreichen Login. Kein Downtime, kein Backfill. Funktioniert nur, weil wir Single-User sind und die Migration deterministisch und idempotent ist. Bei mehreren parallelen Verifies derselben Vault könnte theoretisch der `UPDATE` doppelt feuern — aber das `UPDATE` ist ein Rewrite des gleichen Hashes, also harmlos.

### 5. Tombstone-Härtung (Item 4)

**Server umgesetzt:**
- Default-Retention `7d → 90d`, env-konfigurierbar via `VAULTCRDT_TOMBSTONE_DAYS`
- Neue `db::is_tombstoned()`-Hilfsfunktion
- `handle_sync_push` und `handle_doc_create` prüfen **vor** dem Schreiben den Tombstone-Status. Bei Treffer wird der Push/Create abgelehnt und ein neuer `ServerMsg::DocTombstoned { doc_uuid }` zurückgeschickt
- Die `db::remove_tombstone()`-Aufrufe in `sync_push`/`doc_create` wurden ersatzlos entfernt — Tombstones sind jetzt sticky bis zur Expiry
- 1 neuer Test: `test_is_tombstoned`

**Plugin umgesetzt:**
- `push-handler.ts:onFileDeleted` und `sync-engine.ts:onDocDeleted` rufen jetzt `removeAndClean()` statt `remove()` — die `.loro`-Snapshot-Datei auf Disk wird mit gelöscht
- Neuer `case 'doc_tombstoned'` in `onMessage` loggt eine Warnung. Kein Recreate-Flow in Phase 1: tombstoned Docs können erst nach 90 Tagen am gleichen Pfad neu erstellt werden — für Single-User-Betrieb akzeptabel.

**Real-Life-Beobachtung 1:** Die Plan-Skizze sagte "`handlers.rs` ruft `remove_tombstone()` in `sync_push` (Z.186) und `doc_create` (Z.235) auf" — exakt korrekt. Der Audit hatte das Problem in beiden Pfaden lokalisiert. Nichts überraschendes beim Editieren.

**Real-Life-Beobachtung 2:** Server-seitige Pfadvalidierung (im Plan als "Bonus" markiert) wurde **bewusst nicht umgesetzt**. Begründung: Auf dem Server ist `doc_uuid` ein opaker String — die "ist das ein gültiger Vault-Pfad?"-Logik gehört konzeptionell ins Plugin, weil nur das Plugin weiß, was ein gültiger Vault-Pfad ist. Die Plugin-Seite filtert eingehende `delta_broadcast`/`doc_deleted` schon via `isSyncablePath()`. Eine Server-seitige Duplizierung würde TypeScript-Logik in Rust spiegeln müssen, mit der Gefahr, dass beide auseinanderdriften. Stattdessen: Server bleibt Transport, Plugin ist Policy-Owner.

**Real-Life-Beobachtung 3:** Das `.loro`-Cleanup hat eine subtile Asymmetrie: `push-handler.ts:onFileDeleted` ist synchron (`void this.docs.removeAndClean(path)` als Fire-and-Forget), während `sync-engine.ts:onDocDeleted` async ist und `await`. Grund: das Plugin-API-Vertrag von `onFileDeleted` ist sync (Obsidian-Event-Handler), aber `onDocDeleted` läuft schon in einer async Broadcast-Queue. Der Fire-and-Forget-Pfad ist eine bewusste Lockerung — Worst Case ist eine verwaiste `.loro`-Datei, die beim nächsten Start von `cleanOrphans()` aufgeräumt wird.

### 6. WASM-Build-Reproduzierbarkeit (Item 5)

**Umgesetzt im Monorepo:**
- `Cargo.toml`: `wasm-bindgen = "=0.2.114"` (exakt zum `Cargo.lock`-Eintrag)
- Neue `scripts/build-wasm.sh` schreibt Artefakte direkt nach `../vaultcrdt-plugin/wasm/` — manuelles Kopieren entfällt
- Neue `scripts/check-wasm-fresh.sh` baut WASM in ein TempDir und diff't gegen die committed Artefakte (CI-Guard gegen veraltete Plugin-WASMs)
- `Justfile`: `just wasm` ruft jetzt `build-wasm.sh`; neues `just wasm-check`

**Real-Life-Beobachtung 1 (negativ):** Der `vaultcrdt`-Workspace ist auf Disk **kaputt** — `Cargo.toml` referenziert `v2/server` als Workspace-Member, das Verzeichnis existiert aber nicht. `cargo check`/`cargo tree` schlagen sofort fehl. Das ist pre-existing, hat nichts mit dem Pin zu tun, blockiert aber lokales Smoke-Testing der Build-Skripte. Der Pin selbst ist nachweislich konsistent: `Cargo.lock` enthält bereits exakt `wasm-bindgen 0.2.114` — `cargo` würde beim ersten erfolgreichen Build die Pin-Constraint erfüllen, ohne Lock-Änderung. **Followup:** v2/server entweder anlegen oder aus Workspace-Members entfernen.

**Real-Life-Beobachtung 2 (überraschend):** `/home/richard/projects/vaultcrdt` ist **nicht** ein eigenes Git-Repo, sondern lebt innerhalb eines Eltern-Repos `/home/richard/projects/`. Beim Commit musste ich `git add` mit expliziten Pfaden machen, weil `git status` aus dem Monorepo-Verzeichnis dutzende Geschwister-Projekte auflistete. Dokumentiert hier, damit zukünftige Sessions nicht in dieselbe Falle laufen.

---

## Status der Audit-Punkte nach Phase B

| # | Audit-Item | Status |
|---|-----------|--------|
| 1 | Initial-Sync Hash | ✅ Phase A (db26525) |
| 2 | State-Key Encoding | ✅ Phase A (db26525) |
| 3 | Pfad-Policy | ✅ Phase A (db26525) |
| 4 | Tombstone-Härtung | ✅ Phase B (124a2d7 + 3280be4) |
| 5 | WASM-Build | ✅ Phase B (b18532c) |
| 6 | Auth-Härtung | ✅ Phase B (124a2d7) |
| 7 | Multi-Editor-Konsistenz | ⏸ aufgeschoben (UX-Polish) |
| 8 | WS-Token-Logging | ⏸ aufgeschoben (Self-Hosted ausreichend) |

**6 von 8 Audit-Punkten umgesetzt.** Die zwei verbleibenden sind bewusste Defer-Entscheidungen, kein technischer Schuldenrest.

---

## Was wir NICHT umgesetzt haben und warum

### Multi-Editor-Konsistenz

**Nicht umgesetzt weil:** UX-Polish, kein Korrektheitsproblem.

### WS-Token-Logging

**Nicht umgesetzt weil:** Dokumentation reicht für Self-Hosted. Ticket-Modell ist nice-to-have.

---

## Offene Fragen an den Audit

1. **Tombstone-Generationenmodell:** Der Audit schlägt Phase 2 mit Generationen vor. Meine Einschätzung: für einen Single-Vault-Single-User-Case mit wenigen Geräten ist Phase 1 (lange Retention + Anti-Resurrection-Guard) ausreichend. Generationen lösen ein Problem, das bei <10 Geräten praktisch nicht auftritt. Würde ich nur bauen, wenn Community-Release konkret wird.

2. **Server-seitige Pfadvalidierung:** Der Audit erwähnt sie, aber geht nicht auf die Implementierung ein. In Rust/Axum ist das eine Middleware oder ein Check in `handlers.rs`. Sollte spiegelgleich zur Client-Policy sein.

3. **`doc_uuid` als Vault-Pfad:** Das ist eine bewusste Architekturentscheidung, kein Bug. Der Pfad ist die natürliche Identität eines Markdown-Dokuments in Obsidian. Eine UUID-Indirection würde Rename-Semantik und Debugging massiv verkomplizieren.

---

## Methodik-Unterschied

Der GPT-Audit arbeitet primär von der Dokumentation und Codestruktur her — gute Heuristiken, aber ohne Ausführung. 

Mein Ansatz: Code lesen, Hypothese bilden, gegen realen Code verifizieren, Fix schreiben, Tests laufen lassen. Beispiel: Der Audit sagt "State-Key-Kollision ist selten". Ich kann den konkreten `stateKey()`-Code zeigen und die Kollision mit zwei realen Pfaden demonstrieren.

Beide Ansätze ergänzen sich gut. Der Audit liefert die richtige Vogelperspektive, die Code-Verifikation die konkreten Fixes.

---

## Lessons Learned aus Phase B

1. **Lazy-Migration ist Single-User-Gold.** Für Multi-Tenant-Systeme zu fragil, aber bei einem User mit deterministischen Auth-Flows ist es die einfachste denkbare Migration.

2. **Sticky Tombstones brauchen Plugin-Disziplin.** Der Server allein reicht nicht — wenn das Plugin nach einem Delete weiter pusht, sammelt es nur `DocTombstoned`-Warnungen. Der Plugin-Pfad muss aktiv aufhören zu pushen, sobald ein Delete bekannt wurde. Aktuell passiert das implizit, weil `DocumentManager` den Doc nach `removeAndClean()` nicht mehr kennt — beim nächsten `getOrLoad()` würde er ihn neu holen, was den `is_tombstoned`-Guard auf dem Server triggert. Sauber, aber sollte beobachtet werden.

3. **Pre-existing Workspace-Bruch im Monorepo wurde erst beim Verifizieren entdeckt.** Lehre: bei Cross-Repo-Arbeit immer früh `cargo check` als Smoke-Test laufen lassen, nicht erst nach den Edits. Spart Zeit beim Differenzieren von "ich habe etwas kaputt gemacht" vs "es war schon kaputt".

4. **Plan-Skizzen mit konkreten Zeilennummern (`handlers.rs:186`) waren extrem wertvoll.** Der Phase-B-Plan hat alle Edit-Stellen vorab lokalisiert, sodass die Implementierung praktisch mechanisch wurde. Das ist die beste Form von Pair-Programming zwischen Plan- und Execute-Phase.

5. **Server-seitige Pfadvalidierung haben wir bewusst weggelassen** (siehe Real-Life-Beobachtung 2 zu Item 4). Audit-Empfehlungen sind keine Pflichtprogramme — sie sind Vorschläge, die im Licht der konkreten Architektur nochmal gewogen werden müssen.
