# Stack | Memory

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## v0.3-Einordnung

Die v0.2-Memory-Entscheidung bleibt gültig. Für v0.3 wird Memory nicht verbreitert; wichtiger ist sichtbare, kontrollierte Nutzung nach echten Sitzungen. Eine spätere Automatisierung soll, wenn überhaupt, als expliziter Befehl wie `/memory-sync` entstehen und nicht als stiller Endhook.

## Entscheidung

Für v0.2 ist **`memory-vault`** der bevorzugte Durable-Memory-Stack.

Begründung:
- bereits in echter Arbeit genutzt
- Markdown als Source of Truth
- erzeugt gute abgeleitete Übersichten
- vermeidet unnötige Embedding-/MCP-/UI-Magie
- passt zu einem 1-Person-Setup, das Transparenz und Diffbarkeit braucht

## Gewählte Form

- Tool: `memory-vault`
- Zielrepo des Tools: `~/projects/agent-memory/`
- Per-Projekt-Instanz: `.agent-memory/` im jeweiligen Projekt
- Generated Views bleiben Teil des Workflows (`_generated/INDEX.md`, `_generated/MEMORY.md`, `_generated/RULES.md`)

Aktueller technischer Stand:
- der Move von `memorytool/memory-vault/` nach `~/projects/agent-memory/` ist ausgeführt (Stand 2026-04-17)
- das neue Repo ist als eigenständiges Git-Repo initialisiert, `cargo build` und `cargo test` laufen grün
- `memorytool/` bleibt als Archiv bestehen; Historie wird nicht in den aktiven Repo gespiegelt
- der erste Projekt-Rollout ist in `~/projects/coding-agent-setup/` ausgeführt: lokale `.agent-memory/`, `_generated/*` und die synchronisierten Kontextdateien sind vorhanden
- für die sichtbare Session-End-Routine wurde genau eine kleine Procedure angelegt: `proc-20260417-ba35`

## Move-Regel

Gewählter Move-Pfad:
- **Option A**
- nur `memorytool/memory-vault/` wird nach `~/projects/agent-memory/` überführt
- das alte `memorytool/` soll nicht weiter im aktiven Weg stehen
- ältere Vektor-Iterationen werden nicht in den aktiven v0.2-Pfad übernommen

## Was nicht mitgezogen wird

Nicht Teil des aktiven v0.2-Memory-Stacks:
- alte Vektor-Iterationen
- experimentelle Vorgänger
- unnötige historische Nebenspuren

Historie darf archiviert bleiben, aber soll die aktuelle Arbeit nicht stören.

## Verhältnis zu Claude Code Auto-Memory

Claude Code Auto-Memory gehört **nicht** zum aktiven v0.2-Setup.

Regel:
- Auto-Memory bleibt für dieses Setup deaktiviert (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`)
- projektspezifisches Durable Memory lebt in `.agent-memory/`
- Re-Entry- und Steuerkontext lebt in den kanonischen MD-Artefakten wie `projektkontext.md`, AG-Notizen und Handoff-Dateien
- vorhandene `~/.claude/projects/.../memory/`-Dateien sind keine Projekt-SSOT und sollen nicht parallel gepflegt werden

## Betriebsmodell pro Projekt

Jedes größere Projekt, das dieses Setup nutzt, bekommt eine eigene `.agent-memory/`-Instanz.

Ziel:
- projektspezifisches Durable Memory
- gemeinsame Lesbarkeit für Pi, Claude Code und andere Agenten
- klare Trennung zwischen:
  - kanonischer Doku
  - Durable Memory
  - Todos / offene Schleifen
  - Session-Handoffs

## Routine

Für v0.2 ist die Memory-Routine bewusst **manuell und sichtbar**:

1. Relevante langlebige Erkenntnisse sauber als Memory erfassen
2. Danach `memory-vault reindex`
3. Danach `memory-vault generate --sync-context-files`
4. Die Projektleiterin schließt erst dann eine relevante Sitzung ab

Keine versteckte Automatik in v0.2.

## Was vorerst nicht gebaut wird

Bewusst nicht Teil von v0.2:
- Embeddings / Vektor-Suche
- MCP-Schnittstelle
- UI-Frontend
- zusätzliche semantische Zauberei ohne echte Retrieval-Lücke

## Offene technische Aufgaben

1. den ersten Rollout in `coding-agent-setup` in 1–2 relevanten Sitzungen praktisch nutzen
2. Reibungen der manuellen Session-End-Routine festhalten
3. erst danach entscheiden, ob Default-Rollout oder Tooling an einer kleinen Stelle geschärft werden müssen
4. README und Reifegrad des Tools im neuen Repo bei Bedarf weiter schärfen

Erledigt (Stand 2026-04-17):
- Move von `memory-vault` nach `~/projects/agent-memory/` ausgeführt
- erster Projekt-Rollout in `coding-agent-setup` ausgeführt

## Schnittstelle zum Arbeitsmodell

Memory ist im Modell das Zuhause für **wiederverwendbares Wissen**.

Faustregel:
- **Memory = Wissen**
- **Todo = offene Handlung**

Die methodische Einordnung steht in `../arbeitsmodell.md`.
