# Vorschlag: WebSocket-Token-Handling und Logging bewusster härten

## Ausgangsproblem

Aktuell wird das JWT beim WebSocket-Aufbau als Query-Parameter verwendet.

Das ist technisch verständlich, aber hat einen bekannten Nachteil:
- Query-Parameter landen leicht in Proxy-/Access-Logs
- damit können Tokens unbeabsichtigt in Logsysteme geraten

---

## Erst einmal die ehrliche Einordnung

Das ist **kein** Totalversagen und auch nicht automatisch „falsch“.

Bei Browser-/Browser-ähnlichen WebSocket-Clients ist die Situation etwas unpraktisch, weil man nicht so frei beliebige Header setzen kann wie bei einem normalen HTTP-Request.

Darum ist `?token=...` in der Praxis leider keine exotische Lösung.

---

## Meine empfohlene Änderung

## Kurzform
Kurzfristig: Query-Token bewusst dokumentieren und die Risiken reduzieren.
Mittelfristig: wenn gewünscht, auf kurzlebige WS-Tickets oder ähnliches umsteigen.

---

## Meine pragmatische Empfehlung

### Variante A — Query-Token vorerst behalten, aber absichern (meine Empfehlung)

#### Konkret sinnvoll
- JWTs kurzlebig halten
- klar dokumentieren, dass Reverse Proxy Query-Strings nicht loggen sollte
- in Deployment-Doku auf dieses Thema explizit hinweisen
- ggf. Tokens nicht unnötig lang gültig machen

#### Vorteile
- kleinster Umbau
- realistisch für die aktuelle Architektur
- gute pragmatische Verbesserung

#### Nachteile
- Query-String-Risiko bleibt grundsätzlich vorhanden

#### Ehrliche Einschätzung
Für ein self-hosted Projekt ist das eine völlig legitime Zwischen- oder sogar Dauerlösung, solange man sie bewusst betreibt.

---

## Realistische Alternativen

### Variante B — One-time WS-Ticket / kurzer Upgrade-Token

#### Idee
1. Plugin holt per HTTP ein sehr kurzlebiges Ticket
2. WebSocket verbindet sich mit `?ticket=...`
3. Ticket ist einmalig oder nur sehr kurz gültig

#### Vorteile
- deutlich besser als langlebigeres JWT im Query-String
- Logs werden weniger kritisch

#### Nachteile
- mehr Protokoll-/Serverlogik
- etwas mehr Zustandsverwaltung

#### Ehrliche Einschätzung
Das ist die beste technische Weiterentwicklung, wenn du das Thema wirklich härter machen willst.

---

### Variante C — Cookie-/Session-Modell

#### Vorteile
- klassisch für Webanwendungen

#### Nachteile
- für dieses Plugin-/Self-hosted-Szenario oft unnötig kompliziert
- bringt eigene Probleme mit sich

#### Ehrliche Einschätzung
Ich sehe hier nicht, dass das aktuell der beste Weg wäre.

---

## Empfehlung

### Wenn du pragmatisch bleiben willst
Nimm **Variante A**.

### Wenn du Richtung „besonders sauber gehärtet“ willst
Plane später **Variante B**.

---

## Was ich zusätzlich sinnvoll finde

1. Doku-Hinweis zu Proxy-Logs
2. Doku-Hinweis, dass TLS/WSS Pflicht für Produktion ist
3. evtl. Trennung zwischen HTTP-Auth-Token und WS-Upgrade-Ticket

---

## Warum ich das nicht überdramatisieren würde

Weil es ein echtes Thema ist, aber nicht dieselbe Klasse wie:
- Datenverlust,
- Delete-Fehler,
- oder kaputte Rebuild-Kette.

Es ist eher ein **Härtungs- und Betriebs-Thema**.

---

## Mein ehrliches Fazit

Für deine jetzige Phase würde ich dieses Thema **bewusst dokumentieren und im Hinterkopf behalten**, aber nicht vor die wichtigeren Korrektheitsbaustellen setzen.

Für einen späteren öffentlichen Stand wäre ein kurzes Ticket-Modell allerdings ein schöner nächster Reifegrad.
