# Synthese und naechste Schritte | Friend-Handoff-Stability | 2026-04-30

## Status

Zwei externe Read-only-Audits wurden ausgefuehrt:

- `audit-claude1-2026-04-30.md`
- `audit-pi-gpt55-xhigh-2026-04-30.md`

Zusaetzlich wurde per `ssh home` eine redigierte Live-Server-Beobachtung abgelegt:

- `live-server-observation.md`

## Gemeinsames Urteil

Bedingt sicher fuer einen trusted-friend-Handoff, aber noch nicht als "README schicken und los".

Die Kern-Sync-Korrektheit wirkt gut abgesichert. Es wurden keine eindeutigen akuten P0-Datenverlustfehler gefunden. Vor der Uebergabe sollten aber mehrere kleine bis mittlere P1-Haertungen und ein echter Smoke-Test erledigt werden.

## Konsolidierte Handoff-Blocker

1. **Backup-/Rollback-Anleitung fehlt.**
   - Vor erstem Sync muss die Freundin eine vollstaendige Vault-Kopie haben.
   - Server-DB-Backup/Restore muss dokumentiert sein.

2. **Minimaler Realgeraete-Smoke-Test fehlt.**
   - Frischer Testvault, BRAT-Install, erster Push/Pull, Edit/Delete/Rename, Offline-Reconnect, Server-Restart, Android-Kaltstart falls Android genutzt wird.

3. **Server-URL-Trailing-Slash ist fragil.**
   - `https://host/` kann zu `//auth/verify` und `//ws` werden.
   - Entweder sofort Code normalisieren oder in der Handoff-Anleitung hart "ohne abschliessenden Slash" schreiben. Codefix ist vorzuziehen.

4. **Live-Logs zeigen Reconnect-Churn und Conflict-Copies.**
   - Container ist healthy, aber Logs zeigen viele WS-Reconnects und am 2026-04-27 zwei Conflict-Copies.
   - Vor Handoff im Smoke-Test gezielt Server-Restart/Reconnect nachstellen.

## Starke Pre-Handoff-Kandidaten fuer eine kleine Haertungsrunde

1. Plugin: Server-URL beim Speichern normalisieren.
2. Plugin: `doc_tombstoned` nicht nur warnen, sondern Notice/Schutzpfad fuer lokale Edits.
3. Plugin: Conflict-Dateien direkt sync-aware erstellen oder mindestens Notice ausgeben.
4. Server: WS-Idle-Timeout-Kommentar korrigieren und Timeout von 60s auf 120s pruefen.
5. Server: `VAULTCRDT_TOMBSTONE_DAYS` in `.env.example`/README dokumentieren, fuer Friend-Setup eher 365 Tage empfehlen.
6. Docs: README/Install-Anleitung auf `.md`-only, Backup, Security-Modell, exakte URL und Rollback korrigieren.
7. Ops: Docker-Restart-Policy und Backup-Routine bestaetigen.

## Positive Signale

- Beide Audits berichten gruene Plugin- und Server-Checks.
- WASM-Freshness wurde als gruen berichtet.
- Live-Container `vaultcrdt-server:0.2.6` ist healthy, RestartCount 0 im Snapshot.
- Vorherige kritische Sync-Klassen sind laut Audits strukturell adressiert: stabile PeerIDs, adopt-not-merge, ack-basiertes Delete-Reconcile, sticky Tombstones, generische Auth-Fehler.

## Empfohlener naechster Arbeitsschritt

Eine kleine Haertungsrunde mit Fokus auf:

1. URL-Normalisierung im Plugin.
2. Backup-/Rollback-/Security-Doku fuer Friend-Handoff.
3. Server-Retention-/README-Korrekturen.
4. Danach Realgeraete-Smoke-Test.

Danach erst die endgueltige Freundinnen-Anleitung schreiben.
