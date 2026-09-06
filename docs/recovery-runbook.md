# VaultCRDT Recovery- und Konflikt-Runbook

Dieses Runbook ist fuer Friend/Family-Nutzung gedacht: zuerst Inhalte sichern, dann Ursache klaeren. Keine Passwoerter, Admin Tokens oder ungepruefte Logs weitergeben.

## Grundregeln

1. Wenn etwas ungewoehnlich aussieht: Obsidian auf dem betroffenen Geraet offen lassen und nicht hektisch Dateien loeschen.
2. Wichtige lokale Textaenderungen sofort in eine neue Markdown-Datei mit anderem Namen kopieren.
3. Trash/Papierkorb und das andere synchronisierte Geraet pruefen, bevor eine Datei endgueltig geloescht wird.
4. Bei Support nur Geraet, Betriebssystem, Uhrzeit, Dateipfad und ungefaehre Aktion nennen — keine Secrets.

## Conflict-Datei

VaultCRDT erstellt eine Datei wie:

```text
Notiz (conflict 2026-06-06).md
```

Das bedeutet: Zwei Stände konnten nicht sicher automatisch zusammengefuehrt werden. VaultCRDT bewahrt beide Versionen auf.

Vorgehen:

1. Originaldatei und Conflict-Datei oeffnen.
2. Inhalte vergleichen.
3. Text, der behalten werden soll, in die gewuenschte Ziel-Datei uebernehmen.
4. Conflict-Datei erst loeschen, wenn der Inhalt wirklich geprueft wurde.
5. Danach Obsidian auf einem zweiten Geraet oeffnen und kontrollieren, ob der bereinigte Stand dort ankommt.

## Meldung: `deleted on another device`

Diese Meldung bedeutet: Der Server kennt diesen Pfad als geloescht. Eine lokale Aenderung an genau diesem Pfad wurde abgelehnt und wird nicht synchronisiert.

Seit 0.4.2 benennt VaultCRDT die lokale Datei in diesem Fall automatisch in `<Name> (deleted-remote).md` um und synchronisiert sie unter dem neuen Namen. Der alte Pfad bleibt geloescht. Die Schritte unten gelten, wenn diese Umbenennung nicht moeglich war (Datei bereits weg) oder die Meldung ohne Umbenennung erscheint.

Vorgehen:

1. Nicht weiter in dieser Datei arbeiten.
2. Wichtigen Text sofort unter einem neuen Dateinamen speichern, z. B. `Notiz gerettet.md`.
3. Lokalen Trash/Papierkorb pruefen.
4. Das andere Geraet oeffnen und syncen lassen.
5. Wenn die Datei bewusst neu angelegt werden soll: nach dem Sync unter neuem Namen oder kontrolliert neu erstellen.

## Datei wurde ausserhalb von Obsidian geaendert

Aenderungen durch git pull, Syncthing oder externe Editoren werden nur erkannt, solange Obsidian mit aktivem VaultCRDT laeuft. Wurde eine Datei bei geschlossenem Obsidian extern geaendert und hat sich die Server-Version derselben Notiz seitdem nicht geaendert, gilt die Notiz beim Start als unveraendert und wird nicht hochgeladen.

1. Die betroffene Notiz in Obsidian oeffnen und eine kleine Aenderung machen (z. B. Leerzeichen einfuegen und wieder entfernen); der naechste Push uebertraegt den vollstaendigen aktuellen Inhalt.
2. Externe Werkzeuge nur bei laufendem Obsidian auf den Vault schreiben lassen.
3. Keinen zweiten Sync-Dienst parallel auf demselben Vault betreiben.

## Datei fehlt auf Geraet B

1. Obsidian auf Geraet B aktiv oeffnen; Mobile-Hintergrundsync wird nicht garantiert.
2. Internetverbindung pruefen.
3. VaultCRDT Settings oeffnen und Serverstatus ansehen.
4. Auf Geraet A Obsidian offen lassen, bis der Sync gesendet wurde.
5. Wenn die Datei geloescht wurde: Trash auf beiden Geraeten pruefen.
6. Wenn sie weiterhin fehlt: Dateipfad, Geraete, Uhrzeit und letzte Aktion notieren.

## Server-Restore oder Backup-Rueckspielung

Nach einem Server-Restore kann der Server aelter sein als einzelne Clients. Lange offline gewesene Clients koennen alte Loeschungen oder alte Inhalte wieder anbieten.

Sichere Prozedur:

1. Clients nicht gleichzeitig wild weitereditieren lassen.
2. Nach Restore zuerst ein bekannt gutes Geraet oeffnen und syncen lassen.
3. Danach weitere Geraete einzeln oeffnen und kontrollieren.
4. Bei unerwarteten Conflict-Dateien oder Tombstone-Meldungen Inhalte sichern und nicht sofort bereinigen.
5. Restore-Befund mit Serverbetreiber klaeren.

## Vault kopiert oder aus Backup wiederhergestellt

Wenn ein kompletter Vault-Ordner (inklusive der versteckten Plugin-Einstellungen) auf ein zweites Geraet kopiert oder aus einem Backup wiederhergestellt wird, teilen sich danach beide Geraete dieselbe Geraete-Identitaet (Peer ID). Zwei Geraete auf derselben Peer-Linie koennen die Aenderungsreihenfolge durcheinanderbringen.

Sichere Prozedur:

1. Auf genau EINEM der beiden Geraete (dem kopierten/wiederhergestellten) VaultCRDT Settings oeffnen.
2. Unter `Advanced` den Knopf `Reset identity` bei `Reset device identity` druecken und im Dialog bestaetigen.
3. Das Geraet bekommt eine frische Peer ID; Notizen und lokale Historie bleiben erhalten, nur die Sync-Identitaet wechselt.
4. Nicht auf beiden Geraeten ausfuehren — sonst entstehen zwei neue Identitaeten ohne Not. Genau ein Geraet reicht.

## Was an Support weitergeben?

Weitergeben:

- Geraet und Betriebssystem.
- Uhrzeit und Zeitzone.
- Dateipfad.
- Ob es um Start, Editieren, Loeschen, Umbenennen, Offline-Betrieb oder Restore ging.
- Screenshot der VaultCRDT-Meldung, falls sichtbar.

Nicht weitergeben:

- Vault-Passwort.
- Admin Token.
- JWT/Token aus URLs.
- komplette Logs ohne vorherige Secret-Pruefung.
