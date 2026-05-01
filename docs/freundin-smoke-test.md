# Smoke-Test vor Freundin-Handoff

Ziel: Vor dem produktiven Vault der Freundin beweisen, dass Release, Server und Anleitung zusammen funktionieren.

## Voraussetzungen

- Plugin-Release ist veroeffentlicht.
- Server-Release ist deployed.
- Server-Backup wurde vor dem Deploy gezogen.
- Test-Vault-ID ist bekannt und enthaelt keine produktiven Daten.
- Keine Secrets werden in Notizen, Git oder Logs kopiert.

## 1. Server-Basischeck

1. Health-Endpunkt pruefen.
2. Laufende Server-Version pruefen.
3. Tombstone-Retention fuer den privaten Betrieb pruefen, Zielwert: 365 Tage oder bewusst akzeptierte Abweichung.
4. Logs nur auf Fehler/Warnings pruefen, keine Secrets ausgeben.

## 2. Desktop: erster Push

1. Frischen lokalen Testvault anlegen.
2. Plugin ueber BRAT oder lokales Deploy installieren.
3. Server-URL, Test-Vault-ID und Passwort eintragen.
4. `smoke-a.md` erstellen.
5. Sync-Status abwarten.
6. Server-Logs auf Fehler pruefen.

Akzeptanz: Datei ist ohne Fehler auf dem Server angekommen.

## 3. Zweites Geraet oder zweites Profil: Pull und Edit

1. Zweiten frischen Testvault verbinden.
2. `smoke-a.md` muss erscheinen.
3. Datei auf Geraet 2 editieren.
4. Aenderung muss auf Geraet 1 erscheinen.

Akzeptanz: Bidirektionaler Sync funktioniert.

## 4. Delete, Rename, Offline

1. Datei auf Geraet 1 loeschen, Geraet 2 muss Delete uebernehmen.
2. Neue Datei erstellen und umbenennen, Rename muss auf dem anderen Geraet erscheinen.
3. Geraet 2 offline nehmen.
4. Auf Geraet 1 editieren.
5. Geraet 2 wieder online nehmen.

Akzeptanz: Keine unerwarteten Conflict-Storms, keine verlorenen Edits.

## 5. Mobile aktiv-offen Sync

Je Zielplattform mindestens bewusst testen oder als Einschraenkung akzeptieren:

- iPad/iOS: Obsidian aktiv oeffnen, Aenderung empfangen und senden.
- Android: Kaltstart ohne Tippen, danach Kaltstart mit sofortigem Tippen.

Akzeptanz: Sync funktioniert bei aktiv geoeffnetem Obsidian. Hintergrund-Sync wird nicht garantiert.

## 6. Server-Restart/Reconnect

Nur nach operativer Freigabe ausfuehren.

1. Clients verbunden lassen.
2. Server kontrolliert neu starten.
3. Clients reconnecten lassen.
4. Eine kleine Aenderung in beide Richtungen testen.

Akzeptanz: Reconnect ohne manuelles Reset, keine unerwarteten Conflict-Kopien.

## 7. Produktivfreigabe

Der produktive Vault der Freundin darf erst verbunden werden, wenn alle Punkte erfuellt sind:

- Lokales Vollbackup des Freundin-Vaults wurde bestaetigt.
- Server-Backup liegt vor.
- Smoke-Test ist bestanden oder Abweichungen sind bewusst akzeptiert.
- Richard sagt explizit: `Freigabe: Produktiv-Handoff an Freundin mit Richards Server.`
