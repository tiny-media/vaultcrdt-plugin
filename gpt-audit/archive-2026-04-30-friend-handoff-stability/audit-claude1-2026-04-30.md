Ich habe genug Material gesammelt, um den Audit zu verfassen. Jetzt der Bericht.

---

# VaultCRDT Friend-Handoff Stability Audit (Claude1) — 2026-04-30

## Executive Summary

**Bedingt sicher (conditionally safe) für die Übergabe an einen Freund** — sofern eine kleine, klar umrissene Härtungsrunde (P1‑Punkte) vor der Übergabe erledigt wird.

Die zentrale Sync-Korrektheit ist solide:

- Stabile, von BLAKE3 abgeleitete Loro-PeerIDs (Zyklus 2) verhindern den 805-Konflikt-Storm.
- Phase‑2/Phase‑3 verwenden „adopt server, never merge" — die historische Doppelung des Texts ist abgedichtet.
- `is_tombstoned()`-Guard sitzt jetzt im selben `DocLocks`-Lock wie `sync_push`/`doc_create`.
- Delete-Journal ist persistent und wird per `request_doc_list` ack-basiert abgeglichen.
- 197/197 Plugin‑Vitest, 36/36 Server‑Cargo‑Tests, `bunx tsc --noEmit`, `cargo clippy -D warnings` und `bun run wasm:check` sind grün.

Was den Freund trotzdem treffen kann, sind keine Datenverlust-Klassen, sondern Setup‑Stolpersteine, hörbare WS‑Reconnect‑Churn-Effekte, eine veraltete Server‑README, fehlende Backup‑/Retention-Doku, und ein paar Edge‑Cases (unsynced Conflict-Files, `tombstone_days=90` kombiniert mit langem Offline). Keiner davon blockiert allein die Übergabe, aber sie summieren sich zu „der Freund ruft nach 3 Wochen genervt an".

Es wurden keine P0-Datenverlustpfade identifiziert. Alle P0-Findings betreffen Onboarding-Robustheit und Beobachtbarkeit unter realen Bedingungen, nicht CRDT‑Korrektheit.

## P0/P1/P2 Findings — Übersicht

| # | Sev | Bereich | Titel |
|---|-----|---------|-------|
| 1 | P0 | Server `README.md` | Versionsangabe `0.2.4` veraltet, tatsächliches Release ist `0.2.6` |
| 2 | P0 | Plugin `setup-modal.ts` / Server `README.md` | Setup-Pfad hat keine ersichtliche Backup-/Disaster-Recovery-Doku |
| 3 | P0 | Server `ws.rs:198` | „5 min idle timeout"-Kommentar lügt — sind 60 s, mit 30 s Heartbeat hart an der Grenze |
| 4 | P1 | Live-Logs / Plugin `sync-engine.ts` | ~70 WS‑Reconnects in zwei Wochen mit nur einem Gerät — sichtbarer Churn |
| 5 | P1 | Plugin `setup-modal.ts` / `url-policy.ts` | Trailing-Slash in Server-URL führt zu `//auth/verify` und `//ws` |
| 6 | P1 | Plugin `README.md` Zeile 56 | Doku verspricht „Markdown notes and text files" — Policy erlaubt nur `.md` |
| 7 | P1 | Plugin `sync-initial.ts` `syncOverlappingDoc` | Conflict‑Datei wird lokal angelegt, ist aber bis zur nächsten Initial-Sync nicht selbst getracked → Edit‑Konflikt am Conflict-File möglich |
| 8 | P1 | Server `main.rs` / `.env.example` | `VAULTCRDT_TOMBSTONE_DAYS=90` Default, nicht im `.env.example`, im Self-Host-Onboarding unsichtbar |
| 9 | P1 | Plugin `sync-engine.ts:409` | `doc_tombstoned`-Antwort wird nur per `warn()` geloggt, kein UI-Signal, lokale Bearbeitung läuft weiter |
| 10 | P1 | Plugin `file-watcher.ts` | `scanForExternalChanges` liest auf Desktop bei jedem Window‑Focus alle bereits geladenen Markdown‑Files vom Disk |
| 11 | P2 | Server `db.rs::run_maintenance` | Wöchentliches `VACUUM` läuft im Live-Pfad, keine konkurrenzfreie Variante |
| 12 | P2 | Server `Cargo.toml` / live container | Server-Binary auf 0.2.6, README behauptet 0.2.4, CHANGELOG springt von 0.2.1 → 0.2.6 |
| 13 | P2 | Plugin `sync-initial.ts` Phase 2 fall-through | Race: Server hat Pfad in `doc_list`, beim `sync_start` aber kein Delta → lokal erzeugte Synth-History wird nicht gepusht |
| 14 | P2 | Server `ws.rs:179` | `ws_writer.abort()` schneidet möglicherweise eine in-flight Antwort ab |
| 15 | P2 | Plugin `setup-modal.ts` | Keine „Server erreichbar?"-Prüfung vor Submit |
| 16 | P2 | Plugin `sync-engine.ts:225-262` | Reconnect-Backoff ohne Obergrenze an Versuchen → Mobil-Akku-Drain bei langer Server-Down-Zeit |
| 17 | P2 | Plugin `docs/install-brat.md` | Keine Erwähnung des Sicherheitsmodells (Plaintext über WSS, Server speichert plaintext SQLite) |
| 18 | P2 | Plugin `sync-engine.ts:226-228` | JWT-Token im WebSocket-URL-Query (nicht im Header) — Reverse-Proxy-Logs könnten ihn aufnehmen |

---

## P0 Findings (vor Übergabe behandeln)

### P0-1 — Server-README behauptet veraltete Version

- **Severity:** P0
- **Datei:** `vaultcrdt-server/README.md` Zeile 9 vs. `vaultcrdt-server/Cargo.toml` Zeile 13 vs. live container `vaultcrdt-server:0.2.6`
- **Evidenz:** README sagt `Pre-release (0.2.4)`, Cargo.toml ist `0.2.6`, der laufende Container ist `0.2.6`. CHANGELOG.md überspringt 0.2.2..0.2.5.
- **Warum es fuer den Freund zaehlt:** Wenn der Freund den Server selbst hosten soll (und das ist das Geschaeftsmodell), liest er README. Eine veraltete Versionsangabe untergraebt das Vertrauen ab Minute eins und wirft die berechtigte Frage auf, was sonst noch nicht gepflegt ist.
- **Empfohlene Aktion:** Server-`README.md` Zeile 9 auf `0.2.6` aktualisieren; `CHANGELOG.md` mindestens mit „0.2.2–0.2.5: see GitHub Releases"-Zeilen ergaenzen oder den Sprung explizit erklaeren.
- **Blockiert Handoff?** Ja, weil triviale Korrektur und Vertrauensschaden.

### P0-2 — Keine sichtbare Backup-/Recovery-Doku

- **Severity:** P0
- **Datei:** `vaultcrdt-plugin/README.md`, `vaultcrdt-plugin/docs/install-brat.md`, `vaultcrdt-server/README.md`
- **Evidenz:** Keine der drei Dateien erwaehnt:
  - dass `VAULTCRDT_DB_PATH` (default `/var/lib/vaultcrdt/data.db`) das einzige durable Daten-Asset ist
  - wie ein Restore aussieht (Container down, Datei zurueckspielen, Container up)
  - dass auf der Plugin-Seite `.obsidian/plugins/vaultcrdt/state/*.loro` plus `data.json` rekonstruktionsrelevant sind
- **Warum es fuer den Freund zaehlt:** Single-User self-hosted SQLite ohne Backup-Anweisung ist eine wartende Datenkatastrophe. Ein einziges Container-Volume-Loeschen reicht, und das CRDT-Material ist weg. Tombstones sind sticky, also wird ein Restore-mit-anschliessendem-Push lokaler Dateien nicht trivial.
- **Empfohlene Aktion:** In `vaultcrdt-server/README.md` einen Abschnitt „Backup" mit dem konkreten Pfad (`./data/data.db` und `./data/data.db-wal`/`-shm`), der Empfehlung `sqlite3 data.db ".backup /path/to/backup.db"` (online, mit WAL) und dem Hinweis, das vor jedem Server-Update zu tun.
- **Blockiert Handoff?** Ja, weil ein Datenverlustpfad ohne dokumentierte Mitigation existiert.

### P0-3 — WS-Idle-Timeout: Kommentar luegt, real ist 60 s

- **Severity:** P0 (Korrektheit der Annahmen, indirekt Stabilitaet)
- **Datei:** `vaultcrdt-server/src/ws.rs:197-199`
- **Evidenz:**
  ```rust
  msg = ws_stream.next() => msg,
  // 5 min idle timeout
  _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => None,
  ```
  CHANGELOG `0.2.0` bestaetigt: „Reduced WebSocket idle timeout from 300s to 60s". Plugin-Heartbeat ist `HEARTBEAT_MS = 30_000` (`sync-engine.ts:29`).
- **Warum es fuer den Freund zaehlt:** Mit Heartbeat 30 s und Idle 60 s ist die Sicherheitsmarge **ein einziges Heartbeat-Intervall**. Wenn der Plugin-Tab im Hintergrund laeuft (Mobile, Tab-Switch) und das `setInterval(30_000)` von der Browser-Engine gedrosselt wird (Chromium drosselt Hintergrund-Timer auf 1/min nach 5 min), reisst der Server die Verbindung. Live-Logs bestaetigen das: 70+ Disconnects in zwei Wochen mit **einem** aktiven Geraet, oft im 5–7-Minuten-Takt — exakt der Drosselungs-Bereich.
- **Empfohlene Aktion (zwei Optionen, beide vor Handoff machbar):**
  1. Server-Idle erhoehen auf 120 s (`ws.rs:198`) — minimaler Server-Patch, doppelte Marge zur Heartbeat. Kommentar entsprechend korrigieren.
  2. Plugin-Heartbeat verkuerzen auf 20 s (`sync-engine.ts:29`).
  Option 1 ist korrekter, weil die Server-Logs den eigentlichen Drift sehen.
- **Blockiert Handoff?** Ja in dem Sinn, dass die heutige WS-Churn fuer den Freund spuerbar ist (siehe P1-4) und die Wurzel hier sitzt.

---

## P1 Findings (vor Handoff stark empfohlen)

### P1-4 — Sichtbarer WS-Reconnect-Churn in der Live-Beobachtung

- **Severity:** P1
- **Datei/Evidenz:** `gpt-audit/archive-2026-04-30-friend-handoff-stability/live-server-observation.md` — 72 `WS connected` und 73 `WS disconnected`-Eintraege in ca. zwei Wochen Beobachtung mit ausschliesslich `device=richard@richard-laptop`. Pattern z.B. 20:34 → 20:40 → 20:46 → 20:53 (~6 min Zyklus).
- **Warum es fuer den Freund zaehlt:** Jeder Reconnect = neues `auth: vault_id=...` plus `request_doc_list: docs=813, tombstones=831` plus mindestens ein `sync_start`. Bei 813 Docs ist das je Reconnect mehrere KB Roundtrip-Traffic und fuehrt zu sichtbaren „syncing"-Indikatoren. Auf Mobile auch Akku-Kosten.
- **Empfohlene Aktion:** Wahrscheinliche Ursache ist P0-3 plus Browser-Timer-Throttling in Hintergrund-Tabs. Nach Anhebung des Server-Idle-Timeouts (siehe P0-3) eine zweite Beobachtungsrunde laufen lassen. Wenn der Churn bleibt: pruefen, ob ein WS-Frame-basiertes Heartbeat (Ping-Frame statt App-Level-Ping) oben im Stack reicht. Auch pruefen, ob ein Reverse-Proxy zwischen Container und Internet ein eigenes Idle-Timeout setzt (Traefik-Default ist 0=disabled, aber Cloudflare WS-Idle ist 100 s).
- **Blockiert Handoff?** Nein, aber die Stabilitaetsmessung „2 Wochen ohne Stoerung" ist hiermit nicht erfuellt.

### P1-5 — Trailing-Slash in der Server-URL erzeugt Doppel-Slash-Pfade

- **Severity:** P1
- **Datei:** `vaultcrdt-plugin/src/url-policy.ts:71-78`, `vaultcrdt-plugin/src/sync-engine.ts:170-172`, `vaultcrdt-plugin/src/setup-modal.ts:164-166`
- **Evidenz:** `toHttpBase()` und `toWsBase()` machen nur Schema-Replace, kein `.replace(/\/+$/, '')`. Wenn der Freund `https://sync.example.com/` eingibt:
  - `${httpBase}/auth/verify` → `https://sync.example.com//auth/verify`
  - `${this.wsUrl()}` baut `https://sync.example.com//ws`
- **Warum es fuer den Freund zaehlt:** Manche Reverse-Proxy-Konfigurationen (insbesondere strenge nginx-Setups) werten `//` als anderen Pfad. Die Eingabe einer vollstaendig kopierten URL endet sehr wahrscheinlich auf einen Slash, weil Browser ihn anhaengen. Auth schlaegt mit kryptischer Meldung fehl.
- **Empfohlene Aktion:** In `validateServerUrl()` das `URL`-Objekt nach `pathname === '/' ? '' : pathname` neu zusammenbauen, oder einfach `trimmed.replace(/\/+$/, '')` als Normalisierungsschritt am Ende der Funktion und alle Konsumenten nehmen `result.normalized` statt `raw`.
- **Blockiert Handoff?** Nein, aber 5-Minuten-Fix mit hoher Treffsicherheit.

### P1-6 — Doku-Versprechen „Markdown notes and text files" ist falsch

- **Severity:** P1 (Vertrauen / Erwartungs-Management)
- **Datei:** `vaultcrdt-plugin/README.md:55-56` vs. `vaultcrdt-plugin/src/path-policy.ts:14`
- **Evidenz:** README sagt unter „What it does not do":
  > Binary file sync. Only Markdown notes and text files are synchronised.
  Die Policy: `if (!path.endsWith('.md')) return false;` — `.txt`, `.canvas`, `.excalidraw`, `.org`, `.json` werden alle stillschweigend nicht gesynced.
- **Warum es fuer den Freund zaehlt:** Der Freund speichert eine `.txt`-Notiz, sieht keinen Sync, denkt das Plugin ist kaputt. Es gibt **keine UI-Meldung**, dass eine Datei nicht-syncbar ist.
- **Empfohlene Aktion:**
  - Schnellfix: README auf „Only Markdown (`.md`) notes are synchronised" korrigieren.
  - Mittel: bei `vault.create` eines nicht-syncbaren Pfads ein einmaliges Notice schalten, oder im Status-Bar-Tooltip „N files in vault, M syncing" zeigen.
- **Blockiert Handoff?** Nein, aber 1-Zeilen-Fix.

### P1-7 — Conflict-Datei wird ohne Sync-Awareness erstellt

- **Severity:** P1 (UX / Edge-Case Datenverlust)
- **Datei:** `vaultcrdt-plugin/src/sync-initial.ts:564, :623, :663`
- **Evidenz:** An drei Stellen:
  ```ts
  const cPath = conflictPath(app, path);
  await app.vault.create(cPath, localContent);
  ```
  Direkt darauf wird der `.loro`-State des **Original-**Pfads ueberschrieben. Die Conflict-Datei selbst:
  - hat keinen `.loro`-State (bis zur naechsten Initial-Sync nicht in `DocumentManager`)
  - `vault.on('create')`-Handler in `main.ts` ruft zwar `onFileChangedImmediate`, aber waehrend der Initial-Sync ist `acceptVaultChangeEvents = false` (Android-Gegenmassnahme) → das `create`-Event wird unterdrueckt
  - faellt in den naechsten initialSync als `localOnlyFile`, wird gepusht
- **Warum es fuer den Freund zaehlt:** Wenn der Freund die frisch entstandene Conflict-Datei **direkt** anfasst und editiert, bevor die naechste Initial-Sync laeuft, dann ist seine Bearbeitung nur lokal. Stuerzt das Plugin oder schliesst er Obsidian, bevor die naechste Initial-Sync gelaufen ist, geht die Bearbeitung der Conflict-Datei verloren — `localOnlyFile`-Pfad in Sync 2 sieht den dann editierten Inhalt, korrekt, **aber** wenn der Freund sie nicht bemerkt und sie aus „Aufraeumen" loescht, ist sie auch nicht im delete-journal (wurde nie als geladen registriert).
- **Empfohlene Aktion:** Nach `app.vault.create(cPath, ...)` direkt:
  ```ts
  const conflictDoc = await docs.getOrLoad(cPath);
  conflictDoc.sync_from_disk(localContent);
  push.pushDocCreate(cPath, conflictDoc);
  await docs.persist(cPath);
  ```
  Damit wird die Conflict-Datei sofort getrackt und gepusht. Auch ein Notice an den User „VaultCRDT: conflict copy created at <path>" bei jedem Conflict-Anlegen, damit er weiss, dass er hingucken soll.
- **Blockiert Handoff?** Nein im normalen Pfad, aber ein einzelner unbemerkter Conflict-Datei-Verlust ist genau die Klasse von Datenverlust, die einen Freundes-Vertrauensbruch erzeugt.

### P1-8 — `VAULTCRDT_TOMBSTONE_DAYS` nicht im `.env.example`

- **Severity:** P1
- **Datei:** `vaultcrdt-server/.env.example`, `vaultcrdt-server/src/main.rs:17-20`
- **Evidenz:** `.env.example` listet nur `VAULTCRDT_JWT_SECRET`, `_ADMIN_TOKEN`, `_DB_PATH`, `_BIND`, `_POOL_SIZE`. `VAULTCRDT_TOMBSTONE_DAYS` mit Default 90 fehlt komplett, wird aber im Hintergrund-Cleanup-Task verwendet.
- **Warum es fuer den Freund zaehlt:** Nach 90 Tagen verliert ein offline-Geraet die Tombstone-Information. Wenn der Freund ein zweites Geraet >90 Tage offline hat (Urlaub, Wechsel auf neues Tablet), kommt es bei der Wiederverbindung zu Resurrection: das offline-Geraet hat die geloeschten Markdown-Dateien noch lokal, der Server hat keine Tombstone mehr → `localOnlyFiles` → Push → Datei wieder da auf allen Geraeten.
- **Empfohlene Aktion:**
  - `.env.example` ergaenzen, mit Hinweis auf den Trade-off (laenger = sicherer gegen Resurrection, mehr DB-Wachstum).
  - In `vaultcrdt-server/README.md` Tabelle der Env-Variablen ergaenzen.
  - Fuer den konkreten Freundes-Case: 365 (oder 730) als pragmatischen Wert empfehlen, weil es bei einem Single-User mit 1–3 Geraeten praktisch keinen Speicherdruck erzeugt.
- **Blockiert Handoff?** Nein, aber Empfehlung im Setup-Briefing fuer den Freund: `VAULTCRDT_TOMBSTONE_DAYS=365` aktiv setzen.

### P1-9 — `doc_tombstoned`-Antwort ist nur eine Konsole-Warnung

- **Severity:** P1
- **Datei:** `vaultcrdt-plugin/src/sync-engine.ts:409-411`
- **Evidenz:**
  ```ts
  case 'doc_tombstoned':
    warn(`${this.tag} doc is tombstoned on server — push refused`, { doc: msg.doc_uuid });
    break;
  ```
  Der Editor-State, der DocumentManager-Eintrag und der etwaige Datei-Inhalt bleiben unangetastet.
- **Warum es fuer den Freund zaehlt:** Geraet A loescht `Notiz.md`, Geraet B hat sie offen mit ungespeicherten Edits. Die Tombstone-Broadcast wird waehrend einer dazwischen liegenden Disconnect-Phase verpasst. Der Freund tippt weiter auf Geraet B; jeder Push wird mit `doc_tombstoned` beantwortet. **Ohne UI-Signal merkt der Freund nicht, dass er gerade auf einer geloeschten Datei in einen schwarzen Trichter editiert.** Erst der naechste InitialSync trash-t die Datei lokal und macht den ganzen Edit-Block weg.
- **Empfohlene Aktion:** Bei `doc_tombstoned`:
  1. Notice mit `'VaultCRDT: this note was deleted on another device — your local edits will not be saved'` (8s).
  2. Optional: lokal Conflict-Pfad anlegen mit dem aktuellen Editor-Content, dann `removeAndClean(docUuid)`.
- **Blockiert Handoff?** Nein, aber das ist genau das Klasse-1-Datenverlust-Szenario, das der Audit-Scope priorisiert hat. Stark empfohlen.

### P1-10 — `scanForExternalChanges` liest auf jedem Window-Focus alle geladenen Dateien

- **Severity:** P1
- **Datei:** `vaultcrdt-plugin/src/main.ts:130-133`, `vaultcrdt-plugin/src/file-watcher.ts:21-36`
- **Evidenz:** Bei jedem `window:focus` (Desktop) wird durch alle `getMarkdownFiles()` iteriert; pro Datei mit geladenem `DocumentManager`-Eintrag wird `app.vault.read(file)` und ein String-Vergleich gemacht. Bei 813 geladenen Docs heisst das 813 sequenzielle Datei-Reads pro Fokus-Wechsel.
- **Warum es fuer den Freund zaehlt:** Friction nicht unbemerkt: jedes Tab-Wechseln (z.B. zwischen Browser und Obsidian) loest eine kleine I/O-Welle aus. Auf Mobile-Geraeten ist das ohnehin nicht aktiv (`Platform.isDesktop`-Guard), aber auf einem aelteren Laptop merkbar.
- **Empfohlene Aktion:** Min. ein Throttle einbauen (z.B. nicht oefter als alle 30 s scannen) oder die Logik in einen async-iter-batch mit `await new Promise(r => setTimeout(r))` zwischen Batches.
- **Blockiert Handoff?** Nein, aber „warum laggt Obsidian beim Zurueck-Tabben" ist ein typischer Freundes-Anruf.

---

## P2 Findings (Polish)

### P2-11 — Wöchentliches `VACUUM` blockiert ggf. die DB

- **Severity:** P2
- **Datei:** `vaultcrdt-server/src/main.rs:41-50`, `vaultcrdt-server/src/db.rs:434`
- **Evidenz:** `tokio::spawn` startet wöchentlichen Maintenance-Task; der ruft `PRAGMA optimize` und `VACUUM`. `VACUUM` haelt eine **exclusive** Sperre auf die gesamte Datenbank waehrend der Operation, das blockiert alle gleichzeitigen Writer.
- **Warum es zaehlt:** Bei einer 813-Doc-Vault ist `VACUUM` nach Sekunden durch und stoert nicht. Aber bei wachsenden Vaults und gleichzeitiger Push-Aktivitaet kann es zu sichtbaren WS-Hangs fuehren („sync stuck"). Im Live-Log nicht beobachtet — DB ist klein.
- **Empfohlene Aktion:** Vor Public-Release auf `VACUUM INTO` plus Atomic-Replace oder `PRAGMA incremental_vacuum` umstellen. Fuer die Freund-Uebergabe nicht akut.
- **Blockiert Handoff?** Nein.

### P2-12 — CHANGELOG-Sprung 0.2.1 → 0.2.6

- **Severity:** P2
- **Datei:** `vaultcrdt-server/CHANGELOG.md`
- **Evidenz:** Versionen 0.2.2..0.2.5 fehlen. CHANGELOG verweist auf GitHub Releases, aber das ist im Self-Host-Briefing nicht offensichtlich.
- **Empfohlene Aktion:** Mindestens eine Sammelzeile pro fehlende Version. Vor Public Release auffuellen.
- **Blockiert Handoff?** Nein.

### P2-13 — Phase 2 Race: Server hat Pfad in `doc_list`, beim `sync_start` aber kein Delta

- **Severity:** P2
- **Datei:** `vaultcrdt-plugin/src/sync-initial.ts:553-590`
- **Evidenz:** Wenn `probe.delta.length === 0`, faellt der Pfad zur normalen lokal-create-Logik durch. Dort wird `sync_from_disk(localContent)` auf einen frischen Loro-Doc angewendet, was eine synthetische Historie erzeugt — der Kommentar in Phase 2 warnt explizit davor. Der nachfolgende `requestSyncStart(path, clientVV)` liefert in dieser Race ebenfalls nichts (Server-Doc weiterhin leer / geloescht), die `if (result)`-Verzweigung wird uebersprungen, und es gibt **keinen expliziten Push** der gerade synthetisierten Historie. Erst die naechste echte Editor-Aktion pusht via Debounce.
- **Warum es zaehlt:** Sehr enges Race-Fenster (Server-Doc-Existenz aendert sich zwischen `request_doc_list` und `sync_start` desselben WS-Round-Trips). Wahrscheinlich nur bei nahezu-gleichzeitigen Loeschungen sichtbar. Es geht keinen Daten verloren — bei der naechsten Aenderung am File geht der Push raus.
- **Empfohlene Aktion:** Im Phase-2-Fall mit leerem Probe-Delta entweder explizit `push.pushDocCreate(path, doc)` aufrufen, oder den Pfad in `localOnlyFiles` umrouten (Snapshot-Push statt Delta-Push).
- **Blockiert Handoff?** Nein.

### P2-14 — `ws_writer.abort()` schneidet ggf. eine ausstehende Antwort ab

- **Severity:** P2
- **Datei:** `vaultcrdt-server/src/ws.rs:179, 287-291`
- **Evidenz:** Nach `tokio::select!` zwischen `client_read` und `broadcast_fwd` wird `ws_writer.abort()` ohne Drain des `write_rx` aufgerufen. Falls `client_read` einen `Ack` in `write_tx` gestellt hat, der Writer aber gerade einen anderen Frame bedient, kann der Ack verloren gehen.
- **Warum es zaehlt:** Selten und mit Plugin-Reconnect-Logik abgefedert (PromiseManager rejected alles bei `ws.onclose`, sync_push wird beim naechsten Reconnect via VV-Diff korrekt erkannt). Kein Datenverlust, nur ein potentiell unbestaetigter Push, der auf der Plugin-Seite als „normaler Reconnect-Catch-up" auflaeuft.
- **Empfohlene Aktion:** Vor `ws_writer.abort()` einen `write_rx.close()` plus `await ws_writer` mit Timeout, oder explizit `drop(write_tx)` lassen, damit der Writer von selbst auslaeuft.
- **Blockiert Handoff?** Nein.

### P2-15 — Setup-Modal hat keine Vorab-Erreichbarkeitspruefung

- **Severity:** P2 (UX)
- **Datei:** `vaultcrdt-plugin/src/setup-modal.ts:138-216`
- **Evidenz:** Erst beim Klick auf „Connect" wird `/auth/verify` getroffen. Vorher kein Hinweis ob die URL ueberhaupt erreichbar ist.
- **Empfohlene Aktion:** Ein on-blur ping zu `/health` mit kurzem Timeout (3 s), Status-Punkt neben dem Server-Feld. Settings-Tab macht das schon (`checkServerHealth`).
- **Blockiert Handoff?** Nein.

### P2-16 — Reconnect-Backoff ohne Versuche-Limit

- **Severity:** P2
- **Datei:** `vaultcrdt-plugin/src/sync-engine.ts:265-273`
- **Evidenz:** Backoff verdoppelt sich bis 30 s Cap, dann reconnect-Storm bis Server zurueck ist. Mobile dauerhaft im Hintergrund: alle 30 s ein Auth+WS-Versuch.
- **Empfohlene Aktion:** Bei z.B. 20 fehlgeschlagenen Versuchen einen `setStatus('error')` mit Notice und manuellem Retry-Button. Aktuell ist das aber nicht notwendig fuer den realen Single-User-Pfad.
- **Blockiert Handoff?** Nein.

### P2-17 — `docs/install-brat.md` erwaehnt das Sicherheitsmodell nicht

- **Severity:** P2
- **Datei:** `vaultcrdt-plugin/docs/install-brat.md`
- **Evidenz:** Die Setup-Anleitung sagt nichts ueber Plaintext-Storage und Plaintext-WS-Transport (nur ueber TLS). README sagt es im Plugin-Repo, aber der Freund liest typischerweise nur die BRAT-Anleitung.
- **Empfohlene Aktion:** Einen kurzen Block „What VaultCRDT does NOT do" am Ende der install-brat.md mit den drei Saetzen aus `README.md` Zeile 53-56. Plus Hinweis auf WSS.
- **Blockiert Handoff?** Nein.

### P2-18 — JWT in WebSocket-URL-Query

- **Severity:** P2
- **Datei:** `vaultcrdt-plugin/src/sync-engine.ts:226-228`
- **Evidenz:** `?token=${token}&device=...&peer_id=...` — Browser erlauben keine Headers an `new WebSocket()`, daher ist Query-Param ein Standard-Workaround. Server unterstuetzt `Authorization: Bearer` zusaetzlich (`ws.rs:104`).
- **Warum es zaehlt:** Reverse-Proxy-Access-Logs (Apache LogFormat „%r" etc.) koennen den Token aufnehmen. JWT-Lifetime ist 1 h, Schaden begrenzt, aber bei Log-Rotation auf einen externen Logserver leakbar.
- **Empfohlene Aktion:** Im README des Servers den Hinweis aufnehmen, dass im Reverse-Proxy `request_uri` aus dem WS-Access-Log auszuschliessen ist (oder dass kein WS-Access-Log gefuehrt wird).
- **Blockiert Handoff?** Nein.

---

## Positive Signale (bewahren)

- **Stabile PeerIDs via BLAKE3-Derivation** mit Tests (`crates/vaultcrdt-crdt/src/document.rs:181-198, :592-664`) — die Ursache der 805-Konflikt-Storm ist strukturell gefixt.
- **Tombstone-Anti-Resurrection unter Per-Doc-Lock** (`handlers.rs:81-97, :174-183, :233-242`) — TOCTOU sauber abgedichtet.
- **Phase 2/3 „adopt server, never merge"** — explizit kommentiert, mit klarer Erklaerung warum Plaintext-Gleichheit keine kausale Gleichheit ist.
- **Ack-basiertes Delete-Journal mit Reconcile** (`push-handler.ts:174-230`) — robustere Semantik als Send-basiert.
- **Stable startup-dirty-Tracker mit `vaultId+peerId`-Schluessel in localStorage** (`startup-dirty-tracker.ts`) — Android-Cold-Start-Probleme strukturell abgefangen.
- **`isSyncablePath()` zentral, an allen Eintrittspunkten angewendet** — schwer zu umgehen.
- **`validateServerUrl` mit RFC1918-Ausnahmen** — keine `includes('localhost')`-Substring-Falle.
- **Argon2id mit Lazy-Migration** (`db.rs:81-150`).
- **`docker-compose.yml` mit `VAR:?required` Fail-Fast** (`docker-compose.yml:13-14`).
- **JWT-Expiry 1 h + Plugin re-auth bei reconnect** — kurze Token-Lifetime ohne UX-Schmerz.
- **Audit-Trail in `gpt-audit/previous-cycles.md`** ist gepflegt und vermeidet Rehashing.
- **Tests sind tatsaechlich gruen:** 197 Plugin-Vitest, 36 Server-Cargo, `bunx tsc --noEmit` clean, `cargo clippy -D warnings` clean, `bun run wasm:check` clean.

## Vorgeschlagene Minimal-Pre-Handoff-Checkliste

Eine kurze Runde, die den groessten Stabilitaetsgewinn bringt:

1. **P0-1**: `vaultcrdt-server/README.md` Versionsangabe auf `0.2.6` aktualisieren.
2. **P0-2**: Backup-Block in `vaultcrdt-server/README.md` ergaenzen (`sqlite3 .backup` Snippet, vor Updates immer ausfuehren).
3. **P0-3**: WS-Idle-Timeout in `vaultcrdt-server/src/ws.rs:198` auf 120 s, Kommentar korrigieren — release als 0.2.7. **Danach** noch eine zweite Live-Beobachtungsrunde (24 h) machen, um zu sehen, ob P1-4 verschwindet.
4. **P1-5**: Trailing-Slash-Normalisierung in `url-policy.ts`.
5. **P1-6**: README-Zeile 56 auf „Only Markdown (`.md`) notes" korrigieren.
6. **P1-7**: Conflict-Datei-Erstellung um `pushDocCreate` ergaenzen, plus Notice.
7. **P1-8**: `.env.example` und Server-README um `VAULTCRDT_TOMBSTONE_DAYS` ergaenzen, fuer den Freund konkret `=365` empfehlen.
8. **P1-9**: `doc_tombstoned`-Notice + lokale Conflict-Kopie statt nur Console-Warning.
9. **Smoketest auf Android** (laut Handoff offen seit v0.3.0): kalt-start, ein Doc oeffnen, kurz tippen, App schliessen, neu oeffnen, Verifizieren dass Edits da sind. Zusaetzlich: in einem Doc tippen, Geraet 30 min in Sleep, aufwachen, weiter tippen, pruefen ob WS-Reconnect transparent war.
10. **Eine schriftliche Freund-Anleitung** schreiben, die nur diese drei Punkte enthaelt: (a) `https://...` ohne Trailing-Slash eingeben, (b) Setup ausfuellen, (c) eine Notiz schreiben und auf einem zweiten Geraet bestaetigen, dass sie ankommt.

## Ausgefuehrte / nicht ausgefuehrte Befehle

**Ausgefuehrt (alle read-only, alle erfolgreich):**

```bash
bun run wasm:check                                            # OK
bun run test                                                  # 197/197 passed
bunx tsc --noEmit                                             # clean
cargo test --quiet --manifest-path .../vaultcrdt-server/Cargo.toml
                                                              # 36/36 passed
cargo clippy --manifest-path .../vaultcrdt-server/Cargo.toml \
             --all-targets -- -D warnings                     # clean
```

Plus: Lesen von Plugin/Server-Quellcode, `live-server-observation.md`, README-Dateien, Migrations, docker-compose.yml.

**Bewusst NICHT ausgefuehrt (gemaess Hard Guardrails):**

- `bun run wasm` (WASM-Rebuild) — verboten
- jegliche Edit/Write/Modify-Operationen auf Dateien
- `bun test` (Buns built-in Runner) — verboten, `bun run test` benutzt
- `git commit/push/tag` etc.
- `ssh home` — nicht noetig, da `live-server-observation.md` als Seed bereits umfangreich war
- `cargo fmt --check` (nicht erforderlich fuer den Audit; clippy hat formatierungsrelevante Warnungen abgedeckt)
- Plugin-Build (`bun run build`) — nicht erforderlich, da kein TS/Code-Pfad veraendert wurde und Tests/tsc bereits den Code-Pfad abdecken
