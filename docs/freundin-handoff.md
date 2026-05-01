# VaultCRDT fuer deinen Obsidian-Vault

Diese Anleitung ist fuer die private Nutzung von VaultCRDT mit Richards Server.

## Kurz gesagt

VaultCRDT synchronisiert Markdown-Notizen (`.md`) zwischen deinen Obsidian-Geraeten ueber Richards Server. Es synchronisiert derzeit keine Bilder, PDFs, Canvas-Dateien, Excalidraw-Dateien oder andere Binaries.

## Wichtiges Sicherheitsmodell

VaultCRDT ist in dieser Runde nicht Ende-zu-Ende-verschluesselt.

- Die Verbindung zum Server laeuft ueber HTTPS/WSS.
- Der Server speichert Sync-Daten technisch lesbar.
- Richard kann organisatorisch zusagen, nicht in Datenbank oder Logs zu schauen, aber es gibt keine kryptographische Sperre.
- Sende bei Problemen keine Passwoerter, Admin Tokens oder kompletten Log-Ausgaben ungeprueft weiter.

## Vor der Installation: Backup machen

Bevor du VaultCRDT in deinem produktiven Vault aktivierst:

1. Obsidian komplett schliessen.
2. Deinen gesamten Vault-Ordner kopieren oder als ZIP sichern.
3. Das Backup ausserhalb des Vaults ablegen.
4. Erst danach Obsidian wieder starten und VaultCRDT einrichten.

Ohne dieses Backup sollte der erste Sync nicht gestartet werden.

## Zugangsdaten

Richard gibt dir separat:

- Server-URL
- Vault-Name
- Passwort

Das Passwort nicht im Vault speichern. Einen Admin Token brauchst du nicht.

## Installation mit BRAT

1. In Obsidian: Einstellungen -> Community plugins.
2. Safe mode ausschalten, falls noetig.
3. BRAT installieren und aktivieren.
4. In den BRAT-Einstellungen `Add Beta plugin` waehlen.
5. Repository eintragen:
   `https://github.com/tiny-media/vaultcrdt-plugin`
6. Plugin installieren und aktivieren.

## Erste Einrichtung

1. VaultCRDT oeffnen.
2. Server-URL, Vault-Name und Passwort eintragen.
3. Server-URL ohne Passwort oder Token verwenden.
4. Setup abschliessen.
5. Obsidian waehrend des ersten Syncs offen lassen.

Auf Desktop sollte Sync laufen, solange Obsidian offen ist. Auf iPad und Android kann das Betriebssystem Hintergrund-Sync pausieren; oeffne Obsidian aktiv, wenn du sicher synchronisieren willst.

## Was normal ist

- Neue oder geaenderte `.md`-Notizen erscheinen auf den anderen Geraeten, wenn Obsidian dort offen ist.
- Nach laengerem Offline-Betrieb kann der erste Sync etwas dauern.
- Bei Konflikten erstellt VaultCRDT eine Kopie mit einem Namen wie:
  `<datei> (conflict <datum>).md`

## Wenn eine Conflict-Datei erscheint

1. Beide Dateien oeffnen.
2. Die Inhalte vergleichen.
3. Behaltene Aenderungen in die richtige Datei uebernehmen.
4. Die Conflict-Datei erst loeschen, wenn du sicher bist.
5. Wenn unklar ist, was passiert ist: Richard fragen und keine Passwoerter mitschicken.

## Wenn eine Tombstone-Warnung erscheint

Eine Tombstone-Warnung bedeutet: Der Server kennt diese Datei als geloescht und hat einen Push auf diesen Pfad abgelehnt.

Dann bitte:

1. Nicht weiter in dieser Datei arbeiten.
2. Inhalt bei Bedarf in eine neue Datei kopieren.
3. Richard den Dateipfad und die ungefaehre Aktion beschreiben, aber kein Passwort senden.

## Bei Verbindungsproblemen

Pruefe zuerst:

1. Ist Obsidian offen?
2. Besteht Internetverbindung?
3. Stimmen Server-URL, Vault-Name und Passwort?
4. Ist die Server-URL ohne angehaengten Slash eingegeben?

Wenn du Richard etwas schickst, dann nur:

- Geraet und Betriebssystem.
- Uhrzeit des Problems.
- Ob es beim Start, beim Editieren, beim Loeschen oder nach Offline-Betrieb passiert ist.
- Screenshot der VaultCRDT-Statusmeldung, falls sichtbar.

Nicht schicken:

- Passwort.
- Admin Token.
- komplette Logs, bevor sie auf Secrets geprueft wurden.

## Rollback

Wenn der erste Sync unerwartet schiefgeht:

1. Obsidian schliessen.
2. VaultCRDT im betroffenen Vault deaktivieren oder den Plugin-Ordner entfernen.
3. Den aktuellen Vault-Ordner beiseitelegen, nicht sofort loeschen.
4. Das Backup von vor der Installation zurueckkopieren.
5. Obsidian wieder starten und Richard informieren.

Falls auch der Server-Vault zurueckgesetzt werden muss, macht Richard das separat auf dem Server.
