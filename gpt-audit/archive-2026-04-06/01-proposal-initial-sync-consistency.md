# Vorschlag: Initial-Sync konsistenter und sicherer machen

## Ausgangsproblem

Im aktuellen Initial-Sync werden überlappende Dateien teilweise allein deshalb übersprungen, weil die gecachte Server-VV mit der aktuellen Server-VV übereinstimmt.

Das ist schnell, aber nicht vollständig sicher.

### Realistisches Fehlerszenario
- Gerät war offline oder Obsidian war geschlossen.
- Eine Datei wurde lokal außerhalb von Obsidian geändert, z. B. durch:
  - externen Editor,
  - Git pull / Merge,
  - Syncthing,
  - manuelles Kopieren.
- Der Server hat sich in dieser Datei nicht verändert.
- Beim nächsten Start bleibt die Server-VV gleich.
- Der Initial-Sync überspringt die Datei.

Dann kann die lokale Änderung unbemerkt bleiben.

---

## Meine empfohlene Änderung

### Kurzform
Eine Datei darf nur dann beim Initial-Sync übersprungen werden, wenn **beides** stimmt:
1. Server-VV ist gleich der gecachten VV
2. Der aktuelle lokale Dateiinhalt hat denselben Hash wie beim letzten erfolgreichen Sync

## Warum ich das für sinnvoll halte

Weil das die eigentliche Aussage „nichts hat sich geändert“ erst wirklich absichert.

- VV sagt: **serverseitig nichts Neues**
- Content-Hash sagt: **lokal nichts Neues**

Erst zusammen ergibt das einen belastbaren Skip.

## Ehrliche Bewertung

### Vorteile
- Schließt einen echten Korrektheitsfehler
- Konzeptionell sehr leicht zu verstehen
- Relativ kleine Änderung
- Geringes Risiko für bestehende Architektur

### Nachteile
- Initial-Sync muss dafür mehr lokale Dateien lesen
- Auf sehr großen Vaults kann der Start geringfügig langsamer werden

Ich halte diesen Nachteil aber für akzeptabel, weil Korrektheit hier wichtiger ist als ein aggressiver Skip.

---

## Konkrete empfohlene Variante

### Variante A — meine Empfehlung
Bei jeder überlappenden Datei mit VV-Match:
1. Datei von Disk lesen
2. Hash berechnen
3. Mit `cached.contentHash` vergleichen
4. Nur bei Gleichheit skippen
5. Sonst normaler Sync-Pfad

### Warum ich genau diese Variante empfehle
- am einfachsten zu verstehen
- am leichtesten zu testen
- kleinste Wahrscheinlichkeit für versteckte Folgefehler
- guter erster Schritt, bevor man optimiert

---

## Realistische Alternativen

### Variante B — zuerst `mtime/size`, dann nur bei Abweichung hash/read

#### Idee
Nicht sofort jede Datei komplett lesen, sondern erst Metadaten prüfen:
- Dateigröße
- Änderungszeit

Nur wenn sich dort etwas geändert hat, wird gelesen/gehasht.

#### Vorteile
- schneller auf sehr großen Vaults
- weniger I/O

#### Nachteile
- komplizierter
- stärker von Adapter-/Plattform-Verhalten abhängig
- `mtime` ist nicht überall gleich zuverlässig
- mehr Sonderfälle auf Desktop/Mobile

#### Ehrliche Einschätzung
Das ist eine mögliche spätere Optimierung, aber **nicht** meine erste Empfehlung.

---

### Variante C — immer vollständigen Merge statt Skip

#### Idee
VV-Skip komplett entfernen und jede überlappende Datei immer einmal prüfen/synchronisieren.

#### Vorteile
- maximal simpel im Verhalten
- fast unmöglich, diesen Fehler noch zu haben

#### Nachteile
- unnötig viel Arbeit beim Startup
- du verlierst einen guten Performance-Vorteil
- nicht elegant, wenn das System eigentlich schon genug Informationen hat

#### Ehrliche Einschätzung
Funktional sauber, aber zu grob. Ich würde nicht sofort so weit gehen.

---

## Empfehlung

Ich würde **Variante A** umsetzen.

Wenn sich später zeigt, dass große Vaults dadurch spürbar langsamer starten, kann man immer noch gezielt auf Variante B optimieren.

---

## Was ich zusätzlich testen würde

1. **VV gleich, Datei unverändert** → Skip erlaubt
2. **VV gleich, lokaler Inhalt extern verändert** → darf nicht skippen
3. **VV gleich, Datei leer/nicht leer Grenzfälle**
4. **VV gleich, Datei in aktivem Editor geöffnet**
5. **VV gleich, nur lokaler Zeilenumbruch geändert**

---

## Wann ich diese Änderung für „fertig“ halten würde

- Der bisherige Fehlerszenario-Fall ist durch Tests abgedeckt
- Startup bleibt praktisch noch angenehm
- Es gibt keine stillen lokalen Änderungen mehr, die wegen VV-Skip verloren/übersehen werden

---

## Mein ehrliches Fazit

Das ist für mich die **sinnvollste erste konkrete Verbesserung überhaupt**.

Nicht, weil sie am spektakulärsten ist, sondern weil sie:
- klein genug ist,
- viel Sicherheit bringt,
- und direkt das Vertrauen in den Sync stärkt.
