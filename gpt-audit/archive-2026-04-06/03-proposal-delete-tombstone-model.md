# Vorschlag: Delete- und Tombstone-Modell bewusst härten

## Warum dieses Thema wichtig ist

Deletes sind bei Sync-Systemen fast immer einer der gefährlichsten Bereiche.

Nicht weil Löschen technisch schwer wäre, sondern weil mehrere echte Lebenssituationen kollidieren:
- Geräte sind offline
- Geräte reconnecten spät
- dieselbe Datei wird später bewusst neu angelegt
- alte Zustände leben noch lokal weiter
- Tombstones laufen ab oder werden entfernt

Wenn man das nicht sauber modelliert, entstehen schnell „Zombie-Dateien“.

---

## Aktuelles Kernproblem

Im aktuellen Design ist die Delete-Semantik funktional vorhanden, aber noch zu weich:
- Tombstones laufen automatisch ab
- neue Pushes/Create können Tombstones wieder wegräumen
- lokaler persistierter Zustand wird beim Delete nicht überall hart bereinigt

Das ist privat eine Zeitlang oft unauffällig, langfristig aber riskant.

---

## Meine ehrliche Hauptempfehlung

## Für eine robuste öffentliche Zukunft: generationsbasiertes Delete-Modell

### Idee
Jede dokumentbezogene Identität bekommt zusätzlich eine **Generation** oder einen monotonen Delete-/Create-Zähler.

Vereinfacht:
- Datei `notes/a.md` existiert zuerst in Generation 1
- sie wird gelöscht → Generation erhöht sich / alter Zustand ist endgültig veraltet
- spätere Wiederanlage derselben Pfad-Datei ist Generation 2
- alte Clients mit Generation 1 dürfen dann nicht mehr einfach wiederbeleben

### Warum ich das für die beste Langzeitlösung halte
Weil damit „gleicher Pfad, aber neue Lebensphase“ sauber modelliert wird.

Das ist aus meiner Sicht die sauberste Antwort auf das klassische Problem:
> Ist das dieselbe Datei oder eine neue Datei am alten Pfad?

---

## Ehrliche Nachteile dieser starken Lösung

- mehr Datenmodell-/Protokollarbeit
- mehr Tests
- potenziell Migrationsaufwand
- nicht die kleinste Änderung

Darum ist das zwar meine **beste Architektur-Empfehlung**, aber nicht automatisch die schnellste Sofortlösung.

---

## Realistische Alternativen

### Variante A — Tombstones nur länger halten + lokale State-Bereinigung

#### Idee
- Tombstone-Retention deutlich erhöhen, z. B. 90 oder 180 Tage
- lokales `.loro`-State beim Delete konsequent löschen
- Resurrection während aktiver Tombstone-Phase verhindern oder mindestens stark erschweren

#### Vorteile
- viel kleinerer Umbau
- reduziert das Risiko schon spürbar
- wahrscheinlich guter Zwischenstand für Privatnutzung

#### Nachteile
- das Grundproblem „gleicher Pfad später neu angelegt“ bleibt konzeptionell unvollständig
- legitime Wiederanlage am selben Pfad wird schwieriger
- irgendwann kommt die Designfrage wieder

#### Ehrliche Einschätzung
Das ist die beste **Kurzfrist-/Zwischenlösung**, wenn du noch keinen größeren Protokollumbau willst.

---

### Variante B — Tombstones niemals automatisch löschen

#### Vorteile
- sehr sicher gegen Resurrection
- logisch einfach

#### Nachteile
- dauerhafte DB-Anhäufung
- Wiederanlage derselben Datei am selben Pfad wird problematisch
- für echte Nutzung auf Dauer zu starr

#### Ehrliche Einschätzung
Als Notbremse denkbar, aber nicht meine bevorzugte Dauerlösung.

---

### Variante C — Explizites „Recreate“ als eigener Protokollfall

#### Idee
Delete bleibt stark; wenn ein Nutzer bewusst denselben Pfad wieder anlegen will, geschieht das über einen eigenen Recreate-Flow.

#### Vorteile
- fachlich klar
- Resurrection und legitime Wiederanlage sind sauber getrennt

#### Nachteile
- mehr UX- und Protokoll-Komplexität
- wahrscheinlich zu groß für den nächsten kleinen Schritt

#### Ehrliche Einschätzung
Gute Idee, wenn das Projekt später noch größer wird. Für jetzt eventuell overkill.

---

## Meine gestufte Empfehlung

### Wenn du bald sicherer werden willst
**Phase 1**
- Tombstones länger halten
- lokalen persistierten State beim Delete hart entfernen
- serverseitig stale Resurrection schwieriger machen

### Wenn du es wirklich community-ready willst
**Phase 2**
- generationsbasiertes Modell einführen

So musst du nicht alles auf einmal machen, aber baust in die richtige Richtung.

---

## Was ich in Phase 1 konkret sinnvoll fände

1. Tombstones nicht nach 7 Tagen, sondern deutlich später abräumen
2. Bei lokalem und remote Delete auch den persistierten Dokumentzustand sauber entfernen
3. Klare Tests für Offline-Client nach Delete
4. Keine stillschweigende Wiederbelebung durch veralteten Push

### Warum ich Phase 1 sinnvoll finde
Weil sie viel Sicherheitsgewinn bringt, ohne sofort das ganze Protokoll umzubauen.

---

## Was ich in Phase 2 konkret sinnvoll fände

1. Generation pro Dokumentpfad oder Pfadidentität
2. Nachrichten tragen erwartete Generation mit
3. Server lehnt stale Push/Create für alte Generation ab
4. bewusste Wiederanlage bekommt neue Generation

### Warum ich Phase 2 sinnvoll finde
Weil damit Delete fachlich sauber wird und nicht nur „halbwegs gut genug“.

---

## Tests, die ich sehen wollen würde

1. Datei gelöscht, anderer Client lange offline, reconnect → keine Zombie-Datei
2. Datei gelöscht, später bewusst neu angelegt → definiertes Verhalten
3. lokaler alter CRDT-State kann neue Datei nicht versehentlich kontaminieren
4. Tombstone-Ablauf führt nicht zu stiller Resurrection
5. Delete + Rename + Recreate am gleichen Pfad

---

## Meine ehrliche Empfehlung

Wenn du nur fragst: „Was ist kurzfristig sinnvoll?“
- Phase 1

Wenn du fragst: „Was will ich vor einem wirklich ruhigen Community-Release eigentlich fachlich haben?“
- Phase 1 **plus** mittelfristig Generationenmodell

---

## Mein ehrliches Fazit

Delete ist hier einer der Punkte, wo ich **bewusst designen** würde statt nur schnell zu patchen.

Eine kleine Zwischenlösung ist möglich und sinnvoll.
Die wirklich gute Langzeitlösung ist aus meiner Sicht aber ein **expliziteres Modell für Recreate vs. stale Resurrection**.
