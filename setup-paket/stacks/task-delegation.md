# Stack | Task Delegation

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## v0.3-Einordnung

Die Runner-Heuristiken aus v0.2 bleiben als Arbeitsstand gültig. v0.3 ändert nicht zuerst die Runner, sondern trennt klarer: **Context Control** schützt Projektleiterin/AG-Kontexte; **Task Delegation** wählt Runner, Modell, Tool-Scope und Effort/Thinking für scoped Arbeit.

## Zweck

Dieses Dokument beschreibt, wie fokussierte Tasks aus **Projektleiterin** oder **AG** heraus praktisch delegiert werden.

Es ergänzt `stacks/handoff.md`:
- `handoff.md` beschreibt den **methodischen Kreis**
- dieses Dokument beschreibt die **Runner-, Tool-, Modell- und Effort-/Thinking-Wahl** für echte Task-Läufe

Ziel:
- kleiner, expliziter Runner-Standard statt versteckter Gewohnheiten
- lokaler Realitätsabgleich statt älterer Tool-Annahmen
- reproduzierbare Task-Calls für Claude Code und Pi
- Nachschärfung aus echter Praxis statt aus bloßer Theorie

Für das kleine projektübergreifend verlinkbare Betriebsblatt siehe zusätzlich `../guides/externe-task-runs-claude-pi.md`.

## Entscheidung

Für v0.2 behandeln wir Task-Delegation als kleinen **Runner-Stack** mit zwei expliziten Wegen:

1. **Claude Code headless** für fokussierte externe Coding-Tasks mit höherem Ausführungsdruck
2. **Pi headless** für kleinere, lokale oder bewusst Pi-nahe Coding-Tasks

Praktische Default-Regel:
- **größeres Coding-Projekt:** meist **AG -> Task**, operativ oft mit Claude Code headless
- **kleineres Projekt oder kleiner direkter Lauf:** **Projektleiterin -> Task** ist erlaubt; Claude oder Pi werden passend zum Scope gewählt
- in jedem Fall: **klarer Handoff, minimaler Tool-Scope, bewusste Modellwahl, bewusste Effort-/Thinking-Wahl**

## Aktueller lokaler Stand

### Claude Code

Lokal verifiziert:
- `claude1` und `claude2` sind vorhanden
- beide laufen aktuell auf **Claude Code 2.1.116**
- beide Wrapper nutzen Token-Auth-Profile
- beide Wrapper exportieren aktuell **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`**
- die aktuellen lokalen Wrapper exportieren **nicht automatisch** `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`

Methodische Folge:
- für dokumentierte, reproduzierbare Task-Calls in diesem Setup setzen wir **beide Envs explizit im Call**:
  - `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- zusätzlich lokal getestet: normaler headless Claude-Call über `claude1` funktioniert wieder
- zusätzlich lokal getestet: `claude --bare` ignoriert den Subscription-OAuth-Token auch dann, wenn `CLAUDE_CODE_OAUTH_TOKEN` explizit inline gesetzt wird; `--bare` ist damit hier aktuell **kein** normaler Subscription-Task-Pfad

Offiziell dokumentiert und für Task-Läufe wichtig:
- `--tools` beschränkt die **verfügbaren built-in tools**
- `--allowedTools` steuert **Permission-Allow-Regeln**, ist aber kein Ersatz für `--tools`
- relevante Headless-Flags sind u. a.:
  - `--append-system-prompt`
  - `--append-system-prompt-file`
  - `--system-prompt`
  - `--system-prompt-file`
  - `--output-format`
  - `--json-schema`
  - `--max-turns`
  - `--no-session-persistence`
  - `--bare`
  - `--exclude-dynamic-system-prompt-sections`
  - `--permission-mode`
  - `--dangerously-skip-permissions`

### Pi

Lokal verifiziert:
- `pi` läuft aktuell auf **0.70.6**
- `~/.pi/agent/settings.json` setzt aktuell:
  - `defaultProvider = openai-codex`
  - `defaultModel = gpt-5.5`
  - `defaultThinkingLevel = high`
- Pi unterstützt für externe/headless Läufe u. a.:
  - `-p`, `--print`
  - `--no-session`
  - `--model <provider/id>` und `:<thinking>`-Shorthand
  - `--thinking`
  - `--tools`
  - `--no-context-files`
  - `@files...`
  - `--mode json`
  - `--mode rpc`

Aktueller bevorzugter Pi-Model-Scope dieses Setups in `enabledModels`:
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.4-mini`
- `openai-codex/gpt-5.3-codex`

Wichtig: Für den Scope provider-qualifizierte IDs verwenden. Bare IDs wie `gpt-5.3-codex` können bei mehreren `openai-codex-*`-Providern über fuzzy matching falsch auf `gpt-5.3-codex-spark` aufgelöst werden.

Bewusst nicht im aktiven Default:
- `gpt-5.2` und ältere Varianten, solange keine Kompatibilitäts- oder Kostengründe dafür sprechen
- `gpt-5.5-pro`, solange es lokal nicht verfügbar bzw. nicht abonniert ist; später höchstens als Prüfinstanz für hohe Fehlerkosten
- `gpt-5.3-codex-spark` bleibt schneller Spezial-/Erstpass, nicht Hauptdefault

## Shared Prinzipien für beide Runner

### 1. Handoff zuerst, Runner danach
Nicht umgekehrt.

Die höhere Ebene entscheidet zuerst:
- Ziel
- Scope
- Nicht-Scope
- relevante Dateien
- Checks
- Rückgabeformat

Erst dann kommt die Runner-Wahl.

### 2. Tools klein halten
Nicht die größte Tool-Liste geben, sondern die **kleinste passende**.

### 3. Modell und Denktiefe pro Task wählen
Keine stillen Einheitsdefaults für alles.

### 4. Reproduzierbare Calls schlagen versteckte Launcher-Magie
Wenn ein Env oder Flag für das Verhalten wichtig ist, lieber **explizit im Call** setzen.

## Tool-Scope-Heuristik

### Read-only Analyse
Zweck:
- Code lesen
- Struktur verstehen
- Checks laufen lassen
- Review ohne Schreibrechte

Empfehlung:
- **Claude:** `Read,Bash`
- **Pi:** `read,bash,grep,find,ls`

### Gezielte Änderungen an bestehenden Dateien
Zweck:
- kleine bis mittlere präzise Änderungen
- Refactor
- Test-Fix
- Bugfix

Empfehlung:
- **Claude:** `Read,Edit,Bash`
- **Pi:** `read,bash,edit`

### Neue Dateien oder komplette Überschreibungen
Zweck:
- neue Handoff-Datei
- neue Tests
- neue kleine Doku-Datei
- vollständige Neufassung einzelner Dateien

Empfehlung:
- **Claude:** `Read,Edit,Write,Bash`
- **Pi:** `read,bash,edit,write`

### Web-gestützte Coding-Recherche nur bei Bedarf
Nicht Standard für normale Coding-Tasks.

Wenn nötig:
- **Claude:** `WebFetch,WebSearch` bewusst zusätzlich freigeben
- **Pi:** nur die wirklich benötigten Extension-Tools explizit whitelisten, z. B. `web_search,web_fetch,fetch_content`; `code_search` aktuell nicht whitelisten, weil der lokale Pfad deaktiviert ist

## Claude-Code-Call-Muster

### Bevorzugtes Basismuster

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --append-system-prompt "<kleines Addendum>" \
  --tools "Read,Edit,Bash" \
  --model sonnet \
  --effort high \
  -p < handoff.md
```

Nutzen:
- Handoff bleibt als eigene Datei sichtbar
- Tool-Scope ist knapp
- Modell und Effort sind sichtbar
- wichtige Envs sind nicht nur still im Wrapper versteckt

### Wann `--append-system-prompt`?

**Default für dieses Setup.**

Nutzen:
- kleine Stil- oder Scope-Regeln ergänzen
- Default-Prompt von Claude Code bleibt erhalten
- weniger Risiko als kompletter Prompt-Ersatz

### Wann `--system-prompt` oder `--system-prompt-file`?

Nur wenn du **bewusst den kompletten Default ersetzen** willst.

Nicht Standard für normale Task-Delegation.

### Wann `--bare`?

Für bewusst **sterile, explizite Script-Läufe**, wenn du gerade **keine** automatische CLAUDE.md-, Hook-, Skill-, Plugin-, MCP- oder Auto-Memory-Ladung willst.

Wichtige lokale Zusatzregel:
- `--bare` ist hier aktuell **nicht** der normale Subscription-Pfad
- lokaler Test mit explizit gesetztem `CLAUDE_CODE_OAUTH_TOKEN` endete trotzdem mit `Not logged in`
- praktisch heißt das: `--bare` nur nutzen, wenn du bewusst den **API-/extra-usage-Pfad** willst und die passende API-Auth dafür hast

Nicht der normale Default für Projekt-Tasks.

### Wann `--output-format`, `--json-schema`, `--max-turns`?

Sobald Task-Läufe stärker automatisiert oder maschinenlesbar werden sollen.

Das ist ein sinnvoller späterer Pfad für:
- strukturierte Task-Rückmeldungen
- Wrapper-Skripte
- automatische Auswertung

Aber noch **nicht** der normale manuelle v0.2-Default.

## Claude-Modell- und Effort-Heuristik

### `opus`
Nutzen:
- riskante Änderungen
- mehrdeutige Architekturfragen
- Migrationspfade
- besonders anspruchsvolle Debugging- oder Refactor-Läufe

Empfehlung:
- `high` oder `xhigh`
- `max` nur bewusst für sehr harte Fälle testen, nicht breit als Default übernehmen

Offizielle Claude-Doku:
- Opus 4.7 ist das stärkste Modell für komplexe Aufgaben
- `xhigh` ist dort der empfohlene Standard für viele Coding- und agentische Aufgaben

### `sonnet`
Nutzen:
- normale fokussierte Coding-, Refactor- und Test-Läufe
- gutes Preis-/Geschwindigkeits-/Qualitäts-Verhältnis

Empfehlung:
- `medium` oder `high`
- auf Sonnet 4.6 ist `xhigh` **kein eigener supported level**; Claude fällt dann auf die höchste unterstützte niedrigere Stufe zurück

### `haiku`
Nutzen:
- Quick Checks
- kleine billige Erstpässe
- sehr kleine Umformungen

Empfehlung:
- nur für bewusst leichte Tasks
- nicht als Default für riskante oder mehrdeutige Änderungen

## Permission-Heuristik für Claude

### Aktueller lokaler manueller Default
Für Richards lokale headless Task-Läufe in **bewusst vertrauten Repos**:
- `--dangerously-skip-permissions`

Warum trotzdem okay:
- Task ist bewusst scoped
- Handoff ist explizit
- Tool-Liste ist klein
- Repo ist bekannt

Aber:
- das ist **kein allgemeiner Sicherheitsrat** für fremde oder unsaubere Umgebungen
- für isolierte Sandboxes/Container/VMs ist das deutlich unkritischer als für beliebige Hosts

### Spätere oder vorsichtigere Pfade
- interaktiv: `--permission-mode plan` oder `acceptEdits`
- strikt scripted: `--permission-mode dontAsk` + explizite Permission-Regeln

Diese Wege sind sinnvoll, aber aktuell **nicht** der einfachste manuelle Default in diesem Setup.

## Pi-Call-Muster

### Bevorzugtes Basismuster für einen externen Einmal-Task

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.3-codex \
  --thinking high \
  --tools read,bash,edit,write \
  @handoff.md
```

Nutzen:
- kein zusätzlicher Session-Müll für disposable Tasks
- Modell und Thinking sind explizit
- Handoff bleibt als Datei sichtbar

### Read-only Review-Lauf

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --tools read,bash,grep,find,ls \
  @handoff.md
```

### Steriler Pi-Mikrolauf

Wenn du ganz bewusst **nur expliziten Kontext** willst:

```bash
pi --no-session -p \
  --no-context-files \
  --no-skills \
  --no-prompt-templates \
  --no-extensions \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --tools read,bash,edit \
  @handoff.md
```

### Pi mit Web-Tools nur bei Bedarf

Nur wenn der Task wirklich Web- oder Doku-Recherche braucht und die lokalen Pi-Pakete geladen sein sollen:

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.5 \
  --thinking high \
  --tools read,bash,web_search,web_fetch,fetch_content \
  @handoff.md
```

## Pi-Modell- und Thinking-Heuristik

Grundregel für v0.3:

```text
Steuerung: gpt-5.5, wenn Qualität zählt; sonst gpt-5.4.
Repo-Agentenarbeit in Pi: gpt-5.3-codex.
Routine/Masse: gpt-5.4-mini.
Finale Prüfinstanz: gpt-5.5-pro nur optional, wenn verfügbar.
gpt-5.2 nicht aktiv empfehlen.
```

### `gpt-5.5`
Nutzen:
- wichtigste Qualitätswahl für Projektleiterin-/AG-Steuerung, Architektur und Grundsatzfragen
- schwierige oder mehrdeutige Coding-Aufgaben
- größere Refactors, Reviews, Debugging über mehrere Dateien
- heikle Entscheidungen, bei denen Nacharbeit teuer wäre

Empfehlung:
- **`high` als Default** für langlebige Steuerung und wichtige Einordnungen
- `xhigh` nur bewusst für sehr mehrdeutige, riskante oder finale Architektur-/Security-/Migrationsfragen
- nicht für billige Massenarbeit erzwingen

### `gpt-5.3-codex`
Nutzen:
- Default für echte Pi-Repo-Agentenarbeit
- Dateien lesen und ändern, Tests ausführen, Terminal-Output interpretieren
- Bugfixes, Features, PR-artige Änderungen und Test-Fixes über mehrere Dateien

Empfehlung:
- **`high` als normaler Coding-Startpunkt**
- `medium` für klar begrenzte, risikoarme Patches
- `low` für sehr kleine grüne Smoke-/E2E-Pfade, wenn der Ablauf bereits validiert ist
- bei unklarem oder riskantem Scope eher auf `gpt-5.5 high` wechseln als nur Codex hochzudrehen

### `gpt-5.4`
Nutzen:
- guter Generalist für gemischte Code-/Text-Aufgaben
- moderate Architekturüberlegungen, Code-Erklärungen, kleinere Reviews
- normaler General-Use mit Codebezug, wenn `gpt-5.5` nicht nötig ist

Empfehlung:
- `high` für Review/Planung, `medium` für normale Mischaufgaben
- nicht mehr als stärkster stiller Default für wichtige Steuerung behandeln

### `gpt-5.4-mini`
Nutzen:
- schneller, günstiger, kleinerer Worker
- Markdown/Docs, Boilerplate, mechanische Änderungen, kleine Refactors
- Varianten erzeugen, einfache Tests, grobe Vorsortierung von Notizen oder Transkripten

Empfehlung:
- `medium` als Routine-Default
- `high` nur, wenn der kleine Worker etwas sorgfältiger prüfen soll
- nicht für Architektur, Security, Migrationen oder finale Reviews

### `gpt-5.5-pro`
Einordnung:
- aktuell **nicht** Teil des Defaults, solange Richard kein Pro-Abo nutzt
- später mögliche Prüfinstanz für finale Architekturentscheidungen, Security-Reviews, Migrationen, Datenverlust-/Finanzrisiko oder „finde Fehler, die andere Modelle übersehen“
- nicht als Alltagsmodell und nicht als Voraussetzung für v0.3 dokumentieren

### `gpt-5.2`
Einordnung:
- nicht aktiv empfehlen
- nur nutzen, wenn Kompatibilität, Verfügbarkeit oder Kosten in einem konkreten Setup dafür sprechen

### Thinking-Level

Pi kennt laut Settings-Doku:

```text
off, minimal, low, medium, high, xhigh
```

v0.3-Standard:
- **globaler Default: `high`**, nicht `xhigh`
- `xhigh` ist ein bewusster Upgrade-Schalter, kein stiller Standard
- `medium` für normale Routine und preisbewusste Mischaufgaben
- `low` für validierte kleine Smoke-/E2E-Läufe oder sehr enge Erstpässe
- `off`/`minimal` nur für triviale Formatierung oder bewusst billige Kleinstläufe

Merksatz:

```text
Modell nach Rolle wählen, Thinking nach Risiko und Ambiguität erhöhen.
```

## Kontext-Regel bei Pi

### Repo-Regeln mitnehmen
Wenn du bewusst im Zielrepo stehst und dessen `AGENTS.md` / `CLAUDE.md` relevant sind:
- **kein** `--no-context-files`

### Sterile Mikroläufe
Wenn du ganz exakt nur mit Handoff und expliziten Dateireferenzen arbeiten willst:
- `--no-context-files`
- ggf. auch `--no-skills`, `--no-prompt-templates`, `--no-extensions`

## Was wir bewusst nicht tun

Nicht v0.2-Default:
- ein großer automatischer Broker vor echter Praxis
- riesige All-Tools-Defaults
- blinde Gleichsetzung von Claude-`--effort` und Pi-`--thinking`
- versteckte Wrapper-Magie als Source of Truth
- Vollersatz von `handoff.md` durch Runner-Details

## Noch offene Fragen

1. Wie oft ist in echter Praxis **Claude headless** klar besser als **Pi headless**?
2. Wie genau sollten wir echte Use-Cases zwischen `gpt-5.4-mini` und `gpt-5.3-codex` aufteilen?
3. Sollen wir kleine Shell-Wrapper für Standardfälle bauen oder vorerst bewusst explizit bleiben?
4. Soll `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` später in die lokalen `claude1` / `claude2` Wrapper wandern oder als sichtbare Call-Konvention bleiben?
5. Wann lohnt sich maschinenlesbare Task-Rückgabe (`json`, `json-schema`, RPC`) wirklich?

## Nächste Validierungsschritte

1. Einen echten Claude-headless-Task aus einer AG heraus fahren
2. Einen echten Pi-headless-Coding-Task fahren
3. Qualität, Kosten, Geschwindigkeit und Nacharbeit vergleichen
4. Danach erst Defaults oder Wrapper nachschärfen

## Schnittstelle zum Arbeitsmodell

Die methodische Schleife bleibt in `stacks/handoff.md`:

**Auftrag -> Arbeit -> Verdichtung -> Rückkehr**

Dieses Dokument ergänzt nur die praktische Frage:
- welcher Runner?
- welches Modell?
- welche Denktiefe?
- welcher Tool-Scope?
