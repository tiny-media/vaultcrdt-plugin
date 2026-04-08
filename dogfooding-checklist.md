# Dogfooding-Checkliste — v0.2.17

Ziel: manuelles Ende-zu-Ende-Testing nach Conflict-Storm-Härtung (`f366dd8`),
Delete-Ack-Härtung (`aa60d60`) und Dep-Updates.
Setup: Desktop (Vault A ↔ Server) + Android parallel wo angegeben.

Wichtig: Vor Start den richardsachen-Vault + andere alte Vaults löschen (nicht
in Prod). Der Fix heilt den bestehenden Schaden nicht, nur neue Vaults starten
sauber.

---

## 1. Grundfunktion — Online-Edit

- [ ] Datei auf Desktop bearbeiten → Änderung erscheint auf Android (< 5s)
- [ ] Datei auf Android bearbeiten → Änderung erscheint auf Desktop (< 5s)

## 2. Online-Delete

- [ ] WS offen, Datei auf Desktop löschen → auf Android weg (< 5s)
- [ ] WS offen, Datei auf Android löschen → auf Desktop weg (< 5s)
- [ ] Obsidian auf Desktop neu starten → Datei bleibt weg (kein Ghost-Reconnect)

## 3. Offline-Delete

- [ ] WS auf Desktop killen (Plugin deaktivieren oder Netz trennen)
- [ ] Datei löschen während offline
- [ ] WS reconnecten → Datei weg, bleibt weg
- [ ] Dasselbe auf Android: Netz weg, Datei löschen, Netz an → Datei weg

## 4. Kill-während-Commit-Race (Kernfall für `aa60d60`)

- [ ] Delete auf Desktop triggern, WS **sofort** killen (Plugin deaktivieren bevor ACK ankommt)
- [ ] Reconnecten → Datei weg (Server hat Tombstone, Plugin reconciled delete journal)
- [ ] Variante: Delete auf Android, sofort in Flugmodus, zurück → Datei weg

## 5. Rename

- [ ] Datei auf Desktop umbenennen → neuer Name auf Android, alter weg
- [ ] Datei auf Android umbenennen → neuer Name auf Desktop, alter weg
- [ ] Rename während Offline → nach Reconnect konsistent

## 6. Conflict-Fork (aus Zyklus-1-Tests)

- [ ] Beide Seiten gleichzeitig dieselbe Datei bearbeiten (Netz getrennt) → nach Reconnect: eine Version gewinnt, keine Datei verloren
- [ ] Beide Seiten dieselbe Datei löschen → nach Reconnect: weg, kein Fehler

## 7. Mehrere Dateien gleichzeitig

- [ ] 5+ Dateien auf Desktop anlegen → alle erscheinen auf Android
- [ ] 5+ Dateien auf Desktop löschen → alle weg auf Android

## 8. Server-Neustart

- [ ] Server stoppen, auf Desktop weiterarbeiten (Edit + Delete), Server starten → alles synchronisiert sich

## 9. Conflict-Storm-Härtung (Kernfall für `f366dd8`)

### 9a. Stabile PeerID über Restarts

- [ ] Datei auf Desktop anlegen, bearbeiten, Obsidian beenden
- [ ] Obsidian neu starten, dieselbe Datei weiter bearbeiten
- [ ] Datei bleibt sauber (kein doppelter Text, keine Phantom-Inserts durch neue VV-Linie)
- [ ] Dasselbe Szenario 5× hintereinander wiederholen → keine Drift

### 9b. Phase-3 Adopt-Semantik (disjoint VV, gleicher Text)

- [ ] Desktop offline nehmen, Datei minimal bearbeiten (derselbe Text am Ende → Hash gleich)
- [ ] Android dieselbe Datei bearbeiten, sodass am Ende ebenfalls derselbe finale Text steht
- [ ] Beide wieder online bringen → einer der Clients adopted, kein Conflict-File, kein doppelter Text
- [ ] Variante: beide mit echten Text-Differenzen → **ein** Conflict-File mit der verlorenen Seite, Primärdatei behält eine Version

### 9c. Phase-2 Adopt (fehlender lokaler CRDT-State)

- [ ] Auf Desktop `data.json` löschen (Plugin-State weg), Obsidian neu starten
- [ ] Initial-Sync zieht Server-Snapshot **wholesale** (kein Merge-Versuch gegen lokalen Text)
- [ ] Wenn lokaler Text identisch war: kein Conflict-File, genau **ein** `sync_start` mit `client_vv=null`
- [ ] Wenn lokaler Text differs: genau **ein** Conflict-File mit dem lokalen Text

### 9d. Editor-first Content Reads (Kernfall gegen stale disk)

- [ ] Datei in Desktop-Obsidian öffnen, Text eintippen **ohne zu speichern** (Obsidian-Auto-save deaktivieren falls nötig)
- [ ] Während die Änderung im Editor-Buffer hängt: Sync via Disconnect/Reconnect triggern
- [ ] Wenn Konflikt entsteht: Conflict-File-Body enthält **Editor-Text**, nicht den alten Disk-Stand
- [ ] Dasselbe mit Datei in Split-Pane (nicht active leaf): Editor-Text wird ebenfalls bevorzugt

### 9e. Local-only doc_create mit offenem Editor

- [ ] Neue Datei auf Desktop anlegen, sofort tippen **ohne zu speichern**
- [ ] Sync triggern → Server bekommt **Editor-Text**, nicht die (leere) Disk-Version

### 9f. Vault-Klon-Caveat (erwartet bricht!)

- [ ] `data.json` inkl. `peerId` auf ein zweites Gerät kopieren (z.B. via Cloud-Sync)
- [ ] Beide Geräte starten → **erwartet: Konflikte weil PeerID identisch** (ist bekannt, siehe `project_peerid_clone_caveat` Memory)
- [ ] Wenn das passiert: nur dokumentieren, kein Blocker für Release

---

## Ergebnis

Datum: ___________
Desktop-Version: 0.2.17
Android-Version: 0.2.17

- [ ] Alle Checks grün → bereit für weitere Nutzung
- [ ] Gefundene Issues → unten notieren

### Issues

_keine_
