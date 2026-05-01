# Guide | Externe Task-Runs über Claude Code und Pi

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## Zweck

Dieses Dokument ist der **kleine verlinkbare Standard** für andere Projekte, die aus **Projektleiterin** oder **AG** heraus fokussierte externe Tasks losschicken wollen.

Es beschreibt:
- die aktuell verifizierten lokalen Runner-Fakten
- die praktischen Default-Call-Muster für `claude1` / `claude2` und `pi -p`
- die aktuelle kleine Modell-Matrix für Richards aktive 6 Modelle
- was aus echten kleinen Läufen schon belastbar wirkt und was noch nur Startheuristik ist

Es ersetzt **nicht** die methodische Schleife aus `../stacks/handoff.md`.

## Was getrennt bleiben soll

Nicht vermischen:
- **Methode:** `Auftrag -> Arbeit -> Verdichtung -> Rückkehr`
- **Runner:** Claude Code headless vs. Pi headless
- **Task-Form:** read-only, targeted edit, new file, research-assisted coding
- **Denktiefe:** Claude `--effort` ist nicht Pi `--thinking`
- **Tool-Scope:** Claude `--tools` ist nicht Claude `--allowedTools`

## Lokal verifiziert auf dieser Maschine

### Claude Code

Verifiziert:
- `claude1` und `claude2` sind vorhanden
- beide Wrapper laufen aktuell auf **Claude Code 2.1.116**
- beide Wrapper nutzen Token-Auth-Profile
- beide Wrapper exportieren aktuell **`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`**
- beide Wrapper exportieren aktuell **nicht automatisch** `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`
- `claude1` ist in diesem Pass wieder erfolgreich headless erreichbar

Wichtige getestete Folge:
- für dokumentierte, reproduzierbare Calls setzen wir weiterhin explizit:
  - `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

Wichtige getestete Sonderregel:
- `--bare` ist **nicht** der Subscription-Defaultpfad
- lokaler Test mit **explizit inline gesetztem `CLAUDE_CODE_OAUTH_TOKEN`** und `claude --bare ...` endete trotzdem mit:
  - `Not logged in · Please run /login`
- praktische Bedeutung:
  - `--bare` ignoriert den Subscription-OAuth-Token auch dann, wenn du ihn direkt im Command setzt
  - `--bare` ist damit auf dieser Maschine aktuell ein **API-/extra-usage-Pfad**, nicht der normale Subscription-Task-Pfad

Praktische Kanalregel auf dieser Maschine:
- `claude1` = primärer Claude-Task-Kanal
- `claude2` = zweiter Kanal / Ausweichkanal bei Bedarf
- gleicher Call-Stil; kein eigener Methodik-Unterschied
- `claude2` ist in diesem Pass nicht noch einmal nach Quota-Reset gesmoke-testet worden, läuft aber auf derselben lokalen Wrapper-/Versionsbasis

### Pi

Verifiziert:
- `pi` läuft aktuell auf **0.70.6**
- `~/.pi/agent/settings.json` setzt aktuell:
  - `defaultProvider = openai-codex`
  - `defaultModel = gpt-5.5`
  - `defaultThinkingLevel = high`
- headless Läufe mit `-p` funktionieren lokal
- lokale Smoke-Runs für `read`, `edit`, `write`, `@file` und `--no-session` funktionieren lokal

Wichtige getestete Sonderregel:
- aktueller bevorzugter Pi-Model-Scope: `openai-codex/gpt-5.5`, `openai-codex/gpt-5.4`, `openai-codex/gpt-5.4-mini`, `openai-codex/gpt-5.3-codex`
- für `enabledModels` provider-qualifizierte IDs nutzen, weil bare IDs bei mehreren `openai-codex-*`-Providern per fuzzy matching falsch aufgelöst werden können, z. B. `gpt-5.3-codex` -> `gpt-5.3-codex-spark`
- für sterile Pi-Mikroläufe also bevorzugt den globalen Provider `openai-codex/...` angeben, nicht blind ältere nummerierte Provider annehmen

### Aktives Modell-Set für jetzt

Claude:
- `haiku` = **Haiku 4.5**
- `sonnet` = **Sonnet 4.6**
- `opus` = **Opus 4.7**

Pi / OpenAI-Codex:
- `gpt-5.5` = Qualitäts-/Steuerungsmodell für Projektleiterin, AG, Architektur, wichtige Reviews
- `gpt-5.4` = Generalist für gemischte Code-/Text-Aufgaben und Fallback
- `gpt-5.4-mini` = Routine, Markdown, Boilerplate, günstige Erstpässe
- `gpt-5.3-codex` = Repo-Agentenarbeit, Edit-/Test-/Terminal-Schleifen

Zusatznotiz:
- `gpt-5.2` wird nicht aktiv empfohlen
- `gpt-5.5-pro` bleibt vorerst optional und nur spätere Prüfinstanz, wenn verfügbar
- `gpt-5.3-codex-spark` ist lokal sichtbar, gehört aber **nicht** zum aktuellen bevorzugten Modell-Set

## Kleine lokal getestete Benchmarks

Wichtig:
- das ist **kein großes Leaderboard**
- das sind kleine Praxischecks für Runner- und Modellwahl
- getestet wurden zwei kleine Task-Formen:
  1. **read-only critique** einer echten Setup-Datei
  2. **targeted edit + test** in einem kleinen lokalen JS-Benchmark

### Ergebnisübersicht

| Modell | Setting | Read-only critique | Targeted edit + test | Kurzer Befund |
| --- | --- | --- | --- | --- |
| Haiku 4.5 | `low` | ok, 20s | pass, 34s | brauchbar für kleine Checks und kleine Fixes, aber dünner |
| Sonnet 4.6 | `medium` | gut, 16s | – | für read-only Second Opinion oft schon genug |
| Sonnet 4.6 | `high` | gut, 17s | pass, 29s | guter Claude-Default für normale Coding-Tasks |
| Opus 4.7 | `xhigh` | sehr gut, 20s | pass, 35s | lohnt für riskante / mehrdeutige / hochwertige Zweitmeinung |
| gpt-5.4-mini | `medium` | gut, 13s | pass, 24s | guter günstiger Pi-Worker für kleine Reviews und Routine-Fixes |
| gpt-5.3-codex | `high` | gut, 21s | pass, 23s | sehr brauchbar für fokussierte Coding-/Edit-/Test-Aufgaben |
| gpt-5.4 | `high` | sehr gut, 33s | – | guter Pi-Default für Planung, Review, Zweitmeinung |
| gpt-5.4 | `xhigh` | sehr gut, 61s | pass, 22s | für kleine read-only Tasks meist nicht den Extraaufwand wert |

Lesart:
- **alle 6 Zielmodelle haben den kleinen Edit+Test-Fall bestanden**, soweit dafür getestet
- **Haiku** kann kleine echte Arbeit tragen, sollte aber nicht der riskante Default sein
- **Sonnet high** ist aktuell der pragmatische Claude-Coding-Default
- **Opus xhigh** ist für schwierige oder teure Fehlentscheidungen sinnvoll, nicht für Kleinkram
- **gpt-5.4-mini** ist ein guter billiger lokaler Worker
- **gpt-5.3-codex** ist aktuell der schärfste Pi-Pfad für fokussierte Coding-Arbeit
- **gpt-5.4 high** ist der starke lokale Plan-/Review-/Second-Opinion-Pfad
- **gpt-5.4 xhigh** nur bewusst ziehen, nicht als stillen Standard

## Runner-Default nach Task-Form

### 1. Read-only Analyse / Quick Check / kleine Zweitmeinung

Praktischer Start:
- **Pi:** `gpt-5.4-mini` + `medium`
- **Claude:** `haiku` + `low` für sehr kleine Checks, `sonnet` + `medium` für bessere Qualität

Warum:
- billig
- schnell
- minimaler Tool-Scope
- geringe Nacharbeit

### 2. Gezielter Edit in bestehenden Dateien

Praktischer Start:
- **Claude:** `sonnet` + `high`
- **Pi:** `gpt-5.3-codex` + `high`

Warum:
- beide Pfade haben den kleinen Edit+Test-Benchmark sauber bestanden
- Sonnet ist der pragmatische externe Claude-Worker
- `gpt-5.3-codex` wirkt aktuell wie der Pi-Coding-Spezialist für fokussierte Implementation

### 3. Neue Datei oder kompletter Rewrite einer kleinen Datei

Praktischer Start:
- **Claude:** `sonnet` + `high`
- **Pi:** `gpt-5.3-codex` + `high` oder `gpt-5.4` + `high`, wenn mehr Strukturdenken nötig ist

### 4. Riskanter Refactor / Migrationsschritt / schwierige Zweitmeinung

Praktischer Start:
- **Claude:** `opus` + `xhigh`
- **Pi:** `gpt-5.5` + `high`, bei sehr hoher Ambiguität bewusst `xhigh`

`xhigh` nur dann, wenn Ambiguität, Risiko oder Tragweite wirklich hoch sind.

### 5. Lokale Planung / AG-Analyse / starke Pi-nahe Zweitmeinung

Praktischer Start:
- **Pi:** `gpt-5.5` + `high`

Warum:
- beste lokale Planungs-/Urteilsqualität im aktuellen Nicht-Pro-Set
- passt gut, wenn Repo-Kontext, lokale Tools oder installierte Pi-Pakete mitspielen sollen

### 6. Research-assisted Coding Task

Praktischer Start:
- **Pi:** `gpt-5.4` + `high` mit explizit freigegebenen Web-Tools
- **Claude:** `sonnet` + `high` nur dann, wenn du bewusst den Claude-Webpfad willst

Wichtig:
- Web-Tools **nicht** still in jeden Coding-Task mischen
- nur explizit freigeben, wenn der Task wirklich offizielle Doku / Web-Recherche braucht

## Tool-Scope-Defaults

### Claude
- read-only: `Read,Bash`
- targeted edit: `Read,Edit,Bash`
- neue Datei / Rewrite: `Read,Edit,Write,Bash`
- research-assisted: benötigte Web-Tools **bewusst zusätzlich** freigeben

### Pi
- read-only: `read,bash,grep,find,ls`
- targeted edit: `read,bash,edit`
- neue Datei / Rewrite: `read,bash,edit,write`
- research-assisted: nur explizit nötige Tools, z. B. `web_search,web_fetch,fetch_content`; `code_search` aktuell nicht whitelisten, weil der lokale Pfad deaktiviert ist

## Call-Muster: Claude

### Claude Quick Check

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --tools "Read,Bash" \
  --model haiku \
  --effort low \
  -p < handoff.md
```

### Claude Default für normale Coding-Tasks

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --tools "Read,Edit,Bash" \
  --model sonnet \
  --effort high \
  -p < handoff.md
```

### Claude Second Opinion / riskanter Planungs- oder Refactor-Pass

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --tools "Read,Bash" \
  --model opus \
  --effort xhigh \
  -p < handoff.md
```

### Claude mit Web-Tools nur bei Bedarf

```bash
CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 \
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude1 \
  --dangerously-skip-permissions \
  --tools "Read,Bash,WebFetch,WebSearch" \
  --model sonnet \
  --effort high \
  -p < handoff.md
```

### Wichtige Claude-Hinweise

- `--tools` begrenzt die **verfügbaren** built-in tools
- `--allowedTools` ist **kein** Ersatz dafür; das ist Permission-Allowlisting
- `--append-system-prompt` ist der normale kleine Addendum-Pfad
- `--system-prompt` nur, wenn du den Default bewusst komplett ersetzen willst
- `--bare` ist aktuell **nicht** der normale Subscription-Task-Pfad
- `claude2` nutzt dieselbe Call-Form wie `claude1`

## Call-Muster: Pi

### Pi Quick Check / read-only Review

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.4-mini \
  --thinking medium \
  --tools read,bash,grep,find,ls \
  @handoff.md
```

### Pi fokussierter Coding-/Edit-/Test-Task

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.3-codex \
  --thinking high \
  --tools read,bash,edit \
  @handoff.md
```

### Pi starke lokale Planung / Zweitmeinung

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.5 \
  --thinking high \
  --tools read,bash,edit,write \
  @handoff.md
```

### Pi steriler Mikrolauf

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

### Pi research-assisted Coding-Task

```bash
pi --no-session -p \
  --model openai-codex/gpt-5.5 \
  --thinking high \
  --tools read,bash,web_search,web_fetch,fetch_content \
  @handoff.md
```

## Kleine Entscheidungsregel für andere Projekte

Wenn du **nicht lange nachdenken willst**, starte so:
- **sehr kleiner Check:** Haiku `low` oder `gpt-5.4-mini` `medium`
- **normaler externer Coding-Task:** Sonnet `high`
- **normaler lokaler Pi-Coding-Task:** `gpt-5.3-codex` `high`
- **Planung / Zweitmeinung / schwieriger Review:** `gpt-5.5` `high`
- **normaler gemischter Code-/Text-Task:** `gpt-5.4` `medium` oder `high`
- **riskante oder mehrdeutige Claude-Zweitmeinung:** Opus `xhigh`

## Was noch nicht überinterpretiert werden sollte

Noch nicht belastbar aus dieser kleinen Serie:
- großer Kostenvergleich über viele echte Tasks
- Research-Qualität zwischen Claude-Webpfad und Pi-Webpfad
- langfristige Aussage, wann `claude1` vs. `claude2` operativ besser ist
- maschinenlesbare Task-Rückgabe als neuer Default

## Für Richard

Der belastbare Kern ist jetzt klein und praktisch:
- `claude1` funktioniert wieder normal headless
- `--bare` plus OAuth-Token ist **kein** Subscription-Trick und hilft dafür nicht
- Sonnet `high` ist ein guter Claude-Default für normale Coding-Tasks
- `gpt-5.3-codex` `high` ist der Pi-Coding-Default
- `gpt-5.5` `high` ist der starke lokale Plan-/Review-/Steuerungspfad
- `gpt-5.4` bleibt ein guter Generalist/Fallback
- `xhigh` sollte man bewusst ziehen statt still überall stehen lassen
