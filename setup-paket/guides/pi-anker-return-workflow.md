# Guide | Pi-Anker-/Return-Workflow

Stand: 2026-04-24  
Status: v0.3-Spike / zuerst klein testen

## Zweck

Dieser Guide beschreibt Richards neuen Standard für temporäre Exploration in Pi:

```text
Anker setzen -> explorieren -> Ergebnis als MD speichern -> zurück zum Anker -> nur Ergebnis weitertragen
```

Das Ziel ist nicht mehr Prozessdisziplin per Willenskraft, sondern ein kleiner praktischer Workflow, der das Kontextfenster schützt.

## Wann benutzen?

Benutze Anker, wenn du erwartest, dass eine Session sonst mit Recherche- oder Datei-Lese-Kontext vollläuft.

Typische Fälle:

- Projektleiterin muss kurz etwas prüfen, soll aber nicht tief im Rohkontext bleiben.
- AG will mehrere Dateien oder Quellen lesen und danach nur den Befund behalten.
- Du willst eine Richtung explorieren, aber noch nicht entscheiden, ob sie in den Hauptkontext gehört.
- Du willst nach einem Task-/Research-Pass nur die Rückmeldung oder Verdichtung weiterführen.

Nicht nötig bei:

- sehr kleinen Antworten
- einfachen Edits
- echten separaten Tasks, die ohnehin in einer anderen Session laufen

## Verfügbare v0-Kommandos

Im aktuellen Repo ist der Spike projektlokal installiert über:

- `.pi/extensions/anchor-return/index.ts`
- Quelle: `setup-paket/assets/pi-extensions/anchor-return.ts`

Nach `/reload` oder einer neuen Pi-Session stehen bereit:

```text
/anchor <name> [note]
/anchors
/distill <name> [--to file.md] [--send]
/return <name> [--with file.md] [--summarize]
```

## Standardablauf

### 1. Anker setzen

```text
/anchor vor-recherche kurze Notiz zum Zweck
```

Beispiel:

```text
/anchor vor-search-verschlankung prüfen, wie Search-Stack gekürzt werden soll
```

Das Kommando:

- speichert den aktuellen Leaf-Punkt der Session
- setzt ein Tree-Label `anchor:<name>`
- schreibt einen Custom Entry, der nicht in den LLM-Kontext eingeht

### 2. Explorieren

Jetzt normal arbeiten lassen:

```text
Bitte prüfe die relevanten Stellen und finde die kleinste sinnvolle Änderung.
```

Die Session darf in diesem Ast Dateien lesen, Websuche benutzen oder länger nachdenken.

### 3. Ergebnis verdichten

Vor der Rückkehr muss das Ergebnis in eine Datei oder eine bestehende kanonische Notiz geschrieben werden.

Manuell:

```text
Bitte schreibe die Verdichtung nach setup-paket/verdichtungen/search-default-v0.3.md.
```

oder:

```text
Bitte aktualisiere die AG-Notiz mit nur den wiederverwendbaren Ergebnissen.
```

Mit dem v0.3-Spike kann Pi den passenden Verdichtungsauftrag auch vorbereiten:

```text
/distill vor-search-verschlankung --to setup-paket/verdichtungen/search-default-v0.3.md
```

Das setzt einen Editor-Entwurf, der erst von Richard geprüft und abgeschickt wird. Wenn der Auftrag sofort als User-Message gesendet werden soll:

```text
/distill vor-search-verschlankung --to setup-paket/verdichtungen/search-default-v0.3.md --send
```

Ohne `--to` nutzt `/distill` als Default:

```text
setup-paket/task-rueckmeldungen/<anker>-rueckmeldung.md
```

Wichtig:

> Nicht zurückspringen, bevor das Ergebnis gesichert ist.

### 4. Zurückkehren

```text
/return vor-search-verschlankung --with setup-paket/verdichtungen/search-default-v0.3.md
```

Das Kommando:

- springt per Pi-Tree-Navigation zum gespeicherten Anker zurück
- nimmt den Explorationsast nicht weiter als aktiven Kontext mit
- setzt bei `--with` einen kurzen Editor-Entwurf, der auf die Verdichtungsdatei verweist

Optional kann zusätzlich Pi's Branch-Summary beim Tree-Wechsel genutzt werden:

```text
/return vor-search-verschlankung --with setup-paket/verdichtungen/search-default-v0.3.md --summarize
```

Das ersetzt die MD-Verdichtung nicht, kann aber im Session-Tree eine knappe Zusammenfassung des verlassenen Asts hinterlassen.

Der Entwurf wird nicht automatisch abgeschickt. Richard bleibt in the loop.

### 5. Weiterarbeiten vom schlanken Punkt

Der vorgeschlagene Editor-Text sieht sinngemäß so aus:

```text
Die Exploration ab Anker `vor-search-verschlankung` ist verdichtet in:

- `setup-paket/verdichtungen/search-default-v0.3.md`

Bitte lies nur diese Verdichtung und arbeite von diesem schlanken Kontext weiter.
```

Du kannst ihn ändern oder abschicken.

## Wichtige Regeln

### Erst sichern, dann zurück

`/return` verwirft den Explorationsast nicht aus der Datei, aber er ist danach nicht mehr im aktiven Kontext. Deshalb muss das Ergebnis vorher als MD, AG-Notiz, Task-Rückmeldung oder Projektkontext-Update gesichert sein.

### Keine Automatik ohne Richard

Der v0-Spike macht kein automatisches Distill und kein automatisches Abschicken einer neuen Nachricht. Das ist Absicht.

Richard soll prüfen können:

- Ist die Verdichtung gut genug?
- Ist die richtige Datei referenziert?
- Soll der Ast wirklich verlassen werden?

### Nicht zu viele Anker

Anker sind Arbeitsmarker, kein neues Projektmanagementsystem.

Faustregel:

- 1 aktiver Anker pro konkrete Exploration
- selten mehr als 2–3 Anker pro Session

### Projektleiterin besonders schützen

In Projektleiterin-Sessions gilt:

> Wenn mehr als 3–5 Dateien gelesen werden müssten, erst Anker setzen oder AG/Task auslagern.

## Bekannte Grenzen des v0-Spikes

- `/distill` erstellt nur einen Verdichtungsauftrag bzw. sendet ihn mit `--send`; es prüft nicht automatisch, ob die Datei danach wirklich geschrieben wurde.
- Keine automatische Prüfung, ob eine Verdichtungsdatei wirklich geschrieben wurde.
- Keine Persistenzlogik über Session-Dateien hinaus außer Pi's eigener Session-Historie.
- `/return` nutzt Pi's bestehende Tree-Navigation; bei unerwartetem Tree-Verhalten muss der Spike angepasst werden.
- Dateiänderungen aus dem Explorationsast bleiben natürlich im Dateisystem bestehen; nur der aktive Gesprächskontext springt zurück.

## Testprotokoll für den ersten echten Lauf

Beim ersten Test bitte kurz notieren:

```text
Projekt/Session:
Ankername:
Kontext vor Exploration:
Was wurde exploriert:
Verdichtungsdatei:
Return erfolgreich: ja/nein
Kontext danach gefühlt/angezeigt:
Problem/Überraschung:
```

Diese Beobachtung sollte danach in `setup-paket/projektkontext.md` oder eine Rollout-/Review-Notiz zurückfließen.

## Spätere mögliche Erweiterungen

Nur bauen, wenn v0 im Alltag trägt:

- `/distill` nach Praxisbefund weiter verfeinern, z. B. andere Rückgabeformate oder Projektpfad-Defaults
- `/return <name> --summarize` nach Praxisbefund schärfen
- kleine Warnung vor Rückkehr, wenn seit dem Anker Dateien geändert wurden
- globale Installation als Pi-Package
- Integration mit `/memory-sync`

Nicht jetzt bauen:

- automatische Anker
- automatische AG-Projektleiterin-Weiterleitung
- große grafische Tree-UI
- stilles Session-End-Memory ohne explizite Zustimmung
