# Delete-Ack Hardening — Plan

Status: **Entwurf, wartet auf GPT-Zweitmeinung**
Datum: 2026-04-07 (Post-Zyklus-2-Follow-up)
Scope: Plugin (`vaultcrdt-plugin`) + optional Server (`vaultcrdt-server`)

## 1. Problem

Nach Zyklus 2 (`gpt-audit/archive-2026-04-07/`) ist das Delete-Journal **send-basiert**, nicht **ack-basiert**. Konkret:

- `src/push-handler.ts:50-54` — `onFileDeleted()` fügt den Pfad zum Journal hinzu, sendet `doc_delete`, und entfernt den Pfad **direkt nach `send()`**.
- `src/push-handler.ts:139-147` — `flushPendingDeletes()` leert das Journal unmittelbar nach der Send-Schleife.

Race-Fenster:

1. Nutzer löscht `foo.md` online.
2. Plugin schreibt Journal-Eintrag, ruft `this.send({ type: 'doc_delete', doc_uuid: 'foo.md' })` auf.
3. WS stirbt **bevor** der Server die Delete-Transaction (unter `DocLocks`, siehe Zyklus 2) committed hat. Das passiert z.B. bei Netzwerk-Hiccup, Server-Restart, Mobile-Background-Kill.
4. Plugin hat `foo.md` bereits aus dem Journal entfernt.
5. Reconnect. `runInitialSync` ruft `requestDocList`, der Server hat `foo.md` noch in `documents`, kein Tombstone.
6. `foo.md` landet in `serverOnlyUuids`, wird heruntergeladen, Datei wieder da.

Das ist der letzte Rest-Gap, den GPT in seinem Post-Zyklus-2-Review benannt hat.

## 2. Was **nicht** das Problem ist

- **Der reine Offline-Fall** (Delete ohne offene WS) ist durch Zyklus 2 bereits korrekt: Journal persistiert, beim Reconnect wird vor `requestDocList` geflushed (WS-FIFO garantiert, dass der Server den Delete vor der Listing-Antwort verarbeitet).
- **Der Tombstone-Guard gegen Resurrection aus Zyklus 1** greift — sobald der Server einmal den Tombstone hat, bleibt er (siehe `vaultcrdt-server/src/db.rs:231-277`, `remove_tombstone` wird von keinem Handler aufgerufen).
- **Serialisierung mit Push/Create** ist durch Zyklus 2 erledigt (`handlers.rs:81-97`, alle drei Operationen unter demselben `DocLocks`-Guard).

Der einzig verbleibende Fall ist „Send erfolgt, Server-Commit nicht (oder nicht beobachtet) bevor WS stirbt".

## 3. Architektonische Leitplanken

Die Lösung muss zum Gesamtansatz passen:

- **Protokoll klein halten.** Je weniger Client/Server einigen müssen, desto weniger kann driften.
- **Server ist dünner Relay + Tombstone-Store**, keine Per-Message-Ack-Buchhaltung zusätzlich zum bereits existierenden generischen `Ack`.
- **Reconnect-Reconciliation ist bereits etabliertes Muster** (Zyklus 1 hat `doc_list` + `tombstones` zur Wahrheitsquelle beim Startup gemacht, Zyklus 2 hat das auf den Reconnect-Pfad verlängert).
- **Idempotenz bevorzugen vor expliziten Acks** — Operationen, die idempotent sind, brauchen keine Pro-Operation-Bestätigung; der Client kann sie bei Unklarheit einfach wiederholen.
- **Single user, kein Backwards-Compat** — eine Protokolländerung wäre billig, falls sie wirklich nötig ist. „Billig" ist aber nicht dasselbe wie „besser".
- **LLM-freundlich**: explizite Strukturen, keine Magie, balancierte Dateigrößen.

## 4. Empfehlung: Option B — Reconcile via `doc_list`

**Kurz:** Das Delete-Journal wird zur dauerhaften „I want these paths to be dead on the server"-Intent-Liste. Einträge werden **nur dann** entfernt, wenn der Client über `request_doc_list` beobachtet hat, dass der Server den Pfad als tombstoned (oder gar nicht mehr bekannt) meldet.

### Warum dies die beste Option ist

1. **Keine Protokolländerung.** Die bestehenden Messages (`DocDelete`, `RequestDocList` mit `{ docs, tombstones }`) reichen aus.
2. **Single source of truth:** die Tombstone-Tabelle des Servers, beobachtet über den bereits existierenden `doc_list`-Kanal. Wir fügen keinen zweiten Observabilitäts-Pfad hinzu.
3. **Idempotenz ist bereits gegeben.** `delete_doc` ist `DELETE WHERE …` (no-op bei fehlender Zeile), `tombstone` ist `INSERT … ON CONFLICT … DO UPDATE` (Upsert). Resends sind unkritisch.
4. **Generalisiert über Deletes hinaus.** Reconnect-Reconciliation über Server-State ist das allgemeine Muster — dieselbe Denkweise kann später auf Create/Push-Intents angewandt werden, falls nötig.
5. **Tests bleiben im bestehenden Rahmen.** Keine neue Message-Variante muss simuliert werden, nur der bereits getestete `doc_list`-Pfad wird erweitert.
6. **Falsifizierbar zur Laufzeit.** Wenn das Journal nach einem Reconnect noch Pfade enthält, die `doc_list` als tombstoned meldet, ist der Reconciler kaputt — das ist klar diagnostizierbar.

### Neue Flow-Semantik

#### `push-handler.ts`

```ts
onFileDeleted(path: string): void {
  void this.docs.removeAndClean(path);
  this.lastServerVV.delete(path);
  this.pendingDeletes.add(path);
  if (this.isWsOpen()) {
    this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
    // NICHT mehr: this.pendingDeletes.delete(path)
    // Eintrag bleibt im Journal, bis der naechste Reconcile ihn bestaetigt entfernt.
  }
  void this.persistJournal();
}
```

```ts
/**
 * Resend all pending deletes. Does NOT clear the journal — clearing is done
 * after reconciliation against the server's tombstone list.
 */
resendPendingDeletes(): void {
  if (this.pendingDeletes.size === 0) return;
  for (const path of this.pendingDeletes) {
    log(`${this.tag} resending pending delete`, { path });
    this.send({ type: 'doc_delete', doc_uuid: path, peer_id: this.settings.peerId });
  }
}

/**
 * Remove journal entries whose delete has been confirmed by the server.
 * Called after request_doc_list returns during runInitialSync.
 *
 * - tombstoneSet: paths the server reports as tombstoned → confirmed, remove.
 * - activeSet:    paths still present in the server doc list → delete was
 *                 not (yet) processed; keep the journal entry so a future
 *                 reconnect will retry.
 * - neither:      path is gone entirely (tombstone GC, or never existed).
 *                 Safe to remove — no harm done, and we avoid an entry
 *                 that would never be resolved.
 */
async reconcilePendingDeletes(
  tombstoneSet: ReadonlySet<string>,
  activeSet: ReadonlySet<string>,
): Promise<void> {
  if (this.pendingDeletes.size === 0) return;
  const stillPending: string[] = [];
  const confirmed: string[] = [];
  const unknown: string[] = [];
  for (const path of this.pendingDeletes) {
    if (tombstoneSet.has(path)) {
      confirmed.push(path);
      this.pendingDeletes.delete(path);
    } else if (activeSet.has(path)) {
      stillPending.push(path);
    } else {
      unknown.push(path);
      this.pendingDeletes.delete(path);
    }
  }
  if (confirmed.length || stillPending.length || unknown.length) {
    log(`${this.tag} delete reconcile`, {
      confirmed: confirmed.length,
      stillPending: stillPending.length,
      unknown: unknown.length,
    });
  }
  if (stillPending.length > 0) {
    warn(`${this.tag} deletes not yet landed on server — will retry on next reconnect`, {
      paths: stillPending,
    });
  }
  await this.persistJournal();
}
```

Die alte `flushPendingDeletes()`-Methode wird komplett durch `resendPendingDeletes()` ersetzt; sie hat denselben Send-Code, löscht aber das Journal nicht mehr.

#### `sync-initial.ts` — umgebender Reconcile-Block

```ts
// Snapshot der aktuellen Intent-Liste BEVOR wir irgendwas tun. Downstream
// filtert gegen diesen Snapshot, damit wir selbst dann nicht re-downloaden,
// wenn der Reconcile gleich Eintraege entfernt (Belt-and-suspenders).
const pendingDeleteSnapshot = new Set(push.pendingDeletePaths());

// Alle Pending-Deletes nochmal feuern. Idempotent, keine Journal-Aenderung.
push.resendPendingDeletes();

const { docs: serverDocs, tombstones } = await deps.requestDocList();
const tombstoneSet = new Set(tombstones);
const serverDocMap = new Map<string, DocEntry>();
for (const d of serverDocs) serverDocMap.set(d.doc_uuid, d);
const serverUuidSet = new Set(serverDocMap.keys());

// Reconcile: confirmed tombstones raus, still-active bleiben drin.
// Weil WS FIFO per Connection ist, reflektiert das doc_list hier bereits
// den Zustand nach unseren eben gesendeten Deletes. D.h. im Normalfall
// ist "still-active" leer.
await push.reconcilePendingDeletes(tombstoneSet, serverUuidSet);

// Die Downstream-Filterung (serverOnlyUuids, overlappingFiles, localOnlyFiles)
// benutzt weiterhin pendingDeleteSnapshot, NICHT das moeglicherweise frisch
// reconcilete Journal. So bleibt die Filterlogik stabil und unabhaengig vom
// Reconcile-Ergebnis.
```

#### Minimaler Code-Change in `runInitialSync`

Die Änderung ist lokal auf die Zeilen 60-66 und die nachfolgenden Set-Deklarationen beschränkt. Keine weitreichende Umstrukturierung.

### Verhalten während einer langen Online-Session

Mit dieser Änderung wächst das Journal während einer langen ununterbrochenen Session, weil es erst beim nächsten Reconnect geleert wird. Quantitativ:

- Typischer Home-Nutzer: 0–10 Deletes pro Tag.
- Reconnect-Frequenz: mindestens einmal pro App-Restart, in der Praxis mehrfach pro Tag (Obsidian-Pause, Mobile-Background, Netzwerk-Wechsel).
- Journal-Größe in Bytes: Pfadname × Anzahl Einträge, also kleiner als 100 KB selbst im Extremfall.

Das ist **akzeptabel**. Wenn es später doch ein Problem wird, kann eine opportunistische Periodic-Reconcile-Routine nachgezogen werden (alle N Minuten ein `request_doc_list` → `reconcilePendingDeletes()`), ohne dass sich die Datenstrukturen ändern.

### Was sich NICHT ändert

- `doc_list` Protokoll.
- `DocDelete`-Handler serverseitig.
- Tombstone-Retention-Policy.
- Der bestehende `isSyncablePath()`-Filter und die Pfad-Policy.
- Die Zyklus-2-Rename-Transition-Logik in `main.ts`.
- Die bereits vorhandenen Filter `!tombstoneSet.has(…)` + `!pendingDeleteSet.has(…)` downstream.

## 5. Alternativen

### Option A — Explizite Per-Path-Ack-Message

**Idee:** Neue Server→Client-Message `DocDeleteAck { doc_uuid }`, emitted nach erfolgreichem `db::delete_doc` + `db::tombstone` unter `DocLocks`. Plugin entfernt den Journal-Eintrag erst bei Empfang der Ack.

**Implementation:**

- `vaultcrdt-server/src/ws.rs` (`ServerMsg` enum): neue Variante `DocDeleteAck { doc_uuid: String }`.
- `vaultcrdt-server/src/handlers.rs` (`DocDelete`-Arm): statt `Ok((msg::ServerMsg::Ack, …))` → `Ok((msg::ServerMsg::DocDeleteAck { doc_uuid: doc_uuid.clone() }, …))`.
- `vaultcrdt-plugin/src/sync-engine.ts` (`onMessage`): neuer `case 'doc_delete_ack'` → `this.push.confirmDelete(msg.doc_uuid)`.
- `push-handler.ts`: neue Methode `confirmDelete(path)` entfernt aus `pendingDeletes`, persistiert Journal.
- Reconcile-Fallback via `doc_list` trotzdem zusätzlich einbauen, weil die Ack auch verloren gehen kann (WS stirbt zwischen Server-Commit und Ack-Zustellung).

**Pro:**

- Journal bleibt während der Session klein.
- Explizites Modell, klares „wann darf ich löschen": „wenn Server explizit bestätigt hat".
- Keine Vermischung mit der generischen `Ack`-Semantik.

**Contra:**

- **Zwei Protokoll-Wege** (explicit ack + reconcile-as-safety-net) — mehr Oberfläche, zwei Code-Pfade zum Clearing, mehr Tests.
- Der Reconcile-Pfad muss trotzdem existieren, weil auch die Ack-Zustellung fehlschlagen kann. Die Ack ist also „nice-to-have-Optimierung", nicht Notwendigkeit.
- Eine neue Server-Message-Variante ist nicht free: Serde-Derivation, Integrations-Test, Client-Handler-Case, Doku-Nachziehen.
- Verleitet zu Denkfehler „wenn Ack kommt, bin ich sicher" — die Ack bestätigt Server-Commit, aber nicht, dass das Plugin die Ack-Nachricht auch lokal verarbeitet hat bevor es stirbt. Der Reconcile bleibt die ehrliche Wahrheitsquelle.

**Wann wäre A trotzdem besser?** Wenn es spätere Message-Typen gibt, die **nicht idempotent** sind und wo Resend wirklich schadet — dann braucht man echte Per-Message-Acks. Für Deletes trifft das nicht zu.

### Option C — Hybrid: Ack als Fast-Path + Reconcile als Safety-Net

Kombination aus A und B: Explizite Ack räumt das Journal proaktiv auf, Reconcile räumt auf was durchgerutscht ist.

**Pro:** Schlankes Journal UND Sicherheit.

**Contra:** Doppelte Code-Pfade für denselben Effekt. Mehr Komplexität ohne qualitativ bessere Garantien.

**Urteil:** Lohnt sich nur, wenn Option B messbar nicht skaliert. Aktuell reine Over-Engineering-Falle.

### Option D — `DocDeleted`-Broadcast auch an den Sender schicken

**Idee:** In `vaultcrdt-server/src/ws.rs` Zeile 267 den Filter `sender_conn_id != conn_id` für den `Delete`-Broadcast entfernen oder umgehen. Der Sender erhält dann auch den `DocDeleted`-Broadcast und kann sein Journal darüber leeren (das `doc_deleted` case in `sync-engine.ts:282` existiert bereits).

**Pro:**

- Keine neue Message-Variante.
- Nutzt bereits existierenden Code-Pfad.

**Contra:**

- `onDocDeleted()` (`sync-engine.ts:423`) ruft `vault.trash(f, true)` auf. Beim eigenen Sender ist die Datei bereits weg → `getAbstractFileByPath` liefert `null`, der `trash`-Call läuft nicht. Das ist okay, aber es ist **indirekter Code-Flow**: „ich bekomme die Bestätigung für etwas, das ich selbst ausgelöst habe". Das macht den State-Machine-Diagramm unübersichtlich.
- Der Broadcast ist aktuell semantisch klar „Info an andere Peers". Diese Semantik aufzuweichen trübt die Trennung.
- Reconcile-Pfad bleibt trotzdem nötig als Safety-Net (aus denselben Gründen wie bei Option A).

**Urteil:** Hacky. Kein echter Gewinn gegenüber Option B.

## 6. Vergleichsmatrix

| Kriterium | B (reconcile) | A (explicit ack) | C (hybrid) | D (self-broadcast) |
|---|---|---|---|---|
| Protokolländerung | keine | +1 Frame | +1 Frame | Filter-Änderung |
| Code-Pfade zum Clearing | 1 | 2 | 2 | 2 |
| Journal-Bloat bei langer Session | wächst | klein | klein | klein |
| Server-Side-Änderung | keine | ja | ja | ja |
| Neue Tests | ~3 | ~5 | ~5 | ~3 |
| Generalisiert auf andere Intents | ja | nein | nein | nein |
| Risiko „falsches Sicherheitsgefühl" | niedrig | mittel | mittel | mittel |
| Aufwand | klein | mittel | mittel | klein |
| Fit zum 2026+-Architekturansatz | hoch | mittel | niedrig | niedrig |

## 7. Implementation-Plan für Option B

### Phase 1 — Plugin-side (alle Änderungen in `vaultcrdt-plugin`)

1. **`src/push-handler.ts`**
   - `onFileDeleted`: `this.pendingDeletes.delete(path)` nach dem Send entfernen. Journal bleibt populated.
   - `flushPendingDeletes` → `resendPendingDeletes` umbenennen. `this.pendingDeletes.clear()` entfernen.
   - Neue Methode `reconcilePendingDeletes(tombstoneSet, activeSet)` wie oben skizziert.
   - JSDoc aktualisieren (das Kommentar bei `onFileDeleted` erklärt aktuell explizit die alte Semantik, das muss weg).

2. **`src/sync-initial.ts`**
   - `push.flushPendingDeletes()` → `push.resendPendingDeletes()`.
   - Nach `requestDocList()`-Antwort, `serverUuidSet` aus `serverDocMap.keys()` bauen, `push.reconcilePendingDeletes(tombstoneSet, serverUuidSet)` aufrufen.
   - `pendingDeleteSet`-Snapshot-Variable kann bleiben (heißt dann z.B. `pendingDeleteSnapshot`), wird weiter downstream zum Filtern benutzt. Kommentar anpassen.

3. **`src/__tests__/sync-engine-edge.test.ts` + ggf. `sync-engine.test.ts`**
   - Bestehender Test „offline delete writes path to the delete-journal file" (`sync-engine-edge.test.ts:382`) überprüfen und anpassen — die Assertion, dass das Journal nach einem erfolgreichen Online-Delete geleert wird, ist bald falsch.
   - **Neu: „Online delete keeps entry in journal until reconcile confirms"** — simulieren: onFileDeleted → `hasPendingDelete(path) === true` auch nach Send.
   - **Neu: „Reconcile clears entry when path is in tombstoneSet"** — reconcilePendingDeletes mit tombstoneSet={foo.md}, activeSet=∅ → Journal leer.
   - **Neu: „Reconcile keeps entry when path is still active on server"** — reconcilePendingDeletes mit tombstoneSet=∅, activeSet={foo.md} → Journal unverändert, Warning geloggt.
   - **Neu: „Full reconnect round-trip: delete online → WS drops before server commit → reconnect → path in serverOnlyUuids → not downloaded because of pendingDeleteSnapshot → resend → server now tombstones → next reconcile clears"** (das ist das Haupt-Integrations-Szenario).

4. **`src/__tests__/sync-initial-flow.test.ts`** (oder welche Testdatei auch immer den initialSync-Flow abdeckt)
   - Assert: `requestDocList` wird NACH `resendPendingDeletes` aufgerufen (Reihenfolge wichtig wegen FIFO).
   - Assert: `reconcilePendingDeletes` wird mit den richtigen Sets aufgerufen.

### Phase 2 — Kein Server-Change nötig

Explizit festhalten: **Option B berührt den Server nicht.** Das ist ein bewusster Teil der Empfehlung. Kein `cargo`-Rebuild, kein WASM-Rebuild, keine Server-Deploy-Runde.

### Phase 3 — Docs

- `CLAUDE.md`: eine Zeile im „Invariants"-Block oder in einem neuen „Delete-Semantik"-Unterabschnitt: „Delete-Journal wird ausschließlich via `reconcilePendingDeletes` geleert, niemals direkt im Send-Pfad".
- `gpt-audit/previous-cycles.md`: keine Änderung (der Delete-Ack-Punkt ist bereits als Pre-Community-Release-Item vermerkt; sobald dieser Plan implementiert ist, wird er dort abgehakt).
- `next-session-handoff.md`: aktualisieren mit dem Implementation-Status.
- Dieses Plan-Dokument selbst kann nach erfolgreicher Implementation ins nächste `archive-<datum>/` wandern oder schlicht gelöscht werden.

### Phase 4 — Invariante dokumentieren

Neuer Kommentar-Block am Kopf von `push-handler.ts` oder als kleiner Abschnitt in `.claude/rules/plugin-src.md`:

```
Delete-Journal-Invariante:

- Ein Journal-Eintrag wird nur HINZUGEFUEGT beim lokalen Delete.
- Ein Journal-Eintrag wird nur ENTFERNT, wenn runInitialSync ueber
  requestDocList bestaetigt hat, dass der Server den Pfad als
  tombstoned kennt (oder ueberhaupt nicht kennt).
- Der reine send()-Erfolg ist KEINE Bestaetigung.
- Das Journal darf waehrend einer Session wachsen; es wird beim
  naechsten Reconnect-Reconcile geschrumpft.
```

## 8. Risiken und offene Fragen

### Risiken

1. **Reconcile-Interaktion mit dem VV-Cache**: `sync-initial.ts` baut Zeile 276 `validPaths` aus `localPathSet` + `serverDocMap.keys()` und ruft `docs.cleanOrphans(validPaths)`. Ein Pfad, der noch im Journal steht aber bereits aus `serverDocMap` verschwunden ist (weil wir ihn erfolgreich deleted haben), sollte korrekt als orphan betrachtet werden. Muss geprüft werden, dass der Orphan-Cleanup keine legitimen In-Flight-Deletes trifft.

2. **Test-Setup-Overhead**: Die Integrations-Tests, die das Full-Round-Trip-Szenario simulieren, brauchen einen Mock für `requestDocList`, der zwei verschiedene Antworten nacheinander liefert (erst „noch aktiv", dann „tombstoned"). Das ist in den bestehenden Vitest-Suites machbar, aber nicht-trivial.

3. **Seltener Randfall: Server-Tombstone-GC**. Aktuell hat der Server keinen Tombstone-GC. Wenn später einer eingeführt wird, kann ein Journal-Eintrag durch den Reconcile in die „neither"-Kategorie fallen (nicht tombstoned, nicht active) — der Code behandelt das bereits (entfernt mit Warnung), aber es wäre gut, das Szenario bei GC-Einführung nochmal explizit zu testen.

4. **WS-Reconnect-Loop unter Last**: Wenn bei einer wackligen Verbindung der Reconnect-Loop alle paar Sekunden neu feuert, wird das Journal bei jedem Versuch komplett resent. Bei großem Journal (hunderte Deletes) ist das viele kleine Messages. Mitigation: akzeptabel, weil (a) idempotent und (b) Delete-Bursts dieser Größe sind in Solo-Home-Use unrealistisch. Falls es doch relevant wird: Batch-Delete-Frame einführen.

### Offene Fragen für die Zweitmeinung

1. **Zielordner für dieses Dokument:** `gpt-audit/` ist jetzt der Ablageort. Soll es nach Implementation in `archive-2026-04-07/` einsortiert werden (als Post-Audit-Plan), oder ins nächste Cycle-Archiv? Oder schlicht gelöscht werden nach Merge?

2. **Reconcile-Trigger-Punkt:** Aktuell vorgeschlagen: exakt einmal im `runInitialSync`, nach `requestDocList()`. Alternative: eigene Phase am Anfang (vor den Overlapping-/Server-Only-Schritten). Erster Vorschlag ist näher am bestehenden Code und minimiert Diffs.

3. **Ist die „Warnung bei still-pending"-Logstufe richtig?** Ich habe `warn` gewählt, weil es im Normalbetrieb nicht auftreten sollte. `log` (info) wäre auch vertretbar. `error` wäre zu scharf, weil der Zustand recoverable ist (nächster Reconnect versucht es nochmal).

4. **Sollte `hasPendingDelete(path)` auch für die aktive Sync-Pipeline (nicht nur initialSync) benutzt werden?** Aktuell fragt die Pipeline an anderen Stellen nicht nach dem Journal. Das ist okay, solange alle „sollte ich diesen Pfad vom Server akzeptieren/überschreiben"-Entscheidungen durch `runInitialSync` laufen. Wenn in Zukunft ein Broadcast für einen Pfad kommt, den wir gerade löschen wollen, ist der aktuelle Code okay (weil wir die Datei lokal bereits weg haben).

5. **Delete während `runInitialSync` in Progress:** Der Code hält `queuedBroadcasts` für delta/deleted broadcasts. Was passiert, wenn der Nutzer **während** des initialSync-Runs lokal etwas löscht? `onFileDeleted` läuft out-of-band, fügt zum Journal hinzu, feuert `doc_delete` (oder nicht, je nach WS-Status). Der Reconcile wurde für den initialen Journal-Stand berechnet, nicht für diesen neuen Eintrag. Ergebnis: neuer Eintrag bleibt im Journal bis zum nächsten Reconnect. Kein Datenverlust, aber worth-noting.

## 9. Out-of-Scope (bleibt für später)

- **Tombstone-TTL / GC:** orthogonale Design-Frage, kein Zusammenhang mit der Ack-Semantik.
- **Re-Create nach Delete:** dass ein Pfad nach Delete permanent gesperrt ist, ist eine bewusste Entscheidung aus Zyklus 1 (Anti-Resurrection). Unabhängig von diesem Plan.
- **Per-Push-Ack-Hardening:** dasselbe Denkmodell könnte man auf Pushes/Creates anwenden, aber da ist der Schmerz kleiner (CRDTs sind selbst-heilend bei verlorenen Deltas, solange die VV gepflegt wird). Später prüfen.
- **Checklisten-Doc für Dogfooding** — separat, kommt nach diesem Plan.

## 10. Empfehlung an den Reviewer (GPT)

Bitte primär bewerten:

1. **Architektonische Richtigkeit:** Ist der „Journal bleibt populated bis Reconcile"-Ansatz konsistent mit dem bestehenden Tombstone/Reconnect-Modell?
2. **Race-Vollständigkeit:** Decke ich wirklich alle Delete-Race-Fenster ab, oder sehe ich ein drittes Fenster jenseits „send succeeded, commit didn't" nicht?
3. **Alternative-B-Kritik:** Ist mein Argument gegen Option A (explicit ack) robust, oder übersehe ich einen Fall, in dem der explicit ack qualitativ bessere Garantien gibt?
4. **Testbarkeit:** Sind die drei Haupt-Testszenarien (Phase 1, Punkt 3) ausreichend, oder fehlt ein weiteres?
5. **Randfall „noch-aktiv trotz FIFO":** Unter welchen Bedingungen könnte ein Pfad nach einem Resend-then-doc_list immer noch als aktiv erscheinen? Ich sehe keinen legitimen Grund innerhalb einer Connection. Crosse-Connection Race ist durch `DocLocks` serialisiert. Fehlt ein Szenario?
