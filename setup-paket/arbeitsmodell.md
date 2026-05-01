# Arbeitsmodell

Setup-Version: v0.3-draft in Arbeit
Stand: 2026-04-24

## Zweck

Dieses Arbeitsmodell beschreibt ein agent-first Vorgehen für größere Projekte mit Pi als primärer Instanz und externen Task-Läufen über andere Agenten wie Claude Code.

Es soll:
- langfristig tragfähig sein
- für einen 1-Person-Dev verständlich bleiben
- gute Kontextfenster-Disziplin erzwingen
- Richard bewusst in Entscheidungen einbeziehen
- sich aus echter Praxis weiterentwickeln statt nur aus Theorie

## Grundprinzipien

1. **Kontinuität lebt in Artefakten, nicht im Chat.**
2. **Exploration ist nicht automatisch Wissen.** Erst Verdichtung macht Exploration wiederverwendbar.
3. **Die höchste Ebene steuert, die niedrigste Ebene arbeitet.**
4. **Langlebige Sessions müssen rekonstruierbar sein.**
5. **Richard bleibt in the loop.** Echte Entscheidungen werden nicht stillschweigend versteckt.
6. **Kurzlebige operative Läufe dürfen disposable sein.**
7. **Offene Schleifen dürfen nicht im Bauchgefühl verschwinden.**
8. **Drei Ebenen sind nicht der Default.** Es wird nur so viel Struktur genutzt, wie die Arbeit wirklich braucht.
9. **Struktur muss Kontext sparen oder Entscheidungen verbessern.** Sonst ist sie optional.
10. **Kontextdisziplin braucht Werkzeuge.** Für temporäre Exploration wird v0.3 über Anker/Return praktisch geprüft.

## Schlanke Arbeitsmodi

v0.3 unterscheidet zuerst nach Arbeitsmodus, nicht nach maximaler Struktur:

1. **Einfach Pi** – kleine, klare Arbeit ohne zusätzliche Setup-Routine.
2. **Pi + Anker** – temporäre Exploration mit Rückkehr zu einem schlanken Kontext.
3. **Projektleiterin + AG** – mehrdeutiger oder wiederkehrender Strang mit Nachschärf-Schleife.
4. **AG/Projektleiterin + Task** – klar begrenzter operativer Lauf mit Rückmeldung.

Merksatz:

```text
Normal mit Pi arbeiten; Setup nur zuschalten, wenn es Kontext spart oder Entscheidungen verbessert.
```

## Die drei Ebenen

### 1. Projektleiterin

Die Projektleiterin hält den Überblick über ein Projekt.

Typische Aufgaben:
- Zielbild halten
- aktive AGs steuern
- Prioritäten setzen
- offene Entscheidungen sammeln
- Rückmeldungen integrieren
- in kleineren Projekten oder bei kleineren direkten Läufen auch selbst Task-Aufträge losschicken, Rückmeldungen bewerten und den Stand in Artefakte zurückschreiben
- Richard bei echten Richtungsfragen einbeziehen
- `projektkontext.md` aktuell halten

Die Projektleiterin soll **nicht** dauerhaft tiefe operative Roharbeit mit sich herumschleppen.

### 2. AG

Eine AG bearbeitet einen größeren Strang.

Beispiele:
- AG Pad-Komponente
- AG Audit
- AG TypeScript-Migration
- AG Schrank für Jurek
- AG Memory
- AG Web Search

Typische Aufgaben:
- einen Strang strukturieren
- relevante Quellen sammeln
- Exploration verdichten
- Tasks aufsetzen
- Coding-Tasks in diesem Strang meist selbst losschicken und ihre Rückmeldungen wieder empfangen
- Task-Rückmeldungen einordnen
- eine AG-Notiz aktuell halten
- offene Entscheidungen an die Projektleiterin zurückspielen

### 3. Task

Ein Task ist ein fokussierter Arbeitslauf.

Beispiele:
- Task Pi-Plugin-Research
- Task Protokoll transkribieren
- Task Code-Review
- Task session-restore-fix

Typische Aufgaben:
- einen klaren Auftrag ausführen
- scoped lesen, prüfen, coden, testen oder recherchieren
- eine saubere Task-Rückmeldung liefern

## Praktische Übersetzung für Coding-Projekte

Für größere Coding-Projekte lässt sich das Modell so lesen:

### 1. Projektleiterin = langlebige Projekt-Session
Typisch:
- Überblick über Roadmap, Architektur, Design-Entscheidungen, Risiken
- arbeitet in Pi als primäre Instanz
- Standard in Richards aktuellem Setup: `gpt-5.5` mit `high`, wenn Qualität zählt; `gpt-5.4` bleibt Generalist/Fallback
- pflegt das Kontextfenster über Artefakte, Verdichtung und bewusste Tree-Rücksprünge

### 2. AG = langlebige Strang-/Roadmap-/Plan-Session
Typisch:
- ein größerer Strang wie Auth, Editor, Search, Migration, Performance
- hält relevante Dateien, Checks, Tests und Rückläufe für diesen Strang zusammen
- arbeitet ebenfalls primär in Pi
- Standard in Richards aktuellem Setup: `gpt-5.5` mit `high` für Steuerung/Planung; `gpt-5.3-codex` für echte Repo-Agentenarbeit

### 3. Task = fokussierte Code-/Test-/Analyse-Session
Typisch:
- ein klar begrenzter One-Shot oder ein kleiner externer Lauf
- der wesentliche Kontext steht im Anfangsprompt oder im Task-Auftrag
- bevorzugt externer Coding-Agent wie Claude Code
- Pi bleibt möglich für kleinere oder bewusst lokale Tasks

Faustregel zur Tool-Wahl:
- **Projektleiterin / AG** steuern und verdichten primär in Pi
- **Task** arbeitet bevorzugt extern, wenn Scoped Coding oder Tests wirklich im Vordergrund stehen

## Projektformen für v0.3

Die Rollouts werden für v0.3 auf drei Hauptformen verdichtet:

### Klein

Beispiele:
- kleines operatives Bestandsprojekt
- kleines Playbook-/Operationsprojekt

Default:

```text
Projektleiterin -> Task
```

Keine AG ohne echten wiederkehrenden Strang.

### Hub

Beispiele:
- kleines oder mittleres Projekt mit mehreren wiederkehrenden Themen
- maschinenbezogener Hub
- Greenfield nach der ersten Konzeptphase

Default:

```text
Projektleiterin -> AG -> Task
```

AGs sind hier sinnvoll, wenn sie Kontext trennen und Richtungsfehler vermeiden.

### Overlay

Beispiele:
- großes bestehendes Repo
- bestehendes agent-first Infrastruktur- oder Plattformprojekt

Default:

```text
Projektleiterin -> AG -> Task
```

Wichtig:
- Setup ist Steuer-/Re-Entry-Schicht, nicht technische SSOT.
- Operative Arbeit braucht gezieltes Nachladen der technischen Projektwahrheit.

### Greenfield und Non-Coding

- **Greenfield** ist zunächst eine Startphase: Konzept verdichten, Prinzipien klären, erste Produktzellen schneiden; danach wird daraus Klein oder Hub.
- **Non-Coding-Light** ist ein separater leichter Track und bekommt nicht automatisch das volle Coding-Setup.

## Default-Delegationsregel in Coding-Projekten

Für größere Coding-Projekte gilt standardmäßig:
- die **Projektleiterin** steuert das Projekt und eröffnet AGs
- die **AG** ist innerhalb ihres Strangs normalerweise die Instanz, die Coding-Tasks losschickt und wieder empfängt
- die **Projektleiterin** schickt nur dann direkt einen Task los, wenn kein eigener Strang nötig ist oder wenn es um einen kleinen direkten Lauf bzw. einen strangsübergreifenden Sonderfall geht

Praktische Folge:
- **Projektleiterin -> AG** ist der normale Steuerpfad
- **AG -> Task** ist der normale operative Coding-Pfad
- **Task -> AG -> Projektleiterin** ist der normale Rückweg

## Wann welche Ebenen?

### 1 Ebene
**Nur Task**

Für sehr kleine, klar eingegrenzte Arbeiten:
- schneller Check
- kleine Recherche
- kleine Erklärung
- klarer One-Shot

### 2 Ebenen
**Projektleiterin -> Task** oder **AG -> Task**

Das ist der häufige Fall, wenn ein eigener größerer Strang nicht nötig ist, aber der Task trotzdem bewusst geführt werden soll.

Praktisch heißt das:
- in kleineren Projekten kann die **Projektleiterin** selbst den Task-Kreis fahren
- in größeren Projekten fährt meist die **AG** diesen Kreis für ihren Strang

### 3 Ebenen
**Projektleiterin -> AG -> Task**

Nur wenn ein Thema mehrere Schritte, Entscheidungen, Explorationen oder Rückläufe braucht.

## Artefakte

### Projektkontext
`projektkontext.md`

Zweck:
- aktueller Stand eines Projekts
- aktive AGs
- offene Entscheidungen
- wichtigste Risiken
- nächster sinnvoller Schritt

Charakter:
- operativ
- kompakt
- häufig aktualisiert
- Re-Entry-Dokument für die Projektleiterin

### Arbeitsmodell
`arbeitsmodell.md`

Zweck:
- methodische Regeln
- Rollenverständnis
- Naming Conventions
- Tree-vs-Fork-Regeln
- Sprach- und Entscheidungsregeln
- Lifecycle-Regeln

Charakter:
- stabiler als der Projektkontext
- projektübergreifend wiederverwendbar

### AG-Notiz
Eine AG-Notiz hält den Stand eines Strangs zusammen.

Zweck:
- Scope der AG
- relevante Quellen
- offene Entscheidungen
- aktive Tasks
- wichtige Verdichtungen
- nächster Schritt

### Task-Auftrag
Ein klarer Arbeitsauftrag aus AG oder Projektleiterin an einen Task.

### Task-Rückmeldung
Eine normierte Rückmeldung aus einem Task zurück an AG oder Projektleiterin.

### Verdichtung
Eine kompakte Ableitung aus Exploration oder einem Seitenstrang.

Zweck:
- das Wesentliche behalten
- das Rauschen zurücklassen
- sauber in einen Tree-Rücksprung oder in die nächste Ebene überleiten

### Entscheidung für Richard
Ein strukturiertes Entscheidungsformat, wenn ein echter Richtungszweig offen ist.

## Lifecycle-Regeln

Ohne Pflege verrotten die Artefakte. Deshalb gelten diese Regeln:

### Projektleiterin
- aktualisiert `projektkontext.md` am Ende jeder relevanten Arbeitssitzung
- aktualisiert `projektkontext.md`, nachdem eine AG-Rückmeldung integriert wurde
- hält die offenen AGs und den nächsten Schritt aktuell

### AG
- hält ihre AG-Notiz nach wichtigen Task-Rückmeldungen aktuell
- markiert, wenn eine AG pausiert, abgeschlossen oder neu zugeschnitten wurde

### Task
- endet mit einer Task-Rückmeldung
- schreibt keine stille Folgewahrheit in den Chat, sondern gibt Rückgaben explizit zurück

### Memory-Routine
Für Projekte mit `memory-vault` gilt vorerst als manuelle Routine:
- am Ende einer relevanten Projektleiterin-Sitzung nach neuen oder geänderten Memory-Einträgen: `memory-vault reindex`
- danach: `memory-vault generate --sync-context-files`

Das ist bewusst zuerst eine Routine, keine versteckte Automatik.

## Session Naming Conventions

Sessions sollen in Pi mit `/name ...` gesetzt werden.

Standardmuster:

```text
<projekt> | Projektleiterin
<projekt> | AG | <thema>
<projekt> | Task | <thema>
```

Beispiele:

```text
webstack | Projektleiterin
webstack | AG | auth-hardening
webstack | Task | session-restore-fix
coding-agent-setup | Projektleiterin
coding-agent-setup | AG | memory
coding-agent-setup | Task | pi-plugin-research
```

Regeln:
- Projektleiterin immer benennen
- AG immer benennen
- Task benennen, sobald Wiederaufnahme oder Vergleich wahrscheinlich ist

## Re-Entry-Regeln

Eine gute Projektleiterin oder AG muss nach Tagen oder Wochen wieder arbeitsfähig werden können.

Dafür gilt:
- Re-Entry startet aus Dateien, nicht aus Hoffnung auf Chat-Magie
- `projektkontext.md` ist der wichtigste Einstiegspunkt
- Arbeitsmodell, AG-Notizen und Rückmeldungen müssen schnell lesbar sein
- lange operative Exploration wird verdichtet, nicht dauerhaft roh mitgeschleppt

## Koordinationsschleife für ausgelagerte Coding-Tasks

Wenn Projektleiterin oder AG einen Coding-Task losschicken, gilt als Standard:

```text
Auftrag -> Arbeit -> Verdichtung -> Rückkehr
```

Praktisch heißt das:

1. **Auftrag:** Ziel, Scope, Nicht-Scope, Inputs, Checks und Rückgabeformat klären.
2. **Arbeit:** Task bewusst scoped laufen lassen, ohne die höhere Ebene mit Rohkontext zu füllen.
3. **Verdichtung:** Ergebnis als Task-Rückmeldung, AG-Notiz, Projektkontext-Update oder eigene MD-Datei sichern.
4. **Rückkehr:** höhere Ebene arbeitet nur mit der Verdichtung weiter; bei Tree-Exploration über Anker/Return zum schlanken Punkt zurückgehen.

Das gilt:
- für **Projektleiterin -> Task** in kleineren Projekten oder kleineren direkten Läufen
- für **AG -> Task** als normalen operativen Coding-Pfad in größeren Projekten

## Tree, Fork und Anker

### Anker / Return

Für v0.3 ist Anker/Return der bevorzugte praktische Mechanismus für temporäre Exploration in derselben Pi-Session.

Merksatz:

```text
anchor -> explore -> distill -> return
```

Nutzen:
- vor Exploration einen sauberen Punkt markieren
- Recherche oder Datei-Lesen temporär erlauben
- Ergebnis als MD-Datei oder kanonische Notiz sichern
- zum Anker zurückkehren und nur mit dem Ergebnis weiterarbeiten

Aktueller Spike:
- `/anchor <name> [note]`
- `/anchors`
- `/return <name> [--with file.md]`

Details: `stacks/context-control.md` und `guides/pi-anker-return-workflow.md`.

### Tree

Tree bleibt Pi's Grundmechanismus für Navigation innerhalb derselben Session-Datei.

Nutzen:
- Branches erhalten
- frühere Punkte wiederfinden
- Ankerpunkte per Label sehen
- bei Bedarf manuell zurückspringen

### Fork

Fork bedeutet: neue Session-Datei, neue Identität.

Nutzen:
- neue AG auslagern
- neuen Task abspalten
- einen eigenen Lauf separat führen

Merksatz:

```text
handoff -> separate -> return explicitly
```

Wichtiger Unterschied:
- Bei einem Fork bleiben die Linien nicht in derselben aktiven Session zusammen.
- Rückführung muss bewusst über Dateien oder Rückmeldungen passieren.

## Human in the Loop

Richard soll nicht mit rohen Rückfragen überflutet werden.

Wenn eine echte Entscheidung offen ist, wird das in einem strukturierten Format zurückgespielt:
- kurzer Kontext
- klarer Entscheidungspunkt
- Option A
- Option B
- Empfehlung
- Default ohne Antwort

Wenn ein Auftrag zu etwa 80 Prozent klar ist, darf der Agent mit klar benannten Annahmen weiterarbeiten.

## Sprache

Arbeitsannahme:
- agent-lesbare Feldnamen in Templates bleiben **concise english**
- Richard-lesbare Einordnung ist **Deutsch**

Praktische Folge:
- operative Templates nutzen englische Kernfelder wie `Goal`, `Scope`, `Checks`, `Risks`
- ein Block `Für Richard` gehört in jede Task-Rückmeldung und in jede menschlich relevante Einordnung

## Durable Memory und offene Schleifen

Diese Schichten bleiben getrennt:

### Durable Memory
Für langlebiges, wiederverwendbares Wissen:
- Entscheidungen
- Learnings
- Workarounds
- Risiken
- Schulden
- Procedures

Gewählter v0.2-Stack:
- `memory-vault` als Backend
- MD-Dateien als Source of Truth
- Details in `stacks/memory.md`

### Todos / offene Schleifen
Für offene Arbeit:
- später prüfen
- Doku nachziehen
- Workaround entfernen
- Audit wiederholen
- Test ergänzen

Grundregel:
- **Memory = Wissen**
- **Todo = offene Handlung**

## Externe Tasks

Wenn ein Task außerhalb von Pi läuft, z. B. in Claude Code:
- der Task bekommt trotzdem einen klaren Task-Auftrag
- der Übergang wird über ein bewusstes Handoff-Artefakt gemacht
- die Rückgabe kommt wieder als Task-Rückmeldung zurück

Details in `stacks/handoff.md`.

## Rolle von `coding-agent-setup`

`coding-agent-setup` ist ein Meta-Projekt.

Es soll langfristig:
- das Arbeitsmodell schärfen
- Templates pflegen
- Setup-Entscheidungen dokumentieren
- über mehrere Projekte hinweg lernen
- später ein Projektportfolio aufbauen

Es soll **nicht** die operative Projektleiterin aller anderen Projekte ersetzen.

Jedes größere Projekt bekommt eine eigene Projektleiterin.

## Prioritätsregel für v0.3

Reihenfolge der nächsten Arbeit:
1. Context Control praktisch testen: Anker/Return in echter Pi-Arbeit.
2. Setup-Oberfläche verschlanken: Klein/Hub/Overlay, weniger Pflichtartefakte, klarere Defaults.
3. Memory, Search, Task-Delegation und Testing nur aus echten Nutzungsbefunden weiter schärfen.
4. Erst danach weitere Pi-Extensions, Packages oder Automatisierungen bauen.
