# Vorschlag: Auth- und Secret-Handling härten

## Ausgangsproblem

Aktuell sind die Vault-Secrets funktional, aber sicherheitstechnisch eher im Bereich „privater Eigenbetrieb“ als „öffentlich teilbar ohne Bauchweh“.

Die wichtigsten Punkte:
- Vault-Passwort liegt serverseitig im Klartext in der DB
- Prüfung erfolgt per einfachem Vergleich
- `/auth/verify` verrät über Fehlermeldungen mehr als nötig
- Rate-Limiting ist nicht Teil des Systems

---

## Meine empfohlene Änderung

## Kurzform
Für einen stabilen öffentlichen Stand würde ich mindestens Folgendes wollen:
1. Vault-Secrets gehasht speichern
2. Verify über einen langsamen Passwort-Hash, z. B. Argon2id
3. Fehlertexte für öffentliche Pfade etwas generischer machen
4. Rate-Limiting mindestens über Reverse Proxy oder optional im Server vorsehen

---

## Warum ich das sinnvoll finde

Selbst wenn das Projekt self-hosted ist, gilt:
- Menschen wählen oft schwache Passwörter
- Logs/DB-Dumps/Backups sind reale Leckpfade
- Community-Nutzer erwarten heute ein Mindestmaß an Secret-Hygiene

### Vorteile
- deutlich bessere Sicherheitsbasis
- weniger Schaden bei Datenbankleck
- besser vermittelbar für öffentliche Nutzung

### Nachteile
- Migration nötig
- Login/Verify minimal teurer
- etwas mehr Komplexität im Code und Deployment

Ich halte diesen Preis für angemessen.

---

## Meine konkrete Empfehlung

### Variante A — Argon2id + Migration (meine Empfehlung)

#### Idee
- neue Vaults speichern nur noch Hash
- bestehende Klartext-Einträge werden migriert
- Verify läuft über Argon2id

#### Vorteile
- heutiger Standard
- gute Bibliothekslage
- deutliche Verbesserung ohne komplettes Redesign

#### Nachteile
- Migrationslogik nötig
- du musst Parameter sinnvoll wählen

#### Ehrliche Einschätzung
Das ist aus meiner Sicht die richtige Standardlösung.

---

## Realistische Alternativen

### Variante B — scrypt statt Argon2id

#### Vorteile
- ebenfalls solide
- breit verfügbar

#### Nachteile
- Argon2id ist heute meist die naheliegendere Standardempfehlung

#### Ehrliche Einschätzung
Technisch völlig okay. Wenn du gute Gründe/Bibliothekspräferenz hast, kann das genauso passen.

---

### Variante C — Klartext lassen, weil nur private Nutzung

#### Vorteile
- null Migrationsaufwand
- simpel

#### Nachteile
- schwacher Zustand
- schlecht für Community-Veröffentlichung
- unnötig riskant, sobald mehr Leute es benutzen

#### Ehrliche Einschätzung
Für nur dich selbst denkbar, aber ich würde das nicht als Zielzustand konservieren.

---

## Thema Fehlermeldungen

Aktuell ist die UX freundlich, weil sie klar unterscheidet:
- falsches Passwort
- falscher Admin-Token / Vault existiert nicht

Das ist aus Usability-Sicht nett, aber aus Sicherheits-/Enumeration-Sicht nicht ideal.

### Meine ehrliche Empfehlung
- **Plugin-UX intern gern hilfreich halten**, wenn du das willst
- aber nach außen den Server eher generischer antworten lassen
- oder zumindest bewusst entscheiden: private UX-Komfort vs. öffentliche Härte

Ich würde für einen öffentlichen Release eher Richtung generischer Fehlermeldung gehen.

---

## Thema Rate-Limiting

### Mein ehrlicher Blick
Das muss nicht zwingend sofort in die Rust-Anwendung selbst.

Für self-hosted Projekte ist es oft völlig okay, zuerst zu sagen:
- Rate-Limiting über Reverse Proxy
- TLS sowieso dort
- Logging/Fail2ban/etc. dort

### Warum ich das okay finde
Weil du dadurch die App kleiner hältst und viele Admins sowieso Nginx/Traefik/Caddy davor haben.

### Alternative
App-internes Rate-Limiting ist robuster gegen Fehlkonfiguration, aber aufwendiger.

---

## Was ich konkret für einen guten nächsten Stand empfehlen würde

### Mindestpaket
1. Secrets hashen
2. Migration vorsehen
3. Verify auf Hashvergleich umstellen
4. README-Sicherheitsabschnitt aktualisieren

### Schönes Paket für Public Release
5. öffentliche Fehlertexte härten
6. Rate-Limiting dokumentieren oder serverseitig ergänzen
7. Security-Hinweise in README klarer machen

---

## Tests, die ich sehen wollen würde

1. neue Vault-Erstellung speichert Hash statt Klartext
2. Verify mit korrektem Secret funktioniert
3. Verify mit falschem Secret schlägt fehl
4. Migration bestehender Vaults klappt
5. keine Regression bei bestehenden Clients

---

## Mein ehrliches Fazit

Wenn du es nur für dich zuhause betreiben würdest, könnte man dieses Thema eine Weile schieben.

Sobald du aber an **GitHub / Obsidian-Community** denkst, würde ich das nicht mehr als optional ansehen.

Nicht, weil jemand sofort angegriffen wird — sondern weil es ein klarer Unterschied ist zwischen:
- „privates Bastelprojekt“ und
- „verantwortbar veröffentlichbares Tool“.
