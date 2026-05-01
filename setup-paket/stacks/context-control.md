# Stack | Context Control

Setup-Version: v0.3-draft in Arbeit  
Stand: 2026-04-24

## Zweck

Dieses Dokument macht Kontextfenster-Disziplin zum eigenen Arbeitsstandard.

Die Praxis nach den ersten 1–2 Wochen zeigt:

> Gute Regeln in Markdown reichen nicht. Exploration muss praktisch so geführt werden, dass die Hauptsession danach wieder schlank wird.

Der wichtigste neue v0.3-Hebel ist deshalb:

```text
Anker setzen -> explorieren -> verdichten -> zurück zum Anker -> nur Ergebnis weitertragen
```

## Leitprinzip

Das Setup greift nur dort ein, wo normale Pi-Arbeit unscharf wird:

- wenn eine Session viele Dateien oder Webquellen lesen müsste
- wenn eine Projektleiterin operative Details mitzuschleppen beginnt
- wenn eine AG nach Exploration wieder einen schlanken Steuerpunkt braucht
- wenn ein Task-Rücklauf in dauerhafte Artefakte überführt werden muss
- wenn Re-Entry sonst aus Chat-Historie statt aus Dateien passieren würde

Kleine Arbeiten dürfen weiterhin einfach in Pi passieren.

## Arbeitsmodi

### 1. Einfach Pi

Für kleine, klare Arbeiten:

- kurze Frage
- kleine Erklärung
- kleine Änderung
- schneller Check

Keine AG, kein Task-Ritual, kein Anker nötig.

### 2. Pi + Anker

Für Exploration in einer laufenden Projektleiterin- oder AG-Session:

- mehrere Dateien lesen
- Web-Recherche machen
- Alternativen prüfen
- vorläufige Einschätzung erarbeiten

Standard:

```text
/anchor <name>
# explorieren
# Ergebnis in MD verdichten
/return <name> --with <datei.md>
```

### 3. Projektleiterin + AG

Für mehrdeutige oder wiederkehrende Stränge:

- Projektleiterin formuliert AG-Startprompt
- AG antwortet
- Projektleiterin schärft die AG nach
- AG arbeitet weiter oder erstellt Tasks
- AG verdichtet zurück zur Projektleiterin

Diese **Nachschärf-Schleife** ist ein v0.3-Kernmuster für Hub- und Overlay-Projekte, aber keine Pflicht für kleine Arbeiten.

### 4. AG/Projektleiterin + Task

Für klar begrenzte operative Läufe:

- Coding
- Testen
- Read-Pass
- Review
- externe Ausführung mit Claude Code oder Pi headless

Der Task bekommt nur den nötigen Scope und liefert eine Rückmeldung oder eine Verdichtung zurück.

## Wann Anker setzen?

Setze einen Anker, sobald eine der folgenden Bedingungen erfüllt ist:

- du erwartest mehr als 3–5 Datei-Lesevorgänge
- du erwartest längere Web-Recherche
- du willst verschiedene Richtungen prüfen
- du bist in einer Projektleiterin und drohst operativ tief zu lesen
- du willst nachher nur ein Ergebnis behalten, nicht den ganzen Weg

Nicht nötig bei:

- trivialen Einzelschritten
- kurzen Datei-Edits
- klaren Task-Handoffs, die ohnehin in separater Session laufen

## Anker-v0-Prototyp

Für dieses Repo ist ein erster projektlokaler Pi-Extension-Spike vorbereitet:

- Asset: `setup-paket/assets/pi-extensions/anchor-return.ts`
- Projektlokaler Loader: `.pi/extensions/anchor-return/index.ts`

Kommandos:

```text
/anchor <name> [note]
/anchors
/distill <name> [--to file.md] [--send]
/return <name> [--with file.md] [--summarize]
```

Verhalten:

- `/anchor` markiert den aktuellen Session-Leaf mit einem Label und speichert einen Custom Entry.
- `/anchors` listet gespeicherte Anker.
- `/return` nutzt Pi's Tree-Navigation, um auf den gespeicherten Entry zurückzugehen.
- `--with <file>` fügt nach der Rückkehr einen Entwurf in den Editor ein, der auf die Verdichtungsdatei verweist.

Bewusst noch nicht enthalten:

- vollautomatisches Distill-and-Return ohne Richard-Prüfung
- automatische Prüfung, ob eine Verdichtungsdatei wirklich geschrieben wurde
- persistente Ankerlogik über mehrere Sessions hinaus als eigenes Managementsystem
- automatische Weiterleitung zwischen Sessions
- automatische Memory-Syncs

## Manuelle Fallback-Routine ohne Extension

Wenn der Extension-Spike gerade nicht verfügbar ist:

1. Vor Exploration explizit schreiben: „Anker: `<name>`“.
2. Exploration durchführen.
3. Ergebnis in eine MD-Datei schreiben.
4. Über `/tree` zum Punkt vor der Exploration zurückspringen.
5. Von dort nur mit Verweis auf die MD-Datei weiterarbeiten.

Das ist umständlicher, aber methodisch derselbe Flow.

## Kontext-Regeln für Rollen

### Projektleiterin

Soll lesen:

- `projektkontext.md`
- relevante AG-Rückmeldung
- relevante Verdichtung
- nur bei Bedarf einzelne kanonische Stack-/Guide-Dateien

Soll vermeiden:

- routinemäßiges tiefes Dateilesen
- lange Tool-Ausgaben im Hauptkontext
- operative Debug-Spuren

### AG

Darf tiefer lesen als die Projektleiterin, muss aber verdichten.

Nach Exploration gilt:

```text
AG schreibt Ergebnis in AG-Notiz, Task-Rückmeldung oder Verdichtungsdatei.
Projektleiterin bekommt Ergebnis, nicht Rohkontext.
```

### Task

Darf scoped arbeiten und Rohkontext verbrauchen.

Aber:

```text
Task-Rückmeldung ist die Grenze. Rohkontext bleibt im Task.
```

## Verhältnis zu Compaction

Pi-Compaction bleibt nützlich, ist aber nicht dasselbe wie Context Control.

- Compaction ist ein nachträgliches Zusammenfassen eines gewachsenen Kontextes.
- Anker/Return ist ein bewusstes Zurückkehren zu einem sauberen Punkt.

Für v0.3 ist Anker/Return der bevorzugte Weg, wenn die Exploration von Anfang an als temporär erkennbar ist.

## Erfolgskriterium

Der Anker-Workflow ist erst dann gelungen, wenn Richard praktisch erlebt:

- vor Exploration: schlanker Kontext
- während Exploration: Kontext darf wachsen
- nach Rückkehr: Kontext ist wieder fast so schlank wie vorher
- Ergebnis bleibt als MD-Datei auffindbar
- Projektleiterin/AG bleibt steuerungsfähig

## Nächste Validierung

1. Extension in diesem Repo mit `/reload` oder neuer Pi-Session laden.
2. In einer echten Projektleiterin- oder AG-Session testen:
   - `/anchor test`
   - kleine Exploration
   - Verdichtung schreiben
   - `/return test --with <datei.md>`
3. Prüfen:
   - funktioniert die Rückkehr?
   - sinkt die Kontextlast gefühlt/angezeigt?
   - bleibt der Editor-Entwurf sinnvoll?
   - entstehen Tree-Verwirrungen?
4. Erst danach über `/distill` oder weitere Automatik entscheiden.
