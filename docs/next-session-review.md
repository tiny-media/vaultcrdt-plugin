# Next Session — Full Code Review (Plugin + Server)

## Auftrag

Umfassender Code-Review beider Repositories nach dem großen Onboarding-Umbau (v0.2.14). Ziel: sicherstellen dass die Codebase sauber, konsistent und wartbar ist.

---

## 1. Variablen & Terminologie

Prüfe ob die Rename-Welle (Vault Secret → Password, Vault ID → Vault Name, registrationKey entfernt) **überall** durchgezogen ist:

- [ ] Alle User-facing Strings: Modals, Settings UI, Notices, Error Messages
- [ ] Alle Kommentare und JSDoc-Kommentare
- [ ] Alle Variablennamen im Code (intern kann `vaultId` / `vaultSecret` bleiben, aber Kommentare sollten konsistent sein)
- [ ] Server: Kommentare in Rust-Code, Error-Messages, Log-Strings
- [ ] Server: API-Feldnamen (`api_key`, `vault_id`) — bleiben wie sie sind (API-Kompatibilität), aber Doku muss klar machen was was ist

---

## 2. Prozesse & Flows

Jeden Flow einmal durchdenken und im Code verfolgen:

- [ ] **Erstinstallation (frisches Gerät):** Plugin lädt → `onload()` → `loadSettings()` → `initWasm()` → Events registriert → `onLayoutReady` → `startWithSetup()` → SetupModal → Auth-Prüfung → `syncEngine.start()` → `handleInitialSync()` → auto-detect → sync
- [ ] **Upgrade von v0.2.13:** `loadSettings()` Migration (registrationKey gelöscht) → `needsSetup` false (weil vaultId + vaultSecret vorhanden) → normaler Start
- [ ] **Cancel im Setup:** Notice angezeigt → kein Sync → nächster Start zeigt Modal wieder
- [ ] **Reconnect nach Disconnect:** WebSocket-Reconnect-Logik in SyncEngine → auth erneut → connect
- [ ] **Settings ändern während verbunden:** Was passiert wenn User Server URL in Settings ändert? Braucht es einen Reconnect?

---

## 3. Dead Code

- [ ] Suche nach unreferenced exports, unused imports, toten Funktionen
- [ ] Suche nach Dateien die nicht mehr importiert werden
- [ ] Prüfe ob `SyncMode` export aus `sync-engine.ts` noch sinnvoll ist (war vorher in `onboarding-modal.ts`)
- [ ] Prüfe ob die `FileWatcherV2` Klasse noch den richtigen Namen hat (gibt es ein V1?)
- [ ] CHANGELOG.md — referenziert noch "Onboarding modal" — sollte für v0.2.14 aktualisiert werden?

---

## 4. Claude-Code-First Patterns

Prüfe ob der Code den Prinzipien folgt (aus MEMORY.md `feedback_code_style.md`):

- [ ] **Ausgewogene Dateigröße:** Keine Datei über ~400 Zeilen, keine mit nur 10 Zeilen
- [ ] **Keine Magie:** Alle Flows lesbar ohne implizites Wissen
- [ ] **Klare Strukturen:** Jede Datei hat eine klare Verantwortung
- [ ] **Kommentare:** Nur wo nötig, erklären "warum" nicht "was"
- [ ] **Error Handling:** Fehler werden dem User gezeigt (Notices), nicht nur geloggt

---

## 5. Sicherheit

- [ ] Passwörter in `data.json` liegen im Klartext — ist das akzeptabel? (Obsidian-Standard, nicht vermeidbar)
- [ ] Server URL: wird irgendwo `http://` zu `https://` erzwungen? Sollte es?
- [ ] `requestUrl` Error-Handling: Kann der Error-Body Secrets leaken? (z.B. wird die URL mit Token im Error-Log gedruckt?)
- [ ] WebSocket-URL enthält JWT als Query-Parameter — ist das in Server-Logs sichtbar?

---

## 6. Server-spezifisch

- [ ] `registration_key` ist jetzt optional im Request-Body — Server-Code handelt fehlenden Wert korrekt?
- [ ] Server Error-Messages: Sind sie konsistent und hilfreich?
- [ ] Gibt es Server-seitig Dead Code durch die Plugin-Änderungen?
- [ ] Vault-Name-Validierung: Plugin prüft `[a-z0-9][a-z0-9_-]*`, Server hat KEINE Validierung — ist das ein Risiko?

---

## Repositories

| Repo | Pfad |
|---|---|
| Plugin | `/home/richard/projects/vaultcrdt-plugin` |
| Server | `/home/richard/projects/vaultcrdt-server` |

## Vorgehen

1. Plugin-Code Datei für Datei durchgehen (src/*.ts)
2. Server-Code Datei für Datei durchgehen (src/*.rs)
3. Issues als Liste sammeln
4. Fixes durchführen
5. Tests laufen lassen
6. Commit + Push
