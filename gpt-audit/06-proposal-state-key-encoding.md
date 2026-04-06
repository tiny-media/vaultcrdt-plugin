# Vorschlag: kollisionsfreies Encoding für lokale `.loro`-State-Dateien

## Ausgangsproblem

Die aktuelle Ableitung des Dateinamens für lokale CRDT-State-Dateien ist einfach, aber nicht kollisionsfrei.

Das bedeutet: zwei verschiedene Vault-Pfade können denselben `.loro`-Dateinamen erzeugen.

Das ist selten, aber wenn es passiert, ist es gefährlich, weil dann zwei Dokumente denselben lokalen Persistenzzustand teilen oder überschreiben können.

---

## Meine empfohlene Änderung

## Kurzform
Ein **kollisionsfreies, reversibles Encoding** für den kompletten Pfad verwenden.

### Meine Empfehlung
`encodeURIComponent(filePath)` als Basis für den State-Key.

Beispiel-Idee:
- `notes/daily.md` → `notes%2Fdaily.md.loro`

Man kann zusätzlich die `.md`-Behandlung bewusst vereinfachen oder den ganzen Pfad unverändert kodieren.

---

## Warum ich das sinnvoll finde

Weil es:
- sehr einfach ist,
- praktisch überall funktioniert,
- keine Kollisionen aus dem bisherigen Slash/Underscore-Trick mehr hat,
- und trotzdem noch halbwegs lesbar/debuggbar bleibt.

---

## Ehrliche Alternativen

### Variante A — `encodeURIComponent` (meine Empfehlung)

#### Vorteile
- sehr einfach
- reversibel
- gut testbar
- keine Zusatz-Mapping-Datei nötig

#### Nachteile
- Dateinamen werden etwas unschöner
- `%`-kodierte Namen sind nicht super hübsch

#### Ehrliche Einschätzung
Für diesen Zweck wahrscheinlich die pragmatisch beste Lösung.

---

### Variante B — Base64url des vollständigen Pfads

#### Vorteile
- sicher als Dateiname
- ebenfalls kollisionsfrei

#### Nachteile
- schlechter lesbar
- Debugging unbequemer

#### Ehrliche Einschätzung
Technisch gut, aber für manuelle Diagnose weniger freundlich.

---

### Variante C — Hash + Mapping-Datei

#### Idee
- Dateiname basiert auf Hash
- separate Mapping-Datei merkt sich Pfad → State-Datei

#### Vorteile
- sehr robust
- auch bei sehr exotischen Pfaden gut kontrollierbar

#### Nachteile
- mehr Komplexität
- weiteres Metadatenobjekt, das konsistent bleiben muss

#### Ehrliche Einschätzung
Für dieses Projekt vermutlich unnötig komplex.

---

## Migrationsgedanke

Das Thema ist klein, aber die Migration sollte bedacht sein.

### Meine Empfehlung
Für eine Übergangszeit:
1. beim Laden zuerst neuen Key versuchen
2. wenn nicht vorhanden, alten Key versuchen
3. beim nächsten Speichern nur noch neuen Key schreiben
4. alte Keys später bereinigen

### Warum ich das empfehle
- möglichst wenig Risiko für bestehende Nutzer
- kein harter Reset nötig
- man kann Altlasten schrittweise entsorgen

---

## Tests, die ich sehen wollen würde

1. zwei bisher kollidierende Pfade erzeugen unterschiedliche Keys
2. Speichern/Laden funktioniert weiter
3. Migration von altem auf neues Schema funktioniert
4. Orphan-Cleanup löscht später alte verwaiste Keys

---

## Mein ehrliches Fazit

Das ist kein glamouröser Fix, aber ein sehr guter „Qualitäts-Fix“.

Gerade weil das Problem selten ist, lohnt es sich, es zu beheben, **bevor** später jemand in eine schwer erklärbare State-Kollision läuft.
