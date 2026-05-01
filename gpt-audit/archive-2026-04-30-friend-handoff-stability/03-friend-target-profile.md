# Zielprofil fuer Freundin-Handoff | VaultCRDT

Datum: 2026-04-30
Status: Vorgaben von Richard eingetragen, noch nicht technisch umgesetzt.

## Festgelegte Zielannahmen

- Zielgeraete: PC, Mac, iPad, Android.
- Server: Richards bestehender VaultCRDT-Server.
- Vault: bestehender Vault der Freundin, nicht neu/leerer Testvault.
- Nutzung: direkt produktiv.
- Verschluesselung: keine E2E-Verschluesselung in dieser Runde.
- Datenschutzwunsch: Richard soll den Vault im Alltag nicht sehen muessen.

## Konsequenzen

### 1. Direkte Produktivnutzung erhoeht die Pflicht fuer Backups

Weil kein leerer Testvault vorgeschaltet ist, ist vor der ersten Plugin-Aktivierung zwingend:

1. Obsidian auf dem jeweiligen Geraet schliessen.
2. Den kompletten bestehenden Vault kopieren oder zippen.
3. Backup nicht im Vault selbst ablegen.
4. Erst danach VaultCRDT installieren und verbinden.

Ohne dieses Backup ist der Handoff nicht freigabefaehig.

### 2. Richard kann ohne E2E technisch nicht blind sein

Ohne Ende-zu-Ende-Verschluesselung gilt:

- Der Server speichert Sync-Daten so, dass der Betreiber sie technisch auslesen koennte.
- Server-Logs koennen Vault-Name und aktuell auch Dokumentpfade enthalten.
- Richard kann organisatorisch zusagen, nicht in DB oder Logs zu schauen, aber es gibt keine kryptographische Sperre.

Pragmatischer Datenschutz fuer diese Runde:

1. Separater Vault-Name nur fuer die Freundin.
2. Starkes, eigenes Vault-Passwort.
3. Keine Admin-/DB-Inspektion ohne Supportfall.
4. Keine Logauszuege teilen, bevor Tokens/Dateipfade geprueft sind.
5. Vor Handoff Logging pruefen und nach Moeglichkeit Dokumentpfade aus Info-Logs entfernen oder auf Debug senken.

### 3. Vier Plattformen bedeuten Smoke-Test-Pflicht

PC, Mac, iPad und Android muessen nicht alle dieselbe Hintergrund-Sync-Qualitaet haben.

Erwartung:

- Desktop PC/Mac: Sync laeuft, solange Obsidian offen ist.
- Android: Kaltstart und sofortiges Tippen muessen gezielt getestet werden.
- iPad/iOS: Hintergrundbetrieb kann vom OS pausiert werden; Sync ist zu erwarten, wenn Obsidian aktiv geoeffnet ist.

Vor Produktivfreigabe braucht es mindestens einen Smoke-Test auf jedem Zielplattform-Typ oder eine bewusst akzeptierte Einschraenkung.

## Neue Pre-Handoff-Blocker fuer dieses Zielprofil

1. **Produktiv-Backup dokumentiert und bestaetigt.**
2. **Server-Privacy-Minimum umgesetzt oder bewusst akzeptiert.**
   - Besonders: keine Dokumentpfade auf Info-Level, falls schnell machbar.
3. **Vault-ID und Passwort fuer Freundin festgelegt, aber nicht im Repo dokumentiert.**
4. **Server-Vault registriert.**
   - Nur mit expliziter Freigabe und echten Werten.
5. **Smoke-Test auf PC/Mac plus mindestens einem Mobile-Geraet.**
6. **iPad-/Android-Hinweise in der finalen Anleitung.**

## Benoetigte Angaben von Richard vor echter Einrichtung

Nicht in Git speichern:

```text
Server-URL:      <richards server url>
Vault-ID:        <kurzer name fuer freundin-vault>
Vault-Passwort:  <starkes gemeinsames passwort>
Admin-Token:     <nur lokal/temporär fuer Vault-Registrierung, nicht dokumentieren>
```

## Empfohlene technische Anpassung an den Plan

Die kleine Haertungsrunde sollte wegen des Datenschutzwunsches erweitert werden:

1. Plugin: URL-Normalisierung.
2. Plugin: `doc_tombstoned` Notice/Schutzpfad.
3. Plugin: Conflict-Notice.
4. Server: WS-Timeout/Churn pruefen.
5. Server: Retention/Backup-Doku.
6. **Server: Logging-Privacy haerten.**
   - Keine Dokumentpfade im normalen Info-Log.
   - Vault-ID im Log nur soweit fuer Betrieb noetig.
   - Loro-internal Noise auf warn/debug senken.
7. Finale Freundin-Anleitung.

## Freigabeformel

Die Weitergabe ist erst bereit, wenn Richard explizit sagt:

```text
Freigabe: Produktiv-Handoff an Freundin mit Richards Server.
```

Bis dahin keine produktive Vault-Registrierung, kein Deploy, kein Server-Restart und kein Release nur aufgrund dieses Plans.
