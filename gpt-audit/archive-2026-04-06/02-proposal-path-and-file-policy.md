# Vorschlag: Klare Pfad- und Dateityp-Policy für den Sync

## Ausgangsproblem

Im Projekt ist fachlich klar gedacht: synchronisiert werden vor allem Markdown-Notizen bzw. Textdateien.

Technisch ist diese Grenze aber noch nicht konsequent eingezogen.

### Das ist problematisch aus zwei Richtungen
1. **Lokal im Plugin** können Events für Dateitypen/Pfade in den Sync rutschen, die eigentlich nicht dazugehören.
2. **Remote vom Server** wird `doc_uuid` weitgehend als Vault-Pfad behandelt.

Das ist für den Eigengebrauch oft noch okay, für einen Community-Release aber zu offen.

---

## Meine empfohlene Änderung

## Kurzform
Eine **explizite, zentral definierte Allowlist** für synchronisierbare Pfade und Dateitypen einführen — und zwar **auf Client und Server**.

## Meine konkrete Empfehlung

### Für den nächsten stabilen Stand
**Nur `.md` synchronisieren.**

Zusätzlich blockieren:
- Pfade unter `.obsidian/`
- leere Pfade
- absolute Pfade
- `..`-Traversal
- verdächtige Pfadsegmente
- Nicht-Datei-Ziele / Sonderpfade

---

## Warum ich das empfehle

Weil es die kleinste, klarste und am leichtesten wartbare Regel ist.

Wenn man später die Community bedient, ist „nur Markdown“ viel einfacher zu erklären als ein halb-offener Textdatei-Mix.

### Vorteile
- weniger Überraschungen
- weniger Support-Fälle
- weniger Edge Cases
- bessere Sicherheit gegen Unsinn oder Missbrauch
- klarere Testbarkeit

### Ehrlicher Nachteil
- manche legitimen Wünsche fallen zunächst raus, z. B. `.txt`, `.csv`, `.canvas`, `.json`

Trotzdem würde ich genau deshalb erstmal klein und sauber bleiben.

---

## Warum nicht sofort „alle Textdateien“?

Weil „Textdatei“ in der Praxis oft unschärfer ist, als es klingt:
- Welche Extensions genau?
- Was ist mit `.canvas`?
- Was ist mit `.json`, `.dataview`, `.css`, `.js`?
- Was ist mit großen Export-Dateien?
- Was ist mit plugininternen Dateien?

Sobald man hier zu locker wird, wächst die Wartungslast stark.

---

## Realistische Alternativen

### Variante A — nur `.md` (meine Empfehlung)

#### Vorteile
- sehr klar
- sehr sicher
- sehr gut dokumentierbar
- geringste Angriffsfläche

#### Nachteile
- weniger flexibel

#### Ehrliche Einschätzung
Für einen ersten stabilen öffentlichen Release ist das wahrscheinlich die beste Variante.

---

### Variante B — feste Allowlist für Textdateien

Zum Beispiel:
- `.md`
- `.txt`
- `.csv`

#### Vorteile
- etwas flexibler
- für manche Familien-/Privat-Setups praktisch

#### Nachteile
- mehr Tests
- mehr Support-Aufwand
- mehr Fragen, warum Dateityp X geht und Y nicht

#### Ehrliche Einschätzung
Machbar, aber ich würde das erst in Schritt 2 nach einem stabilen Markdown-Release öffnen.

---

### Variante C — konfigurierbare Extensions im Plugin

#### Vorteile
- maximal flexibel
- power-user-freundlich

#### Nachteile
- deutlich schwerer wartbar
- höhere Gefahr, dass Nutzer sich selbst Probleme bauen
- Server müsste dieselben Regeln kennen oder validieren

#### Ehrliche Einschätzung
Für später denkbar, für jetzt nicht mein Favorit.

---

## Was ich konkret vorschlagen würde

### 1. Eine gemeinsame Regel definieren
Eine kleine zentrale Funktion/Policy wie:
- `isSupportedSyncPath(path)`
- `isSupportedSyncFile(file)`

### 2. Clientseitig anwenden
- bei `create`
- bei `modify`
- bei `delete`
- bei `rename`
- bei Remote-Writes

### 3. Serverseitig anwenden
Der Server sollte dieselben Grundregeln noch einmal prüfen, damit nicht ein fehlerhafter oder absichtlich manipulierter Client beliebige Pfade schreiben/löschen kann.

---

## Was ich zusätzlich blockieren würde

Selbst wenn später mehr Extensions erlaubt werden, würde ich standardmäßig weiter blockieren:
- `.obsidian/`
- versteckte interne Plugin-Pfade
- leere oder invalide Pfadsegmente
- führende `/`
- `../`
- doppelte oder seltsame Normalisierungsfälle

---

## Tests, die ich sehen wollen würde

1. `.md` wird synchronisiert
2. `.png` / `.pdf` / `.zip` wird ignoriert
3. `.obsidian/...` wird ignoriert oder serverseitig abgelehnt
4. `../foo.md` wird abgelehnt
5. Remote-`doc_uuid` mit ungültigem Pfad wird nicht ins Vault geschrieben
6. Delete-Events für nicht unterstützte Dateien erzeugen keine gefährlichen Tombstones

---

## Empfehlung

Ich würde mit **Markdown-only + Pfadvalidierung auf beiden Seiten** starten.

Das ist nicht die maximal flexible Lösung, aber die Lösung mit dem besten Verhältnis aus:
- Stabilität
- Sicherheit
- Verständlichkeit
- Wartbarkeit

---

## Mein ehrliches Fazit

Wenn du es irgendwann der Obsidian-Community zeigen willst, brauchst du eine **harte, klar kommunizierte Sync-Grenze**.

Meine ehrliche Meinung: Lieber zuerst **eng, sauber und langweilig**, später bei Bedarf erweitern.
