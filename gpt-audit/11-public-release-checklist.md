# Public-Release-Checkliste

Diese Datei ist die praktische Frage in Listenform:

> Was würde ich abhaken wollen, bevor du das Projekt guten Gewissens auf GitHub zeigst oder später Richtung Obsidian Community gehst?

Sie ist bewusst pragmatisch gehalten.

---

## A. Korrektheit / Sync-Verhalten

### Muss aus meiner Sicht vor öffentlichem Teilen klar sein
- [ ] Initial-Sync überspringt keine lokal geänderten Dateien stillschweigend
- [ ] überlappende Dateien werden sauber behandelt, auch nach Offline-Phasen
- [ ] Delete + Reconnect erzeugt keine offensichtlichen Zombie-Dateien
- [ ] Rename-Verhalten ist nachvollziehbar und getestet
- [ ] Konfliktfälle führen zu verständlichem, überprüfbarem Verhalten
- [ ] externe Änderungen (Git, Syncthing, Editor außerhalb Obsidian) sind realistisch getestet

### Warum das wichtig ist
Öffentliche Nutzer verzeihen UI-Kanten eher als stille Korrektheitsfehler.

---

## B. Dateigrenzen / Pfadsicherheit

- [ ] klare Policy: welche Dateien werden überhaupt synchronisiert?
- [ ] `.obsidian/` und andere interne Pfade sind ausgeschlossen
- [ ] keine Traversal-/invaliden Pfade möglich
- [ ] nicht unterstützte Dateien werden nicht versehentlich gelöscht oder geschrieben
- [ ] Server validiert relevante Pfadregeln nicht nur clientseitig, sondern selbst ebenfalls

### Warum das wichtig ist
Sobald andere Leute dein Tool nutzen, musst du enger definieren, was „unterstützt“ ist.

---

## C. Delete-/Tombstone-Semantik

- [ ] Tombstones haben eine bewusst gewählte und dokumentierte Semantik
- [ ] stale Clients können gelöschte Dateien nicht einfach still wiederbeleben
- [ ] lokaler persistierter CRDT-State wird bei Delete sinnvoll behandelt
- [ ] Delete/Recreate am selben Pfad hat definiertes Verhalten
- [ ] entsprechende Tests existieren

### Warum das wichtig ist
Delete ist bei Sync-Systemen einer der größten Vertrauensfaktoren.

---

## D. Build- / Rebuild-Kette

- [ ] WASM-Quelle und commitete Artefakte stammen nachvollziehbar aus demselben Stand
- [ ] dokumentierter Rebuild funktioniert auf sauberem Checkout
- [ ] Release-Prozess ist beschrieben
- [ ] Build läuft warnungsfrei oder Warnungen sind bewusst erklärt
- [ ] CI prüft relevante Rebuild-/Artefakt-Konsistenz

### Warum das wichtig ist
Ein öffentliches Projekt muss nicht nur laufen, sondern auch verständlich und reproduzierbar sein.

---

## E. Security / Auth

- [ ] Vault-Secrets liegen nicht mehr im Klartext in der DB
- [ ] Verify funktioniert mit sicherem Hashverfahren
- [ ] README erklärt die Sicherheitsgrenzen ehrlich
- [ ] TLS/WSS für Produktion ist klar dokumentiert
- [ ] Query-Token-/Logging-Thema ist dokumentiert oder reduziert
- [ ] Admin-/Deployment-Hinweise sind realistisch und nicht zu optimistisch formuliert

### Warum das wichtig ist
Nicht, weil das Plugin „Enterprise“ sein muss — sondern weil öffentlich geteilte Tools eine gewisse Grundsorgfalt brauchen.

---

## F. Tests

- [ ] Plugin-Tests decken die bekannten kritischen Flows ab
- [ ] Server-Tests decken Auth, WS, Sync, Delete, Tombstones ab
- [ ] für neu gefixte Bugs gibt es Regressionstests
- [ ] mindestens ein realistischer End-to-End-Mehrgeräte-Flow ist dokumentiert oder getestet

### Warum das wichtig ist
Öffentliche Nutzer bringen unweigerlich mehr Kombinationen und Randfälle mit.

---

## G. UX / Erwartungsmanagement

- [ ] README erklärt klar, was das Tool kann
- [ ] README erklärt klar, was das Tool **nicht** kann
- [ ] Grenzen wie „keine E2E-Verschlüsselung“ stehen offen drin
- [ ] Konfliktverhalten ist verständlich beschrieben
- [ ] Installationspfad für Nicht-Entwickler ist nachvollziehbar

### Warum das wichtig ist
Viele Probleme in Community-Projekten sind eigentlich Erwartungsprobleme.

---

## H. Wartbarkeit

- [ ] wichtige Architekturentscheidungen sind dokumentiert
- [ ] die wichtigsten Sicherheits-/Datenmodellentscheidungen sind absichtlich getroffen, nicht zufällig gewachsen
- [ ] die Sync-Logik ist für dich in 3–6 Monaten noch nachvollziehbar
- [ ] neue Bugs lassen sich über Logs/Tests reproduzierbar untersuchen

### Warum das wichtig ist
Gerade wenn du es mit Freunden/Familie oder öffentlich teilst, bist du später de facto Maintainer.

---

## GitHub-Release vs. Obsidian-Community

## Für GitHub würde ich mindestens sehen wollen
- Korrektheitsthemen ordentlich verbessert
- Delete-/Tombstone-Verhalten sinnvoll gehärtet
- Pfad-/Dateityp-Regeln sauber
- WASM-Build-Prozess nachvollziehbar
- Secrets nicht mehr im Klartext
- ehrliche README

## Für Obsidian Community würde ich zusätzlich sehen wollen
- noch weniger scharfe Kanten bei UX
- möglichst warnungsfreier Build
- saubere Release-Routine
- dokumentierte Grenzen / bekannte Nicht-Ziele
- gutes Gefühl, dass Nutzer nicht leicht in Datenstress geraten

---

## Meine ehrliche Minimalformel für Public Release

Wenn ich es auf einen Satz verkürzen müsste:

> Vor einem öffentlichen Release sollten Korrektheit, Delete-Semantik, Pfadgrenzen, Build-Reproduzierbarkeit und Secret-Hygiene nicht mehr „halb fertig“ sein.

---

## Persönliche Empfehlung

Wenn du irgendwann sagst „jetzt will ich es öffentlich zeigen“, würde ich vor dem Veröffentlichen diese Frage stellen:

### Würde ich einem weniger technischen Bekannten ehrlich sagen:
> „Ja, probier es aus — und ich glaube nicht, dass es dir unnötigen Ärger macht“?

Wenn deine ehrliche Antwort darauf noch nicht „ja“ ist, lohnt sich meist noch eine Runde Härtung.
