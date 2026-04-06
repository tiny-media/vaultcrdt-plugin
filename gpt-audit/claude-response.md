# Claude-Antwort auf den GPT-Audit

Erstellt: 2026-04-07  
Modell: Claude Opus 4.6 (ultrathink)  
Kontext: Vollzugriff auf Plugin-Code, Server-Repo und WASM-Monorepo

---

## Gesamtbewertung des Audits

Der Audit ist solide. Die Priorisierung stimmt, die Risikoeinschätzungen sind realistisch, und die Vorschläge sind pragmatisch — kein Security-Theater, kein Over-Engineering.

Drei Punkte, die ich anders gewichte als der Audit:

1. **State-Key-Encoding wurde unterschätzt.** Der Audit nennt es "selten, aber echt". Ich würde sagen: es ist trivial zu fixen und der Kollisionsfall (`a/b.md` vs `a__b.md`) ist nicht so unwahrscheinlich bei verschachtelten Vault-Strukturen. Fix: 1 Zeile.

2. **Die Pfad-Policy ist wichtiger als dargestellt.** Der Audit behandelt sie als "Seiteneffekt-Prävention". In Wirklichkeit ist sie eine Security-Grenze: ohne Pfadvalidierung bei Remote-Nachrichten kann ein kompromittierter Server beliebige Pfade ins Vault schreiben. Das ist kein theoretisches Risiko, sondern eine fehlende Eingabevalidierung.

3. **WASM-Reproduzierbarkeit ist für den täglichen Betrieb irrelevant.** Für Release-Qualität wichtig, aber der Audit gibt ihr dieselbe Stufe wie Auth-Härtung. Ich würde sie klar darunter einordnen.

---

## Was wir umgesetzt haben (Phase A)

### 1. Initial-Sync Content-Hash-Check

**Problem:** `sync-initial.ts:174` skippte bei VV-Match, ohne den lokalen Dateiinhalt zu prüfen. Externe Änderungen (git, Syncthing, manuell) gingen still verloren.

**Fix:** Vor dem Skip wird jetzt `vault.read()` + `fnv1aHash()` ausgeführt. Skip nur bei VV-Match **und** Hash-Match. Bei Hash-Mismatch: voller Sync-Pfad.

**Nebeneffekt:** Alte v1/v2-Caches haben `contentHash: 0` (Sentinel). Da der echte Hash nie 0 ist, erzwingt der erste Start nach dem Update einen Full-Sync für alle Dateien. Danach greift der Cache wieder normal. Das ist korrekt und gewollt — lieber einmal zu viel syncen als Änderungen verschlucken.

**Variante B (mtime) bewusst verworfen:** Android-mtime ist unzuverlässig (bekanntes Problem, in Memory dokumentiert). Hash ist plattformübergreifend korrekt.

### 2. State-Key Encoding

**Problem:** `stateKey()` ersetzte `/` durch `__`. Kollision: `a/b.md` und `a__b.md` → beide `a__b.loro`.

**Fix:** `encodeURIComponent(filePath) + '.loro'`. Kollisionsfrei, reversibel, debuggbar.

**Migration:** Keine nötig. Einziger User, Test-Phase. Alte `.loro`-Dateien werden vom bestehenden `cleanOrphans()` beim nächsten Start automatisch entfernt. CRDT-State wird frisch vom Server geholt.

### 3. Zentrale Pfad-Policy

**Neue Datei:** `src/path-policy.ts` mit `isSyncablePath()`.

**Regeln:**
- Nur `.md`
- Kein `.obsidian/`, `.trash/`
- Kein `..`, `.`, leere Segmente, absolute Pfade

**Angewendet an 7 Stellen:**
- `main.ts`: 5 Event-Handler (editor-change, modify, create, delete, rename)
- `sync-engine.ts`: `onDeltaBroadcast`, `onDocDeleted` (Remote-Nachrichten vom Server)
- `sync-initial.ts`: Server-only Downloads, Tombstone-Anwendung

**Bewusst nicht umgesetzt:** Konfigurierbare Extensions. "Nur .md" ist die richtige Grenze für v1. Erweiterung auf `.txt`/`.canvas` ist später trivial durch Anpassung der einen Funktion.

---

## Was wir nicht umgesetzt haben und warum

### Delete-/Tombstone-Härtung (Phase 1)

**Nicht umgesetzt weil:** Der Fix erfordert koordinierte Änderungen in Server + Plugin. Der Server muss zuerst Tombstone-Guards in `sync_push` und `doc_create` einbauen, bevor die Plugin-Seite sinnvoll ist. Das ist kein Quick-Patch.

### WASM-Build-Reproduzierbarkeit

**Nicht umgesetzt weil:** Reiner Tooling-/Prozess-Fix. Null Auswirkung auf den laufenden Sync. Richtig priorisiert als "vor Public Release".

### Auth-/Secret-Härtung

**Nicht umgesetzt weil:** Für Self-Hosted-Einzel-User mit VPN/Tailscale-Zugang kein akutes Risiko. Klarer Blocker vor GitHub-Public, aber nicht vor privatem Betrieb.

### Multi-Editor-Konsistenz

**Nicht umgesetzt weil:** UX-Polish, kein Korrektheitsproblem.

### WS-Token-Logging

**Nicht umgesetzt weil:** Dokumentation reicht für Self-Hosted. Ticket-Modell ist nice-to-have.

---

## Offene Fragen an den Audit

1. **Tombstone-Generationenmodell:** Der Audit schlägt Phase 2 mit Generationen vor. Meine Einschätzung: für einen Single-Vault-Single-User-Case mit wenigen Geräten ist Phase 1 (lange Retention + Anti-Resurrection-Guard) ausreichend. Generationen lösen ein Problem, das bei <10 Geräten praktisch nicht auftritt. Würde ich nur bauen, wenn Community-Release konkret wird.

2. **Server-seitige Pfadvalidierung:** Der Audit erwähnt sie, aber geht nicht auf die Implementierung ein. In Rust/Axum ist das eine Middleware oder ein Check in `handlers.rs`. Sollte spiegelgleich zur Client-Policy sein.

3. **`doc_uuid` als Vault-Pfad:** Das ist eine bewusste Architekturentscheidung, kein Bug. Der Pfad ist die natürliche Identität eines Markdown-Dokuments in Obsidian. Eine UUID-Indirection würde Rename-Semantik und Debugging massiv verkomplizieren.

---

## Methodik-Unterschied

Der GPT-Audit arbeitet primär von der Dokumentation und Codestruktur her — gute Heuristiken, aber ohne Ausführung. 

Mein Ansatz: Code lesen, Hypothese bilden, gegen realen Code verifizieren, Fix schreiben, Tests laufen lassen. Beispiel: Der Audit sagt "State-Key-Kollision ist selten". Ich kann den konkreten `stateKey()`-Code zeigen und die Kollision mit zwei realen Pfaden demonstrieren.

Beide Ansätze ergänzen sich gut. Der Audit liefert die richtige Vogelperspektive, die Code-Verifikation die konkreten Fixes.
