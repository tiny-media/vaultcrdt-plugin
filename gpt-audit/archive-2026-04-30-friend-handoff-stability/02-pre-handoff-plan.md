# Pre-Handoff-Plan | VaultCRDT an Freundin weitergeben

Datum: 2026-04-30
Ziel: VaultCRDT so stabil und verstaendlich vorbereiten, dass eine vertraute Freundin es im Alltag nutzen kann.

## Zielzustand

Die Uebergabe ist erst bereit, wenn alle folgenden Punkte erfuellt sind:

1. Es gibt eine klare Backup- und Rollback-Anleitung vor dem ersten Sync.
2. Plugin und Server haben die kleinen Stabilitaets-Haertungen aus den Audits erhalten oder bewusst begruendet verschoben.
3. Der laufende Server ist betriebsbereit: healthy, Backup-Pfad geklaert, Retention sinnvoll gesetzt, Restart-Verhalten geklaert.
4. Ein echter Smoke-Test mit Testvault wurde durchgefuehrt.
5. Die finale Freundin-Anleitung ist kurz, eindeutig und ohne implizites Betreiberwissen.
6. Richard hat explizit freigegeben, dass deployed/released/weitergegeben wird.

## Nicht-Scope

- Kein public community release.
- Keine neue Sync-Architektur.
- Keine Protokollmigration ohne separaten Entscheid.
- Keine Server-Aenderungen ohne klaren Scope.
- Kein Deploy, Release, Tag oder Service-Restart ohne explizite Freigabe.
- Kein `bun test`; nur `bun run test`.
- Kein manuelles Editieren von `wasm/`.

## Phase 1: Entscheidungen vor der Umsetzung

Status: Zielprofil wurde von Richard festgelegt und in `03-friend-target-profile.md` konkretisiert.

Festgelegt:

1. Zielgeraete: PC, Mac, iPad, Android.
2. Server: Richards bestehender Server.
3. Vault: bestehender Vault der Freundin.
4. Start: direkt produktiv, kein leerer Testvault als Hauptpfad.
5. E2E-Verschluesselung: nicht in dieser Runde.
6. Datenschutzwunsch: Richard soll den Vault im Alltag nicht sehen muessen; das wird organisatorisch und ueber Logging-Minimierung behandelt, nicht kryptographisch garantiert.

Noch offen, nicht im Repo speichern:

1. Exakte Server-URL.
2. Vault-ID fuer die Freundin.
3. Starkes Vault-Passwort.
4. Admin-Token nur temporaer fuer die Registrierung.

Akzeptanzkriterium: Die offenen Werte sind Richard lokal bekannt, aber nicht in Git dokumentiert. Die finale Anleitung enthaelt nur Server-URL und Vault-ID, niemals Admin-Token. Das Passwort wird separat uebergeben.

## Phase 2: Kleine technische Haertungsrunde Plugin

### 2.1 Server-URL normalisieren

Problem: `https://host/` kann zu `//auth/verify` und `//ws` werden.

Aufgabe:
- In der URL-Policy eine kanonische Server-URL ohne abschliessenden Slash liefern.
- SetupModal, SettingsTab und SyncEngine muessen diese normalisierte URL verwenden.
- Tests fuer mindestens diese Faelle:
  - `https://sync.example.com`
  - `https://sync.example.com/`
  - `https://sync.example.com/path/` falls Pfade erlaubt bleiben sollen, sonst bewusst ablehnen
  - localhost/dev-Ausnahmen unveraendert

Akzeptanz:
- Trailing slash fuehrt nicht mehr zu Doppel-Slash-Pfaden.
- Bestehende TLS/localhost-Regeln bleiben intakt.

### 2.2 `doc_tombstoned` sichtbar und sicher behandeln

Problem: Server verweigert Push auf tombstoned Doc aktuell nur als Warnlog. User kann weiter in eine geloeschte Datei tippen, ohne es zu merken.

Aufgabe:
- Bei `doc_tombstoned` mindestens eine Obsidian Notice anzeigen.
- Pruefen, ob eine lokale Conflict-Kopie mit aktuellem Editor-Inhalt angelegt werden soll.
- Wenn Conflict-Kopie zu gross fuer diese Runde ist: klarer Minimalfix Notice plus Handoff-Hinweis.
- Test oder gezielte kleine Regression fuer Handler-Verhalten, soweit sinnvoll mockbar.

Akzeptanz:
- User bekommt ein sichtbares Signal.
- Kein stilles Weitereditieren in einen verworfenen Push-Pfad.

### 2.3 Conflict-Dateien sichtbarer oder direkt sync-aware machen

Problem: Conflict-Dateien werden angelegt, koennen aber im Initial-Sync-Fenster fuer den User unsichtbar als lokaler Sonderfall bleiben.

Aufgabe:
- Mindestens Notice: Conflict-Kopie wurde erstellt, Pfad anzeigen.
- Pruefen und wenn klein machbar: Conflict-Datei direkt in DocumentManager laden, Loro-State persistieren und zum Server pushen.
- Keine grosse Architekturarbeit, wenn der sichere Minimalpfad reicht.

Akzeptanz:
- User weiss sofort, dass eine Conflict-Kopie existiert.
- Nach Smoke-Test werden Conflict-Kopien erwartbar synchronisiert oder der Rest-Risiko-Hinweis steht in der Anleitung.

### 2.4 README-Aussage zu Dateitypen korrigieren

Problem: README sagt "Markdown notes and text files", Code synct nur `.md`.

Aufgabe:
- README und finale Anleitung auf "nur Markdown `.md`" korrigieren.

Akzeptanz:
- Keine falsche Erwartung fuer `.txt`, Canvas, Excalidraw oder Binaries.

## Phase 3: Kleine technische Haertungsrunde Server/Ops

### 3.1 WS-Idle-Timeout pruefen und ggf. erhoehen

Problem: Live-Logs zeigen Reconnect-Churn. Server-Kommentar sagt 5 Minuten, Code nutzt 60 Sekunden; Plugin-Heartbeat liegt bei 30 Sekunden.

Aufgabe:
- Server-Code ansehen und Timeout-Absicht klaeren.
- Wahrscheinlicher Minimalfix: Server-Idle auf 120 Sekunden setzen und Kommentar korrigieren.
- Danach Server-Tests laufen lassen.
- Deploy/Restart erst nach expliziter Freigabe.

Akzeptanz:
- Kommentar und Code stimmen ueberein.
- Heartbeat hat mehr Reserve gegen Browser-/Mobile-Timer-Drosselung.

### 3.2 Tombstone-Retention dokumentieren und fuer Freundin setzen

Problem: `VAULTCRDT_TOMBSTONE_DAYS` ist relevant gegen Resurrection nach langer Offline-Zeit, aber im Onboarding unsichtbar.

Aufgabe:
- `.env.example` und Server-README um `VAULTCRDT_TOMBSTONE_DAYS` ergaenzen.
- Fuer diesen privaten Friend-Use 365 Tage empfehlen, ausser Speichergruende sprechen dagegen.
- Klaeren, ob laufender Server wirklich mit 90 oder anderem Wert laeuft. Nur read-only pruefen, keine Secret-Ausgabe.

Akzeptanz:
- Retention ist bewusst gesetzt oder bewusst als Default akzeptiert.
- Anleitung sagt, was lange Offline-Zeit bedeutet.

### 3.3 Server-README/Version/Changelog korrigieren

Problem: Server-README sagt 0.2.4, live/Cargo ist 0.2.6; das erzeugt Misstrauen.

Aufgabe:
- Server-README Status aktualisieren.
- Changelog-Luecke mindestens kurz erklaeren oder auf Releases verweisen.

Akzeptanz:
- Friend- und Betreiber-Doku widersprechen dem echten Stand nicht.

### 3.4 Backup-/Restore-Runbook schreiben

Problem: Ohne Backup-Pfad ist der Handoff nicht alltagstauglich.

Aufgabe:
- Server-Backup: SQLite-Backup-Befehl dokumentieren, inklusive WAL/SHM-Hinweis oder `.backup`-Empfehlung.
- Plugin/Vault-Backup: Vor erstem Sync Obsidian schliessen und Vault komplett kopieren/zippen.
- Rollback: Plugin deaktivieren, Vault aus Backup ersetzen, Server-Vault je nach Lage resetten oder separaten Vault-Namen nutzen.

Akzeptanz:
- Eine nicht-technische Person kann vor dem ersten Sync ein lokales Backup machen.
- Richard kann Server-Backup/Restore nachvollziehen.

### 3.5 Docker-Restart-Policy klaeren

Problem: Audit meldet fehlende oder unklare Restart-Policy.

Aufgabe:
- `docker-compose.yml` pruefen.
- Wenn keine Restart-Policy gesetzt ist, `restart: unless-stopped` erwaegen.
- Deploy erst nach Freigabe.

Akzeptanz:
- Nach Host-/Docker-Neustart kommt der Dienst erwartbar zurueck.

## Phase 4: Checks nach Code-/Doku-Aenderungen

Plugin-Checks:

```bash
bun run wasm:check
bun run test
bun run build
```

Bei TypeScript-Aenderungen zusaetzlich:

```bash
bunx tsc --noEmit
```

Bei Rust-Crate-Aenderungen im Plugin:

```bash
cargo fmt --all
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace
```

Server-Checks bei Server-Aenderungen:

```bash
cd ../vaultcrdt-server
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

Akzeptanz:
- Alle relevanten Checks sind gruen.
- Falls ein Check bewusst ausgelassen wird, steht der Grund im Handoff.

## Phase 5: Deploy-/Release-Entscheidung

Erst nach gruenen Checks entscheiden:

1. Plugin-Version bumpen oder nur lokalen Build deployen?
2. Server-Version bumpen und Container neu bauen?
3. Server auf `home` deployen/restarten?
4. BRAT-Release fuer die Freundin noetig oder reicht aktueller Release plus Anleitung?

Akzeptanz:
- Kein Deploy/Release/Tag ohne explizites Ja von Richard.
- Live-Server-Version und Anleitung passen zusammen.

## Phase 6: Realer Smoke-Test vor Weitergabe

Smoke-Test in einem Testvault, nicht zuerst im produktiven Vault der Freundin.

### 6.1 Server vorbereiten

- Health pruefen.
- Test-Vault-ID anlegen oder bestaetigen.
- Backup vor Test ziehen.
- Logs parallel beobachten, aber keine Secrets ausgeben.

### 6.2 Erstes Geraet: frischer Push

- Obsidian mit Testvault starten.
- Plugin via BRAT oder lokalem Plugin installieren.
- Server-URL ohne trailing slash eingeben.
- Vault-ID und Passwort eingeben.
- Eine Markdown-Datei erstellen.
- Sync-Status pruefen.
- Server-Logs auf Fehler pruefen.

### 6.3 Zweites Geraet oder zweites Profil: Pull

- Gleiche Zugangsdaten eintragen.
- Datei muss erscheinen.
- Datei editieren.
- Aenderung muss auf Geraet 1 erscheinen.

### 6.4 Delete/Rename/Offline

- Datei loeschen, anderes Geraet muss Delete uebernehmen.
- Datei umbenennen, anderes Geraet muss Rename uebernehmen.
- Geraet 2 offline nehmen, Datei auf Geraet 1 editieren, Geraet 2 wieder online.
- Keine unerwarteten Conflict-Storms.

### 6.5 Server-Restart/Reconnect

Nur nach Freigabe, weil Service-Restart destruktiv/operativ ist.

- Server kontrolliert neu starten.
- Clients reconnecten.
- Keine unerwarteten Conflict-Copies.
- Reconnect-Churn nach Timeout-Fix beobachten.

### 6.6 Android-Sondertest, falls Freundin Android nutzt

- Android-Kaltstart ohne Tippen.
- Android-Kaltstart mit sofortigem Tippen.
- App in Hintergrund/Sleep, danach weiter tippen.
- Keine verlorenen Edits, kein langsamer Initial-Sync.

Akzeptanz:
- Smoke-Test-Protokoll liegt vor.
- Unerwartete Conflict-Copies werden entweder erklaert oder vor Handoff gefixt.

## Phase 7: Finale Freundin-Anleitung

Zu schreiben als kurze Markdown-Datei, z. B.:

```text
docs/freundin-handoff.md
```

Inhalt:

1. Was VaultCRDT macht und was nicht.
2. Sicherheitsmodell: kein E2E, Server sieht Daten, TLS/WSS Pflicht.
3. Vorher Backup machen.
4. Installation via BRAT.
5. Exakte Setup-Werte:
   - Server
   - Vault Name
   - Passwort
6. Erster Sync: was normal ist.
7. Was tun bei Conflict-Dateien.
8. Was tun bei rotem Status / Verbindungsproblem.
9. Rollback in 5 Schritten.
10. Kontakt/Support: was sie Richard schicken soll, ohne Secrets.

Akzeptanz:
- Eine Person kann die Anleitung Schritt fuer Schritt abarbeiten.
- Keine Admin Tokens, JWTs oder Secrets stehen in der Datei.
- Die Anleitung ist kurz genug, dass sie wirklich gelesen wird.

## Phase 8: Abschluss und Handoff

Vor dem Weiterschicken:

1. Repo-Status pruefen.
2. Alle relevanten Checks dokumentieren.
3. Falls released/deployed: Versionen und Tags dokumentieren.
4. `next-session-handoff.md` aktualisieren.
5. Audit-Zyklus kurz zusammenfassen.
6. Richard gibt final frei.

## Empfohlene Reihenfolge jetzt

1. Phase 1 kurz beantworten.
2. Phase 2.1, 2.4 und Phase 3.3/3.4 zuerst erledigen: klein, sicher, hoher Nutzen.
3. Danach Phase 2.2/2.3 und Phase 3.1/3.2.
4. Checks.
5. Smoke-Test.
6. Finale Anleitung.

## Minimalvariante, falls es schnell gehen muss

Wenn kein Code mehr angefasst werden soll, dann mindestens:

1. Backup-/Rollback-Anleitung schreiben.
2. Exakte URL ohne trailing slash in Anleitung festhalten.
3. `.md`-only und kein E2E klar sagen.
4. Server-DB-Backup ziehen.
5. Testvault-Smoke mit zwei Geraeten machen.
6. Freundin erst danach auf eigenem Vault starten lassen.

Diese Minimalvariante ist schlechter als die Haertungsrunde, aber besser als direkte Weitergabe ohne Plan.
