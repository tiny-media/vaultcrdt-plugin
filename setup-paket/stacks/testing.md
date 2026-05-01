# Stack | Testing

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## v0.3-Einordnung

Der Testing-Stack bleibt ein junger Arbeitsstandard. v0.3 macht ihn nicht schwerer, sondern hält ihn optional/projektformspezifisch: kleine Projekte bekommen Testing nur, wenn ein konkreter Testpfad gebraucht wird; Hub- und Overlay-Projekte laden ihn gezielt nach.

## Zweck

Dieses Dokument beschreibt den aktuellen projektübergreifenden Arbeitsstand für **viable Testroutinen** in Coding-Projekten.

Besonderer Fokus:
- **Frontend E2E**
- agent-assistierte Browser-Validierung
- kleine, schnelle und präzise Routinen
- niedriger Token-Verbrauch

Es soll nicht sofort eine endgültige Test-Religion festschreiben, sondern einen belastbaren **v0.2-Startpunkt** liefern.

## Zielkriterien

Gute Testroutinen in diesem Setup sollen:
- **aussagekräftig** sein
- **schnell** genug für echte Iteration bleiben
- **präzise** genug sein, um Fehler klar einzugrenzen
- **token-efficient** genug sein, um im Agent-Alltag tragfähig zu bleiben
- zwischen **Regression**, **Smoke**, **Debug** und **Exploration** sauber unterscheiden

## Grundentscheidung für v0.2

Für diesen Strang gilt vorläufig:

1. **CLI-first** ist der bevorzugte operative Pfad für agent-assistierte Frontend-E2E.
2. **MCP ist nicht der Default**, weil Tool-Schemas, Snapshot-Schleifen und laufende Kontextlast schnell zu schwer werden können.
3. Eine gute Testroutine trennt mindestens diese Ebenen:
   - **billige lokale Checks**
   - **gezielte Frontend-Smoke-/Regressionstests**
   - **attach-/debug-nahe Browservalidierung**
4. Nicht jede Projektart braucht denselben Testapparat; das Ziel ist ein **kleiner übertragbarer Default**, kein Universalmonster.

## Arbeitsmodell für projektübergreifende Test-Routinen

### 1. Billige lokale Checks zuerst
Bevor Frontend-E2E startet, sollte ein Projekt einen klaren ersten Prüfblock haben:
- lint / typecheck / build / unit / kleine integration checks
- möglichst billig und schnell
- idealerweise lokal oder im normalen Projekt-Runner

Aktuelle Bun-Relevanz:
- Bun **1.3.13** verbessert `bun test` weiter mit `--isolate`, `--parallel`, `--shard`, `--changed`
- das macht gerade für kleinere bis mittlere Projekte einen schnelleren billigen Vorlauf attraktiver

### 2. Frontend-E2E als kleine bedeutungsvolle Journeys
Frontend-E2E soll hier **nicht** „jede Seite pixelweise durchklicken“ bedeuten.

Praktische Zielgröße:
- wenige echte Benutzerpfade
- Smoke zuerst, Regression erst danach
- lieber 1–3 klare Journeys als 25 schwammige Browser-Skripte

Typische Kandidaten:
- Login / Auth / Session-Wiederaufnahme
- Formularfluss / Submission / Success-Failure-Signal
- CMS-/Admin-Grundpfad
- kritischer öffentlicher Kauf-/Kontakt-/Publishing-Pfad

### 3. Attach-/Debug-Pfad getrennt vom Regression-Pfad
Es ist methodisch wichtig, zwei Modi nicht zu vermischen:

#### A. Deterministischer Regression-/Smoke-Pfad
- frischer Browserkontext oder definierte gespeicherte Session
- reproduzierbare Schritte
- für committed Tests und wiederholbare Validierung

#### B. Live Attach-/Debug-Pfad
- attach an laufenden Browser oder vorhandene Session
- nützlich für SSO, 2FA, reproduzierte Bugs, reale Cookies, bestehende Browser-States
- sehr gut für Debug, Diagnose und agentische Zwischenvalidierung
- aber **nicht automatisch** identisch mit dem committed Regression-Pfad

## Aktueller Tool-Stand

### 1. Playwright CLI
Offizieller Befund aus der Doku:
- Playwright positioniert **Playwright CLI** explizit als **token-efficient** CLI für coding agents
- die Doku stellt Playwright CLI direkt dem MCP-Pfad gegenüber
- CLI = niedrigere Kontextlast, headless default, Sessions, skill-basierte Nutzung

Stärken:
- offizieller Pfad
- sessions und persistent state
- attach an laufendes Chrome / Edge möglich
- ref-basierte Snapshots statt ständiger Bild-/DOM-Rohmengen
- gute Brücke zwischen agentischem Gebrauch und dem etablierten Playwright-Ökosystem

Lokaler Praxisbefund auf dieser Maschine:
- `playwright-cli` ist lokal installiert auf **0.1.8**
- kleiner TodoMVC-Smoke lief erfolgreich mit:
  - 2 Todos anlegen
  - 1 Todo toggeln
  - Snapshot, Console und Screenshot als Artefakte
- auf **Fedora 43** funktionieren lokal **Chrome** und **Firefox** brauchbar
- der von Playwright geladene **WebKit**-Pfad ist lokal aktuell **nicht** verlässlich nutzbar; die Host-Warnung verweist auf Debian/Ubuntu-Paketnamen, und das konkrete Problem sind fehlende bzw. inkompatible Sonames (`libwebkitgtk-6.0`, `libjavascriptcoregtk-6.0`, `libicu*.74`, `libjpeg.so.8`)

Wichtige Eignung:
- sehr plausibler **Default-Kandidat** für agent-assistierte Frontend-E2E in Projekten mit Browser-Komplexität
- besonders stark für attach/debug und für präzise CLI-Schritte im Agent-Alltag
- auf Fedora 43 lokal aktuell am sinnvollsten über **`--browser=chrome`** oder optional **`--browser=firefox`**, nicht über den Playwright-WebKit-Pfad

### 2. Playwright MCP
Offizieller Befund aus der Doku:
- Playwright beschreibt MCP selbst als eher passenden Pfad für **specialized agentic loops**
- Playwright CLI wird explizit als der leichtere Pfad für coding agents mit großen Codebasen positioniert

Folge für dieses Setup:
- **MCP ist nicht der Default** für projektübergreifende Test-Routinen
- MCP bleibt eine Zusatzoption, wenn ein spezialisierter Agent-Loop den Mehrwert wirklich braucht

### 3. Bun.WebView
Offizieller Befund aus der Doku:
- seit **Bun 1.3.12** gibt es `Bun.WebView`
- lokale Laufzeit ist jetzt **Bun 1.3.13**
- auf macOS nutzt Bun standardmäßig **WKWebView** ohne externe Abhängigkeiten
- auf Linux/Windows nutzt Bun Chrome/Chromium via **CDP**
- `click`, `type`, `press`, `scroll`, `navigate`, `evaluate`, `screenshot`, `cdp()` sind verfügbar
- Eingaben sind native browser events mit `isTrusted: true`
- Selector-Klicks warten auf Actionability

Stärken:
- sehr kleiner, skriptbarer, CLI-naher Pfad
- attraktiv für kleine smoke/debug-Routinen oder projektnahe Hilfsskripte
- besonders interessant für macOS/WebKit ohne zusätzliche Browser-Automation-Downloads
- roher CDP-Zugriff bei Chrome-Backend möglich

Wichtige Einordnung:
- **vielversprechend**, aber noch stärker validierungsbedürftig als Playwright CLI
- API ist laut Bun weiterhin **experimental**
- eher Kandidat für kleine projektnahe Testhelfer oder sehr schlanke Browserflows

### 4. Chrome Remote Debugging / CDP
Nützlicher 2026-Pfad:
- laufendes Chrome kann mit `--remote-debugging-port=9222` oder über den Chrome-Remote-Debugging-Mechanismus geöffnet werden
- CDP-Endpunkte liegen dann typischerweise unter:
  - `/json/version`
  - `/json/list`
  - `/json/protocol`
- damit lassen sich bestehende Browser-Sessions oder reale Debug-Situationen gezielt übernehmen

Beispiel:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="/tmp/cms-test"
```

Oder – je nach System/Alias – entsprechend `chrome` / `chromium`.

Wichtige Einordnung:
- sehr gut für **Live Attach**, Debug und reale Session-Zustände
- nicht automatisch der beste committed Regression-Pfad

### 5. `bunwv`
Aktueller Befund:
- `bunwv` ist ein externer, agent-first CLI-Wrapper auf Basis von `Bun.WebView`
- nutzt Daemon + CLI-Kommandos + stabile Exitcodes + JSON-Fehlerpfad
- versucht genau das zu sein, was diese AG interessant findet: **kleine CLI-first Browsersteuerung für Agenten**

Lokaler Praxisbefund auf dieser Maschine:
- `bunwv` ist lokal installiert und mit dem lokalen Chrome-Pfad nutzbar
- kleiner TodoMVC-Smoke über `--backend chrome --chrome-path /usr/bin/google-chrome` lief erfolgreich mit:
  - 2 Todos anlegen
  - 1 Todo toggeln
  - JS-Verifikation per `evaluate`
  - Screenshot-Artefakt
- `bunwv --version` liefert in dieser CLI-Form keinen klassischen Versionsstring; Presence sollte daher über `command -v bunwv` bzw. einen echten Start-/Status-Check geprüft werden

Wichtige Einordnung:
- vielversprechendes Beispiel
- aber aktuell **kein offizieller Plattform-Default**
- auf Linux/Fedora lokal sinnvoll als **Chrome-basierter Minimalpfad**, nicht als abstrakte „läuft bestimmt überall gleich“-Annahme
- sollte erst nach realem Testlauf stärker empfohlen werden

## Vorläufiger Default für v0.2

### Für projektübergreifende agent-assistierte Frontend-E2E
Der aktuelle Startpunkt lautet:

1. **Ein bereits validierter repo-nativer kleiner E2E-Pfad gewinnt lokal** gegen den abstrakten projektübergreifenden Default.
2. Wenn ein Projekt **noch keinen** solchen kleinen validierten Pfad hat, ist **Playwright CLI** der wichtigste projektübergreifende Default-Kandidat.
3. **Bun.WebView** bzw. kleine Wrapper wie `bunwv` sind der wichtigste leichte Zweitpfad für kleine projektnahe Browserflows und Hilfsskripte.
4. **Chrome remote debugging / attach** ist der bevorzugte Live-Debug- und Session-Reuse-Pfad.
5. **MCP nicht default**, nur Zusatzweg.

### Lokale Lesart nach kleinem Praxisvergleich auf Fedora 43
Für den kleinen Chrome-basierten TodoMVC-Smoke zeigte sich lokal:
- **Playwright CLI** war deutlich reichhaltiger bei Artefakten und Interaktionskontext
  - ref-basierte Snapshots
  - automatisch sichtbare Console-Hinweise
  - Screenshot ohne Zusatzlogik
- **`bunwv`** war deutlich leichter und schneller im kleinen Smoke
  - grober Kaltlauf hier: ca. **1.8s** vs. ca. **7.3s** für den vergleichbaren Playwright-CLI-Lauf
  - wesentlich weniger CLI-Output
- dafür liefert `bunwv` weniger automatische Fehlersichtbarkeit und verlangt eher explizite Selector-/`evaluate`-Arbeit

Vorläufige lokale Schlussfolgerung:
- **Playwright CLI bleibt der stärkere Default** für agentische Smoke-/Debug-Läufe, wenn Artefakte und robuste Interaktionsführung wichtiger sind als absolute Minimalität
- **`bunwv` bleibt der spannendste Minimalpfad** für sehr kleine Chrome-basierte Flows, wenn maximale Leichtgewichtigkeit zählt
- ein fairer nächster Beweis muss jetzt in **einem realen Zielprojekt** passieren

## Kanonischer E2E-Workflow v0

Der kleine projektübergreifende Standard lautet jetzt:

1. **Testfrage klein schneiden**
   - genau 1 klarer Flow oder 1–3 kleine Journeys
   - klarer Erfolgssignal-Satz statt vager Browsererkundung
2. **billigen Vorlauf zuerst fahren**
   - z. B. lint / typecheck / build / unit / `bun test`
3. **Modus bewusst wählen**
   - deterministischer Smoke
   - deterministische Regression
   - Live Attach / Debug
4. **Tool-Lane bewusst wählen**
   - zuerst repo-nativen validierten kleinen Pfad
   - sonst Playwright CLI
   - Bun.WebView / `bunwv` als leichter Zweitpfad
   - Chrome CDP attach für Live-Debug
5. **eigene Test-Session nutzen**
   - Browser-E2E bevorzugt nicht in Projektleiterin-/AG-Session aufblasen
   - kleine lokale Pi-Defaults:
     - tiny smoke: `gpt-5.3-codex` + `low`
     - normaler lokaler E2E-Task: `gpt-5.3-codex` + `low` oder `medium`
     - drift / flaky path / test-repair: `gpt-5.4` + `high`
6. **Fehlerartefakte klein und belastbar sichern**
   - Screenshot, Snapshot/State-Hinweis, Console, Network, ggf. Trace
7. **kompakt zurückführen**
   - `PASS | FAIL`
   - kleinster Blocker
   - Artefaktpfad
   - falls relevant: Produktfehler vs. Runner-Drift vs. Setup-Problem
8. **Smoke erst nach echter Praxis zu Regression promoten**
   - mehrfach grün
   - reproduzierbar
   - klein genug für regelmäßige Nutzung
   - sinnvolle Artefakte bei Fehlern

Für den operativen Guide und die projektnahe Vorlage siehe zusätzlich:
- `setup-paket/guides/e2e-test-workflow-fuer-coding-projekte.md`
- `setup-paket/templates/projekt-e2e-routine-template.md`

## Was bewusst noch nicht entschieden ist

Noch offen:
- ob Playwright CLI wirklich der allgemeine projektübergreifende Default bleibt
- wie stark Bun.WebView kleine Projekte vereinfachen kann
- ob `bunwv` oder ein ähnlicher Minimalwrapper später als empfohlenes Tool taugt
- welche committed Regression-Suite wir projektübergreifend am ehesten empfehlen: rein projektlokal, meist `@playwright/test`, oder noch etwas anderes
- wie stark sich kleine Webseiten und größere App-Plattformen in ihrer finalen Testroutine unterscheiden müssen

## Nächste Validierungsschritte

1. Den neuen E2E-Workflow und das Projekt-Template in weiteren echten Projekten anwenden
2. Prüfen, ob der Satz **repo-nativer kleiner Pfad zuerst, sonst Playwright CLI** projektübergreifend stabil trägt
3. Geschwindigkeit, Präzision, Tokenlast, Reibung und Fehlersichtbarkeit weiter nur aus echten Zielprojektpässen vergleichen
4. Auf Linux/Fedora die Vergleichsläufe bewusst **Chrome-basiert** anlegen statt Zeit in den aktuell wackligen Playwright-WebKit-Pfad zu investieren
5. Erst danach schärfer entscheiden, was projektübergreifender Default bleibt und was nur projektspezifische Ausnahme ist

## Schnittstelle zum Arbeitsmodell

- **AG Test** hält den projektübergreifenden Test-Strang zusammen
- konkrete Testläufe in einzelnen Projekten bleiben **AG- oder Task-Arbeit im Zielprojekt**
- committed Tests und echte Projekt-SSOT bleiben im jeweiligen Zielprojekt, nicht zentral hier

Dieses Dokument beschreibt also die **projektübergreifende Routine-Schicht**, nicht die vollständige Testwahrheit jedes einzelnen Repos.
