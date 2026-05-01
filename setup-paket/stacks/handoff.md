# Stack | Handoff

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## Zweck

Dieses Dokument beschreibt den Übergang zwischen Pi und externen Task-Läufen, insbesondere Claude Code.

Ziel:
- klarer Scope
- kleines Kontextfenster
- saubere Rückmeldung zurück in die höhere Ebene

## Grundregel

Ein externer Task bekommt **nicht** die ganze Session-Geschichte.

Er bekommt:
- einen klaren Task-Auftrag
- die minimal nötigen Dateien oder Dokumente
- die nötigen Checks
- klare Erwartungen an die Task-Rückmeldung

## Standardfluss

Der v0.3-Standard ist bewusst kürzer:

```text
Auftrag -> Arbeit -> Verdichtung -> Rückkehr
```

### 1. Auftrag
Die Projektleiterin oder AG erstellt:
- einen Task-Auftrag
- bei externen Läufen optional zusätzlich ein explizites Handoff-Artefakt

### 2. Arbeit
Der externe Agent:
- liest nur den nötigen Kontext
- arbeitet nur im Scope
- liefert eine Task-Rückmeldung zurück

### 3. Verdichtung
Die Projektleiterin oder AG:
- liest die Task-Rückmeldung
- bewertet, ob der Lauf reicht oder ob ein gezielter Folge-Task nötig ist
- schreibt das Wesentliche in eine passende dauerhafte MD-Datei
  - z. B. `projektkontext.md`, AG-Notiz, Rollout-Notiz oder eine andere kanonische Notiz
- schiebt offene Schleifen in Todo oder Memory

### 4. Rückkehr
Die höhere Ebene arbeitet danach nur mit der Verdichtung weiter.

Wenn die Arbeit in derselben Pi-Session explorativ war, gilt zusätzlich:
- vor Exploration Anker setzen
- nach Verdichtung per `/return` zum Anker zurückgehen
- von dort mit Verweis auf die geschriebene Datei weiterarbeiten

Details: `../stacks/context-control.md` und `../guides/pi-anker-return-workflow.md`.

## Was ein guter externer Task braucht

Pflicht:
- klares Ziel
- klarer Scope
- klarer Nicht-Scope
- relevante Dateien / Quellen
- relevante Checks
- gewünschtes Rückgabeformat

Optional:
- Tool-Hinweise
- Modell-Hinweise
- Kontextbudget-Hinweise

## Claude Code Default für v0.2

Für Coding-Tasks ist der operative Default in diesem Setup:
- **Pi** steuert auf Projektleiterin-/AG-Ebene
- **Claude Code** führt fokussierte externe Tasks aus
- in größeren Coding-Projekten ist die **AG** normalerweise die Instanz, die diese Coding-Tasks losschickt und wieder empfängt
- die **Projektleiterin** schickt nur dann direkt einen Task los, wenn kein eigener AG-Strang nötig ist oder wenn ein kleiner direkter bzw. strangsübergreifender Lauf ansteht

Aktueller Laufstandard in Richards Umgebung:
- Launcher: `claude1` oder `claude2`
- aktuell lokal verifiziert: die Wrapper exportieren `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- für reproduzierbare dokumentierte Task-Calls in diesem Setup werden `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` und `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` explizit im Shell-Call gesetzt
- Modus: `-p` für headless Task-Läufe
- Permission-Default im aktuellen lokalen Betrieb: `--dangerously-skip-permissions`

Projektwissen für externe Claude-Läufe kommt in diesem Setup aus `.agent-memory/`, `projektkontext.md`, AG-Notizen und dem konkreten Handoff — nicht aus separatem Claude-Auto-Memory.

Modell- und Effort-Wahl werden **pro Task bewusst** gewählt.
Kein stiller Einheitsdefault für alle Coding-Läufe.

Praktische Heuristik für externe Coding-Tasks:
- `claude1` oder `claude2` mit `--model opus` + `high` oder `xhigh` für riskante, mehrdeutige oder qualitativ besonders anspruchsvolle Änderungen
- `claude1` oder `claude2` mit `--model sonnet` + `medium` oder `high` für normale fokussierte Coding-, Refactor- oder Test-Fix-Läufe
- `claude1` oder `claude2` mit `--model haiku` für kleine Quick Checks, kleine Umbauten oder billige Erstpässe

Praktische Heuristik für Pi-Tasks:
- Pi-Task-Session ist sinnvoll, wenn der Lauf klein ist, im bestehenden Kontext bleiben soll oder kein externer Coding-Worker nötig ist
- Steuerung / Architektur / schwierige Reviews: `gpt-5.5` mit `high`, bei sehr hoher Tragweite bewusst `xhigh`
- echte Repo-Agentenarbeit in Pi: `gpt-5.3-codex` mit `high`; bei validierten kleinen Smoke-/E2E-Pfaden `low` oder `medium`
- Routine, Markdown, Boilerplate und billige Erstpässe: `gpt-5.4-mini` mit `medium`
- normale gemischte Code-/Text-Aufgaben: `gpt-5.4` mit `medium` oder `high`
- `gpt-5.5-pro` bleibt vorerst optional und nur spätere Prüfinstanz, wenn verfügbar; `gpt-5.2` ist kein aktiver Default
- der Effort-/Thinking-Grad wird passend zum Scope gewählt: globaler Pi-Default ist `high`, `xhigh` nur bewusst für riskante/mehrdeutige Fälle, `medium` oder `low` für klar begrenzte Routinen, `off` nur für bewusst triviale oder billige Kleinstläufe
- wenn Modell oder Thinking wichtig sind, sollten sie im Task-Auftrag oder Handoff explizit benannt werden statt still vorausgesetzt zu werden

Diese Stellschrauben werden **pro Task bewusst** angepasst:
- `--append-system-prompt` für kleine Addenda statt kompletten Prompt-Ersatz
- eigentlicher Handoff-/Task-Prompt
- `--tools` für minimalen Tool-Scope
- `--add-dir` für Cross-Repo-Zugriff
- Modell und Effort passend zum Task-Risiko und zur Task-Größe

Details zur lokalen Runner-Wahl, zu Pi-headless-Calls und zu den aktuellen Modell-/Tool-Heuristiken stehen in `../stacks/task-delegation.md`.

Faustregeln für `--tools`:
- read-only Analyse: `Read,Bash`
- gezielte Änderungen an bestehenden Dateien: `Read,Edit,Bash`
- neue oder komplett zu überschreibende Dateien: `Read,Edit,Write,Bash`

Faustregel für Prompting:
- für echte externe Tasks **Handoff-Datei via stdin** bevorzugen
- `--system-prompt` nur verwenden, wenn der Default-Prompt bewusst ersetzt werden soll
- kleine Stil- oder Scope-Regeln als `--append-system-prompt`

## Empfohlene Call-Struktur

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --append-system-prompt "<addendum>" \
  --tools "<tool-scope>" \
  --model <model> \
  --effort <effort> \
  --add-dir <path> \
  -p < <handoff-file>
```

Nicht jeder Task braucht alle Schalter, aber dieses Muster ist der bevorzugte Startpunkt.

## Wer schickt Tasks los und wer empfängt sie wieder?

Default in Coding-Projekten:
- **AG** bereitet den operativen Coding-Task vor
- **AG** wählt Runner (`claude1`, `claude2` oder Pi), Modell und Effort passend zum Scope
- **Task** liefert seine strukturierte Task-Rückmeldung zurück an die AG
- **AG** bewertet das Ergebnis, schickt bei Bedarf gezielt nach und schreibt dann den verdichteten Stand in die passende MD-Datei zurück
- **AG** spielt echte Richtungsentscheidungen an die Projektleiterin zurück

Für kleinere Projekte oder kleinere direkte Läufe darf die **Projektleiterin** genau denselben Kreis selbst fahren:
- Auftrag erstellen
- Task losschicken oder selbst mit Anker explorieren
- Rückmeldung oder Befund empfangen
- Stand in die passende MD-Datei schreiben
- per `/return` oder schmalem Re-Entry nur mit der Verdichtung weiterarbeiten

Die Projektleiterin bleibt also steuernd über dem Strang, wird in größeren Projekten aber nicht zum normalen Ein- und Ausgangskorb jedes einzelnen Coding-Tasks.

## Fehlermodus

Wenn eine Task-Rückmeldung nicht zum Auftrag passt:

1. nicht stillschweigend als Wahrheit übernehmen
2. kurz klären, was schiefgelaufen ist:
   - Auftrag unklar?
   - Scope zu weit?
   - Kontext fehlte?
   - Task hat eigenmächtig erweitert?
3. dann bewusst entscheiden:
   - Task verwerfen
   - Task neu zuschneiden
   - Rework-Task starten
   - offene Entscheidung an Richard zurückspielen

## Für v0.2 wichtig

Der Übergang Pi -> Claude Code ist einer der wichtigsten Praxis-Checks.

Das Modell gilt erst dann als tragfähig, wenn:
- mindestens einige echte externe Tasks sauber gestartet wurden
- die Rückmeldungen für Projektleiterin oder AG wirklich gut integrierbar waren

## Templates

Passende Artefakte:
- `../templates/task-auftrag-template.md`
- `../templates/task-rueckmeldung-template.md`
- `../templates/externer-task-handoff-template.md`
- `../templates/verdichtung-template.md`
