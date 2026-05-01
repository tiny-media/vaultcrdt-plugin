# Guide | E2E-Test-Workflow für Coding-Projekte

Stand: 2026-04-22

## Zweck

Dieser Guide beschreibt den **kleinen kanonischen E2E-Workflow** für Coding-Projekte in diesem Setup.

Er soll der Projektleiterin und später auch AGs helfen, E2E nicht jedes Mal neu zu erfinden.

Ziel ist **nicht**:
- ein riesiges Universal-Testframework vorzuschreiben
- jede UI über denselben schweren Browser-Loop zu jagen
- MCP automatisch zum Default zu machen

Ziel ist:
- einen kleinen übertragbaren Standard für agent-assistierte E2E-Läufe festzuschreiben
- Smoke, Regression und Live-Debug sauber zu trennen
- die Werkzeugwahl bewusst und klein zu halten
- Artefakte und Rückführung diszipliniert zu halten

## Kanonische Grundregeln

1. **CLI-first** für agent-assistierte Frontend-E2E.
2. **Repo-nativer validierter Testpfad gewinnt lokal** gegen den abstrakten projektübergreifenden Default.
3. Wenn ein Projekt **noch keinen** validierten kleinen E2E-Pfad hat, ist **Playwright CLI** der erste projektübergreifende Default-Kandidat.
4. **Bun.WebView / bunwv** ist der wichtigste leichte Zweitpfad, wenn ein Projekt damit lokal bereits gut funktioniert oder bewusst einen sehr kleinen Chrome-/CDP-nahen Pfad will.
5. **Chrome remote debugging / CDP attach** ist der Default für Live-Attach/Debug, nicht für committed Regression.
6. **MCP ist nicht der Default**.
7. Frontend-E2E läuft bevorzugt in einer **separaten frischen Test-Session** und wird nur kompakt in die Coding-/Steuer-Session zurückgeführt.

## Die drei E2E-Modi

### 1. Deterministischer Smoke
Für:
- 1–3 kleine, bedeutungsvolle Journeys
- schnelle lokale Validierung
- grüner Vor-/Nachlauf bei Änderungen

Beispiele:
- Login funktioniert
- CMS-Grundpfad lädt
- Formular kann erfolgreich abgeschickt werden
- Publishing-/Kontakt-/Checkout-Grundpfad lebt noch

### 2. Deterministische Regression
Für:
- wiederholbare, bewusst stabilisierte Journeys
- committed Projektpfade
- spätere CI- oder Release-Relevanz

Wichtig:
- nicht jeder Smoke ist automatisch schon Regression
- erst nach wiederholter grüner Praxis promoten

### 3. Live Attach / Debug
Für:
- SSO / 2FA / reale Sessionzustände
- schwer reproduzierbare Bugs
- Browserzustände, Cookies, reale Nutzerpfade

Wichtig:
- methodisch eigener Modus
- **nicht** automatisch gleichbedeutend mit Regression

## Der kanonische E2E-Workflow v0

### 1. Testfrage klein schneiden
Vor jedem Lauf explizit festhalten:
- welcher Benutzerpfad genau geprüft wird
- was als Erfolg zählt
- welcher kleinste Fehlerbeweis reicht
- welcher Modus gemeint ist:
  - Smoke
  - Regression
  - Live Attach / Debug

Faustregel:
- lieber **1 klarer Flow** als 8 halbklare Klickketten

### 2. Billigen Vorlauf zuerst fahren
Bevor Browser-E2E startet:
- lint
- typecheck
- build
- unit
- kleine Integrationschecks

Wenn dieser Block schon rot ist, ist Browser-E2E oft noch nicht der richtige erste Schritt.

### 3. Tool-Lane bewusst wählen

#### Lane A — repo-nativer validierter E2E-Pfad
Nutzen, wenn das Projekt ihn bereits hat und er klein/praktisch ist.

Beispiele:
- kleines projektinternes Bun.WebView-Recipe
- kleines `@playwright/test`-Smoke-Recipe
- vorhandener schlanker CMS-/Site-Smoke

Das ist der **erste lokale Default**, wenn er schon existiert und in echter Praxis grün war.

#### Lane B — Playwright CLI
Nutzen, wenn:
- das Projekt noch keinen validierten kleinen Pfad hat
- ein agentischer CLI-Flow schnell gebraucht wird
- gute Artefakte und robustere Interaktionsführung wichtiger sind als absolute Minimalität

Das ist der wichtigste **projektübergreifende Default-Kandidat**.

#### Lane C — Bun.WebView / bunwv
Nutzen, wenn:
- ein sehr kleiner Chrome-/CDP-naher Pfad gewünscht ist
- das Projekt bereits einen funktionierenden Bun-Pfad hat
- wenig Output und schnelle kleine Flows wichtiger sind als maximale Diagnostik

#### Lane D — Chrome CDP Attach
Nutzen, wenn:
- reale Session wiederverwendet werden soll
- Live-Debug wichtig ist
- Login-/Auth-/SSO-Situationen anders kaum prüfbar sind

#### Nicht Default — MCP
Nur bewusst nutzen, wenn ein spezialisierter Agent-Loop den Mehrwert wirklich rechtfertigt.

## Session- und Worker-Regel

Frontend-E2E soll die Projektleiterin- oder AG-Session nicht mit Browser-Rohmaterial aufblasen.

Darum bevorzugt:
- eigene frische Test-Session
- eigener Task
- kompakte Rückführung

### Praktischer Pi-Default für kleine E2E-Tasks
- **tiny green-path smoke:** `gpt-5.3-codex` + `low`
- **normaler lokaler E2E-Task:** `gpt-5.3-codex` + `low` oder `medium`
- **drift / flaky path / test-repair / tiefere Browser-Triage:** `gpt-5.4` + `high`

Wichtig:
- Thinking nur hochziehen, wenn die Reibung es wirklich verlangt
- nicht jeden kleinen Test künstlich auf schweres Modellniveau heben

## Ausführungsregeln

### 1. Flows klein halten
Praktische Zielgröße:
- 1–3 Journeys
- je Journey nur die entscheidenden Schritte
- keine Browser-Wanderdünen

### 2. Erfolgssignale explizit machen
Pro Flow sollte klar sein:
- URL / Redirect
- H1 / Status / Notice
- eine bedeutungsvolle UI-Veränderung
- optional: Sync-/Publish-Effekt oder sichtbarer Site-Effekt

### 3. Fehlerartefakte standardisieren
Bei Fehlschlag möglichst klein und belastbar sichern:
- Screenshot
- Snapshot oder DOM-/State-Hinweis
- Console
- Network
- optional Trace

### 4. Scope bei Fehlern nicht explodieren lassen
Wenn ein Lauf rot wird:
1. kleinsten Blocker benennen
2. Artefaktpfad sichern
3. nur dann Scope ausweiten, wenn das wirklich nötig ist

## Rückgabeformat in die Steuer-Session

In die Projektleiterin-/AG-Session zurückführen:
- `PASS` oder `FAIL`
- kleinster Blocker
- Artefaktpfad
- falls relevant: ob der Fehler eher
  - Produktfehler
  - Runner-Drift
  - Setup-Problem
  - Timing-/Watcher-Reibung
  ist

Nicht standardmäßig zurückführen:
- lange Browser-Snapshots
- komplette Console-Dumps
- rohe Network-Fluten
- endlose Tool-Ausgaben

## Wann ein Flow von Smoke zu Regression wird

Ein Flow soll erst dann als projektweiter Regression-Default gelten, wenn er:
1. in echter Praxis mehrfach grün lief
2. ohne manuelle Sondergriffe reproduzierbar ist
3. klaren geschäftlichen oder operativen Wert hat
4. bei Fehlern sinnvolle Artefakte liefert
5. klein genug bleibt, um regelmäßig gelaufen zu werden

## Was jede Projektleiterin pro Projekt festlegen soll

Jedes Projekt braucht eine kleine projektnahe E2E-Routine mit mindestens:
- billigem Vorlauf
- Default-Smoke-Pfad
- Default-Live-Attach-/Debug-Pfad
- Artefaktpfad
- Startup-/Login-/Bootstrap-Hinweisen
- Worker-Level-Default

Dafür dient das Template:
- `setup-paket/templates/projekt-e2e-routine-template.md`

## Entscheidungshilfe in Kurzform

| Situation | Empfohlener Weg |
| --- | --- |
| Repo hat schon kleinen validierten E2E-Pfad | zuerst diesen nutzen |
| Repo hat noch keinen kleinen validierten E2E-Pfad | Playwright CLI |
| sehr kleiner Chrome-basierter Operator-Flow gewünscht | Bun.WebView / bunwv |
| reale Session / SSO / 2FA / Bugdiagnose | Chrome CDP Attach |
| kleiner grüner Smoke-Task | `gpt-5.3-codex` + `low` |
| Testpfad driftet oder Browserverhalten ist unklar | `gpt-5.4` + `high` |

## Für Richard

Der belastbare Kern ist jetzt:
- erst **billig prüfen**, dann Browser
- **Smoke, Regression und Live-Debug** sauber trennen
- **repo-nativen kleinen Pfad zuerst** nutzen, falls es ihn schon gibt
- sonst **Playwright CLI** als projektübergreifenden Default nehmen
- **Bun.WebView / bunwv** als leichten Zweitpfad bewusst einsetzen
- **kleine Pi-Worker** reichen für normale lokale E2E oft aus; höheres Thinking lohnt erst bei Drift, Flakes oder Test-Reparatur
