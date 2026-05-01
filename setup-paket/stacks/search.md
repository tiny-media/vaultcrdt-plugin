# Stack | Search

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## Entscheidung

Für v0.3 wird die Alltagsoberfläche bewusst verschlankt.

**Alltagsdefault:**

1. **Search:** `pi-web-access` / `web_search`
2. **Fetch:** `pi-smart-fetch` / `web_fetch`

**Eskalations- und Spezialwege bei Bedarf:**

3. **URL-Backup:** `fetch_content`
4. **Zusatz-Search / zweite Trefferliste:** `scripts/brave-search`
5. **Zusatz-Answer / kompakte web-grounded Antwort:** `scripts/brave-answers`
6. **Expliziter lokaler Search-Wrapper:** `scripts/search-chain` mit der Kette **Exa API -> Exa MCP -> Brave Search**
7. **GitHub-Code-Kandidatenfinder:** `scripts/github-code-search`

Das trennt bewusst:
- die kleine Oberfläche für normale Recherche
- echte Suche
- robustes URL-Fetching
- Backup-Fetching
- kompakten Antwortweg
- zusätzliche Quellenfindung über einen zweiten Provider
- eine explizite lokale Such-Kette außerhalb der Pi-Provider-Logik

Merksatz:

```text
Alltag: web_search -> web_fetch.
Extras nur, wenn der Default nicht reicht oder eine zweite Perspektive nötig ist.
```

## Rollen der Schichten

### 1. Search default
`pi-web-access`

Zweck:
- echte Websuche
- aktuelle Quellen finden
- erste Trefferlage für Recherche aufbauen

Aktueller technischer Stand:
- `pi-web-access@0.10.6` ist global installiert (`pi list`)
- das Paket registriert lokal die Tools `web_search`, `fetch_content`, `get_search_content`; `code_search` wurde lokal vorerst **deaktiviert**, weil seine Exa-MCP-Implementierung auf einen nicht mehr vorhandenen Toolnamen (`get_code_context_exa`) läuft
- ein Smoke-Test mit `web_search` liefert lokal erfolgreich Treffer (`5 sources`)
- Exa API und Exa MCP funktionieren beide gut und sind die aktive Provider-Grundlage
- der lokale `auto`-Pfad läuft bewusst mit Exa API
- `code_search` ist aktuell **kein** nutzbarer Toolpfad und soll nicht in Pi-Tool-Whitelists auftauchen, bis eine belastbare Alternative entschieden ist

Wichtige Einordnung:
- `pi-web-access` fällt intern **nicht** automatisch auf Brave durch; die explizite Fallback-Kette Exa API -> Exa MCP -> Brave ist Aufgabe von `scripts/search-chain`, nicht des Pi-Defaults
- `fetch_content` gehört zwar zu `pi-web-access`, ist aber **nicht** der Standard-Fetcher für bekannte URLs
- `fetch_content` bleibt ein pragmatischer Zusatzweg für Spezialfälle oder als Backup, wenn `web_fetch` nicht der beste Pfad ist

### 2. Fetch default
`pi-smart-fetch`

Zweck:
- bekannte URLs robust abrufen
- mit Bot-Walls, TLS-Fingerprint und Fetch-Problemen besser umgehen als einfache Reader-Wege

Aktueller technischer Stand:
- `pi-smart-fetch@0.2.32` ist global installiert (`pi list`)
- das Paket registriert `web_fetch` und `batch_web_fetch`
- ein Smoke-Test mit `web_fetch` gegen `https://bun.com/blog/bun-v1.3` liefert lokal brauchbaren Inhalt
- auf derselben Testseite erscheint lokal zusätzlich ein noisiger `Invalid URL`-Stacktrace aus `defuddle`/Metadata-Extraktion, **obwohl der Fetch am Ende erfolgreich ist**

Folge:
- `pi-smart-fetch` bleibt der Default für URL-Fetching
- stderr-Rauschen darf hier nicht automatisch als Totalausfall interpretiert werden
- der Fehlerpfad sollte später separat dokumentiert oder isoliert geprüft werden

### 3. Zusatz-Search
`scripts/brave-search`

Zweck:
- zweite Trefferliste über einen getrennten Provider
- schneller Zusatzweg für Quellenfindung
- Vergleichslauf, wenn neben `web_search` noch ein weiterer Suchblick nützlich ist

Aktueller technischer Stand:
- kanonische Quelle liegt im Setup-Paket unter `setup-paket/assets/scripts/brave-search`
- operative Zielposition im Projekt bleibt `scripts/brave-search`
- Optionen: Query, `--raw`, `--count`, `--help`
- Credential-Reihenfolge:
  1. `BRAVE_SEARCH_API_KEY`
  2. `BRAVE_SEARCH_API_KEY_FILE`
  3. `.brave-search-api-key` im aktuellen Arbeitsverzeichnis
- Default-Output: kompakte Markdown-Trefferliste
- der Wrapper wurde lokal gebaut, getestet und für Secret-Hygiene gehärtet
- ein kleiner Benchmark zeigte: `brave-search` ist brauchbar, aber `pi-web-access` bleibt der stärkere Standardweg für die Default-Suche

Wichtige Einordnung:
- `brave-search` ist **Zusatzweg**, nicht neuer Gesamt-Default
- der Wrapper ist für echte Trefferlisten gedacht, nicht für URL-Fetching

### 4. Zusatz-Answer
`scripts/brave-answers`

Zweck:
- kompakte web-grounded Antwort auf eine direkte Frage
- schneller Zusatzweg, wenn eine kurze Synthese hilfreich ist

Aktueller technischer Stand:
- kanonische Quelle liegt im Setup-Paket unter `setup-paket/assets/scripts/brave-answers`
- operative Zielposition im Projekt bleibt `scripts/brave-answers`
- Optionen: Frage, `--raw`, `--help`
- Credential-Reihenfolge:
  1. `BRAVE_ANSWERS_API_KEY`
  2. `BRAVE_ANSWERS_API_KEY_FILE`
  3. `.brave-answers-api-key` im aktuellen Arbeitsverzeichnis
- Default-Output: reine Antwort als Text
- der Wrapper wurde lokal gebaut, getestet und für Secret-Hygiene gehärtet
- Brave Answers funktioniert lokal, sollte aber bei offiziellen URLs oder wichtigen Referenzen **nicht blind** als alleinige Wahrheitsquelle behandelt werden

Wichtige Einordnung:
- Answer ist **nicht** Fetch
- `brave-answers` ersetzt keinen sauberen URL-Leser
- wenn offizielle Links oder präzise Quellen wichtig sind, sollten Treffer und Inhalte über Suche + Fetch gegengeprüft werden

### 5. Expliziter lokaler Search-Wrapper
`scripts/search-chain`

Zweck:
- eine explizite, nachvollziehbare Such-Kette außerhalb der Pi-Provider-Logik
- deterministische Reihenfolge über mehrere Provider hinweg, wenn der Default-Weg nicht ausreicht oder wenn man den Fallback-Pfad bewusst selbst steuern will

Stage-Ordnung (`--provider auto`, Default):
1. **Exa API** (nutzt lokalen Exa-Key)
2. **Exa MCP** zero-config (ohne Exa-Key im Subprocess)
3. **Brave Search** via `scripts/brave-search`

Aktueller technischer Stand:
- kanonische Quelle liegt im Projekt unter `scripts/search-chain`
- Optionen: Query, `--count`, `--raw`, `--provider auto|exa-api|exa-mcp|brave`, `--help`
- Credential-Reihenfolge für Exa:
  1. `EXA_API_KEY`
  2. `EXA_API_KEY_FILE`
  3. `.exa-api-key` im aktuellen Arbeitsverzeichnis
- Exa-MCP-Stage wird zuverlässig zero-config gefahren, indem `EXA_API_KEY` / `EXA_API_KEY_FILE` per `env -u` aus dem Subprocess gestrichen werden
- Brave-Stage delegiert an `scripts/brave-search`, wird nicht reimplementiert
- Default-Output: vertraute Markdown-Trefferliste; `--raw` gibt je Stage die jeweilige Rohstruktur aus
- kein Fetch- und kein Answer-Pfad; der Wrapper bleibt strikt Search

Wichtige Einordnung:
- `scripts/search-chain` ist **nicht** `pi-web-access` und beansprucht dessen Rolle als Pi-Default nicht
- der Wrapper bildet eine explizite lokale Kette ab, er beschreibt **nicht**, dass `pi-web-access` intern dieselbe Kette fährt
- für das Monats-Usage-Counting aus `~/.pi/exa-usage.json` ist weiter der `pi-web-access`-Weg zuständig, nicht dieser Wrapper

### 6. Vorläufiger Zusatzweg für Code-Lookups
`scripts/github-code-search`

Zweck:
- schneller GitHub-first Lookup für Code, Typen, Config-Keys und Implementierungsstellen in externen OSS-Repos
- Kandidaten-Dateien finden, bevor man tiefer per Clone, `rg`, `read` oder Permalink-Inspektion einsteigt

Aktueller technischer Stand:
- kanonische Quelle liegt im Projekt unter `scripts/github-code-search`
- Backend: `gh search code --json path,repository,url,textMatches`
- Optionen: Query, `--repo`, `--owner`, `--language`, `--filename`, `--limit`, `--raw`, `--help`
- Preflight: `gh`, `jq` und erfolgreiche `gh`-Auth müssen vorhanden sein
- Default-Output: kompakte Markdown-Trefferliste mit Repo, Pfad, URL und optionalem Snippet
- `--raw` gibt das rohe JSON von `gh search code` zurück
- lokal verifiziert mit echten Runs u. a. gegen `facebook/react` (`function useState`) und `altcha-org/altcha` (`hideFooter`, `AltchaWidgetElement`)
- dieser Wrapper ist der aktuell geprüfte kleine Ersatz für den momentan unzuverlässigen `pi-web-access`-`code_search`-Pfad

Wichtige Einordnung:
- `scripts/github-code-search` ist ein **vorläufig validierter Zusatzweg**, kein final entschiedener moderner Code-Search-Standard
- `gh search code` nutzt laut GitHub CLI weiterhin die **Legacy-Code-Search-API**; Treffer können daher von GitHubs neuer Web-Code-Suche abweichen, und moderne Features wie Regex-Suche stehen dort nicht vollständig zur Verfügung
- methodisch ist der Wrapper daher eher Kandidatenfinder als Wahrheitsquelle: nach dem Finden relevanter Dateien sollte die eigentliche Prüfung über Repo-Clone + `rg`/`read`/Permalinks oder einen vergleichbar belastbaren Lesepfad laufen

## Globaler Rollout: Launcher + Pi-Skill

Der oben beschriebene Stack ist auf dieser Maschine **systemweit** nutzbar. Er bleibt aber kanonisch im Repo verankert.

### Globale Launcher in `~/.local/bin/`
- `~/.local/bin/search-chain`
- `~/.local/bin/brave-search`
- `~/.local/bin/brave-answers`

Eigenschaften:
- jeder Launcher ist ein kleiner Wrapper, der an das gleichnamige Repo-Skript unter `scripts/` delegiert
- Repo-Basis: `REPO="${CODING_AGENT_SETUP_REPO:-$HOME/projects/coding-agent-setup}"`
- Default-Setzung der Key-File-Envs nur, wenn nicht bereits gesetzt:
  - `EXA_API_KEY_FILE` -> `$REPO/.exa-api-key` (für `search-chain`)
  - `BRAVE_SEARCH_API_KEY_FILE` -> `$REPO/.brave-search-api-key` (für `search-chain` und `brave-search`)
  - `BRAVE_ANSWERS_API_KEY_FILE` -> `$REPO/.brave-answers-api-key` (für `brave-answers`)
- die Launcher lesen oder exportieren keine Secret-**Werte**, nur Pfade
- die Repo-Skripte selbst handhaben das eigentliche Token mit kurzlebiger Header-Datei und Cleanup

### Globale Pi-Skill
- `~/.pi/agent/skills/web-search-stack/SKILL.md`
- liegt direkt unter Pi's Default-Skills-Pfad und beschreibt die Routine: Pi-Default für Search/Fetch, explizite Kette über `search-chain`, Brave-only via `brave-search`, kompaktes Answer-Addon via `brave-answers`
- die Skill bündelt die Routine, sie reimplementiert sie nicht

### Wichtige Einordnung
- die globalen Launcher und die Repo-Skripte sind nicht dasselbe; die Launcher delegieren, sie reimplementieren nichts
- die Launcher beanspruchen die Rolle des Pi-Defaults `pi-web-access` nicht; sie sind genau das, was die Repo-Skripte sind, nur aus jedem Verzeichnis erreichbar
- GLM ist aus der aktiven globalen Pi-Suche entfernt (`glm-search`, `glm-web`, `glm-docs` und die zugehörigen globalen Skills sind weg) und sollte nicht in den aktiven Default zurückgezogen werden
- wandert das Repo, hilft `CODING_AGENT_SETUP_REPO=/anderer/pfad`, sonst brechen die Launcher mit Fehler ab

## Secret-Strategie

Für den aktiven Web-Stack gilt:
- keine Web-Search-Secrets in 1Password als vorausgesetzter Betriebsweg
- stattdessen: **lokale Datei + Env**
- die Brave-Wrapper können Tokens direkt aus Env oder aus lokalen Key-Dateien lesen
- die Wrapper hängen Tokens nicht direkt in `curl`-Argumente, sondern nutzen eine temporäre Header-Datei mit Cleanup

## V0.3-Default-Oberfläche

Der praktische Standardweg ist aktuell:

1. mit `web_search` aus `pi-web-access` suchen
2. die wichtigsten Treffer mit `web_fetch` aus `pi-smart-fetch` nachlesen

Nur bei Bedarf:

3. `fetch_content` als alternativen URL-Leser nutzen
4. wenn eine zweite Trefferliste nützlich ist: `scripts/brave-search`
5. wenn eine kompakte web-grounded Antwort nützlich ist: `scripts/brave-answers`
6. wenn eine explizite lokale Such-Kette Exa API -> Exa MCP -> Brave gewünscht ist: `scripts/search-chain`
7. wenn externer OSS-Code schnell eingegrenzt werden muss: `scripts/github-code-search` als Kandidatenfinder verwenden
8. bei offiziellen URLs oder kritischen Aussagen aus dem Answer-Pfad die echte Treffer-/Fetch-Schiene prüfen

Grundregeln:
- **Suche ist nicht Fetch**
- **Answer ist nicht Fetch**
- **Raw/API/OpenAPI ist nicht readable-page Fetch**: `.json`, `.yaml`, `/openapi`, `/swagger`, `/api-docs` zuerst per `curl -L` + Content-Type/`jq` prüfen, nicht mit `web_fetch` beginnen
- **JS-only Docs sind kein normaler Fetch-Fall**: bei `<app-root>` oder „enable JavaScript“ nicht blind `web_fetch` wiederholen, sondern Suche, Asset/API-Inspektion oder bewusst Browser-Automation wählen
- **`code_search` nicht verwenden**: der lokale Toolpfad ist wegen `get_code_context_exa` deaktiviert; `scripts/github-code-search` bleibt nur Stopgap/Kandidatenfinder
- `brave-search`, `brave-answers`, `scripts/search-chain` und `scripts/github-code-search` sind Zusatz-/Wrapper-Wege, nicht der Basis-Default
- `scripts/search-chain` ersetzt `pi-web-access` nicht und impliziert keine automatische Provider-Kette innerhalb von `pi-web-access`
- `scripts/github-code-search` ist aktuell bewusst nur ein vorläufig validierter GitHub-first-Kandidatenfinder, nicht der endgültige Code-Search-Standard
- `Bun.WebView` ist vorerst kein erster Standard-Fetch-Pfad

## Lokale Ausgangslage

Aktuell lokal verifiziert:
- Pi: `0.70.0`
- Bun global: `1.3.13`
- `pi list` enthält:
  - `npm:pi-web-access`
  - `npm:pi-smart-fetch`
  - `git:github.com/hjanuschka/pi-multi-pass`
- `~/.pi/agent/settings.json` nutzt als Default `openai-codex` / `gpt-5.5` mit `defaultThinkingLevel = high`
- `~/.pi/web-search.json` ist lokal vorhanden
- `scripts/brave-search` ist vorhanden
- `scripts/brave-answers` ist vorhanden
- `scripts/search-chain` ist vorhanden und fährt die Kette Exa API -> Exa MCP -> Brave Search
- globale Launcher `~/.local/bin/search-chain`, `~/.local/bin/brave-search`, `~/.local/bin/brave-answers` sind vorhanden, ausführbar und delegieren an die Repo-Skripte
- `scripts/github-code-search` ist im Repo vorhanden und lokal geprüft, aber **noch nicht** global ausgerollt
- globale Pi-Skill `~/.pi/agent/skills/web-search-stack/SKILL.md` ist vorhanden

## Was nicht Teil des v0.3-Defaults ist

Vorerst nicht Teil des belastbaren Defaults:
- ein Wechsel weg von `pi-web-access` als Standard-Suche
- ein Wechsel weg von `pi-smart-fetch` als Standard-Fetch allein wegen stderr-Rauschen
- Vermischung von Answer und Fetch
- alternative Provider-Stacks im aktiven globalen Pi-Such-Default
- eine vorschnelle Kanonisierung von `scripts/github-code-search` als finalem Code-Search-Standard, obwohl der Backend-Pfad auf GitHub-CLI-Seite noch Legacy-Charakter hat
- externe Claude-Research-Läufe als Pi-Basisdefault
- Browser-Automation als Standard-Rechercheweg
- Web-Search-Secrets in 1Password als vorausgesetzter Pfad

## Nächste Schritte

1. aktive Doku, Assets und Prompts auf dem laufenden Stand halten
2. im Alltag weiter die kleine Oberfläche `web_search -> web_fetch` bevorzugen
3. den noisigen `pi-smart-fetch`-Fehlerpfad separat dokumentieren oder reproduzierbar isolieren
4. für Code-Lookups modernere Best Practices und belastbarere Alternativen zu `gh search code` prüfen, bevor `scripts/github-code-search` globalisiert oder kanonisiert wird
5. `brave-answers` vs externe Claude-Research-Läufe später gezielt vergleichen
6. erst danach entscheiden, ob der Brave-Weg nur Wrapper bleibt oder später verpackt werden soll

## Schnittstelle zum Arbeitsmodell

Search gehört zur **Implementierungs-Schicht**, nicht zur Grundmethodik.

Die methodische Einordnung steht in `../arbeitsmodell.md`.
