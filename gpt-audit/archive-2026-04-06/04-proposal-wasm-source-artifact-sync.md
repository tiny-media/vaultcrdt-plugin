# Vorschlag: WASM-Quelle und eingecheckte Artefakte sauber synchronisieren

## Ausgangsproblem

Der aktuelle Stand deutet darauf hin, dass:
- die Rust-WASM-Quelle,
- das generierte JS-Glue,
- und die commiteten Plugin-Artefakte

nicht sauber aus demselben Stand stammen.

Das ist kein sofortiger Laufzeit-Crash, aber ein Wartungsproblem mit Ansage.

---

## Warum das wichtig ist

Wenn du später:
- Bugs fixst,
- CRDT-Verhalten änderst,
- Performance verbesserst,
- oder Releases veröffentlichst,

musst du sicher sein, dass die tatsächlich ausgelieferte WASM-Schicht auch wirklich zu deiner Rust-Quelle passt.

Sonst entstehen klassische Probleme:
- „Ist das schon im Plugin drin?“
- „Warum weicht das Verhalten vom Rust-Code ab?“
- „Warum klappt ein Rebuild aus Source nicht reproduzierbar?“

---

## Meine empfohlene Änderung

## Eine klare Quelle der Wahrheit festlegen

Meine Empfehlung:
- **Rust-Quelle bleibt die fachliche Wahrheit**
- das Plugin enthält die **generierten Artefakte**, aber nur als Release-/Build-Ergebnis
- der Prozess dafür wird **explizit geskriptet und überprüft**

---

## Warum ich genau das empfehle

Weil du die Vorteile beider Welten behältst:
- die eigentliche Logik bleibt im Rust-/CRDT-Teil gebündelt
- das Plugin bleibt einfach installierbar, weil das fertige WASM mitkommt
- Releases werden reproduzierbar

---

## Konkreter sinnvoller Zielzustand

1. Ein dokumentierter Befehl oder Script baut WASM neu
2. Das Script schreibt exakt in den Plugin-`wasm/`-Ordner
3. Versionen von `wasm-bindgen`/Tooling sind gepinnt
4. CI prüft, dass generierte Artefakte aktuell sind
5. Release-Prozess enthält diesen Schritt explizit

---

## Realistische Alternativen

### Variante A — Zwei Repos behalten, aber Build/Release strikt skripten (meine Empfehlung)

#### Vorteile
- wenig Umstrukturierung
- passt zur aktuellen Architektur
- klarer nächster Schritt

#### Nachteile
- man muss Prozessdisziplin einziehen
- Cross-Repo-Änderungen bleiben etwas aufwendiger

#### Ehrliche Einschätzung
Wahrscheinlich der pragmatisch beste Weg.

---

### Variante B — WASM-Quelle näher ans Plugin ziehen

Zum Beispiel:
- CRDT-/WASM-Code im Plugin-Repo spiegeln,
- oder per Submodule/Subtree einbinden.

#### Vorteile
- weniger Distanz zwischen Quelle und Artefakt
- für Plugin-Arbeit manchmal übersichtlicher

#### Nachteile
- Gefahr von Duplikation oder Drift an anderer Stelle
- Repository-Struktur wird komplizierter

#### Ehrliche Einschätzung
Kann sinnvoll sein, wenn du merkst, dass fast alle Änderungen vom Plugin her gedacht werden. Ich würde das aber nicht als ersten Schritt wählen.

---

### Variante C — WASM als eigenes Paket/Release-Artefakt publizieren

Zum Beispiel über:
- npm package,
- GitHub release artifact,
- oder internes Paket.

#### Vorteile
- saubere Entkopplung
- moderne Lieferkette

#### Nachteile
- deutlich mehr Release-/Versionierungsaufwand
- für dein Projekt vermutlich erstmal unnötig schwer

#### Ehrliche Einschätzung
Professionell, aber für den aktuellen Projektstand eher zu groß.

---

## Meine konkrete Empfehlung

Ich würde mit **Variante A** gehen.

### Warum nicht gleich mehr?
Weil du zuerst Verlässlichkeit brauchst, nicht maximale Infrastruktur.

Ein sauberer, dokumentierter und CI-geprüfter Build-Prozess reicht hier wahrscheinlich völlig aus.

---

## Was ich im Detail sinnvoll fände

### 1. Rebuild-Script
Ein Script wie sinngemäß:
- Rust build für `wasm32-unknown-unknown`
- `wasm-bindgen`
- Ausgabe direkt in `vaultcrdt-plugin/wasm/`

### 2. Tool-Versionen festnageln
Damit nicht auf einem Rechner Artefakt A und auf dem nächsten Artefakt B entsteht.

### 3. CI-Check
Eine Prüfung wie:
- generiere WASM neu
- vergleiche mit eingecheckten Artefakten
- wenn Diff vorhanden → CI rot

### 4. README/Release-Doku korrigieren
Die Doku sollte erst dann „rebuildbar“ versprechen, wenn das wirklich reproduzierbar funktioniert.

---

## Tests / Checks, die ich sehen wollen würde

1. frischer Rebuild erzeugt keine unerwarteten Diffs
2. Plugin build funktioniert mit frisch generiertem WASM
3. Rust- und Plugin-API passen zusammen
4. dokumentierter Build funktioniert auf sauberem Checkout

---

## Mein ehrliches Fazit

Das ist kein Thema, das Nutzer sofort bemerken — aber genau solche Dinge machen später den Unterschied zwischen:
- „funktioniert gerade irgendwie“ und
- „ich kann das in sechs Monaten noch sauber warten“.

Darum halte ich dieses Thema für **sehr sinnvoll**, auch wenn es kein sichtbarer Feature-Fix ist.
