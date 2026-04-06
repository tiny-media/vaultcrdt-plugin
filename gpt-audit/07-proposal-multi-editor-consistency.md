# Vorschlag: mehrere offene Editoren derselben Datei konsistent aktualisieren

## Ausgangsproblem

Aktuell wird der chirurgische Diff-Pfad für Remote-Änderungen nur auf den ersten passenden offenen Editor angewendet.

Das ist im Normalfall okay, aber bei Split-Views oder mehreren Leaves derselben Datei kann das zu inkonsistenten Ansichten führen.

---

## Meine empfohlene Änderung

## Kurzform
Wenn dieselbe Datei mehrfach offen ist, sollte der Remote-Diff auf **alle offenen Editoren dieser Datei** angewendet werden.

---

## Warum ich das sinnvoll finde

Weil aus Nutzersicht die Datei eine Datei ist.

Wenn ein Nutzer dieselbe Notiz links und rechts offen hat, ist es sehr irritierend, wenn:
- eine Ansicht aktualisiert wird,
- die andere aber hinterherhängt.

Gerade bei einem Sync-Plugin ist sichtbare Konsistenz wichtig für Vertrauen.

---

## Meine konkrete Empfehlung

### Variante A — denselben Diff auf alle passenden Leaves anwenden (meine Empfehlung)

#### Vorteile
- fachlich sauber
- passt zum mentalen Modell des Nutzers
- relativ kleiner Umbau

#### Nachteile
- etwas mehr Komplexität im Editor-Pfad
- Cursor-/Selection-Verhalten muss je Leaf sauber bleiben

#### Ehrliche Einschätzung
Das ist wahrscheinlich genau die richtige Größe für diesen Punkt.

---

## Realistische Alternativen

### Variante B — bei mehreren offenen Editoren auf `setValue` für alle zurückfallen

#### Vorteile
- einfacher als präzises Diffing pro Leaf
- trotzdem konsistente Anzeige

#### Nachteile
- gröberer Eingriff
- Cursor/Selection können stärker springen
- schlechtere UX bei aktivem Tippen

#### Ehrliche Einschätzung
Das wäre eine vertretbare Fallback-Strategie, aber nicht meine erste Wahl.

---

### Variante C — nur ersten Editor aktualisieren und auf Obsidian hoffen

#### Vorteile
- keine Arbeit

#### Nachteile
- inkonsistente Anzeige bleibt
- schlechte UX
- wirkt unfertig

#### Ehrliche Einschätzung
Für einen Community-Stand würde ich das nicht so lassen.

---

## Was ich beim Design beachten würde

1. Jede offene Editorinstanz derselben Datei separat behandeln
2. Guard-/Echo-Schutz je Datei trotzdem konsistent halten
3. Wenn ein Leaf beim Diff scheitert, dort gezielt auf Vollersatz zurückfallen
4. Andere Leaves trotzdem korrekt weiter aktualisieren

---

## Tests, die ich sehen wollen würde

1. eine Datei in zwei Leaves offen → beide aktualisieren sich
2. Cursor bleibt pro Leaf stabil in plausibler Form
3. wenn Diff in Leaf A fehlschlägt, fällt nur A zurück
4. kein Echo-Loop durch Mehrfacheditoren

---

## Mein ehrliches Fazit

Das ist kein Blocker wie Initial-Sync oder Delete-Modell.

Aber es ist eine sehr sinnvolle Qualitätsverbesserung, weil sie direkt sichtbar ist und das Gefühl stärkt:
> „Dieses Sync-System ist wirklich sauber gebaut.“
