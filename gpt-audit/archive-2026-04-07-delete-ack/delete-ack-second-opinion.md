# Delete-Ack Hardening — Zweitmeinung

Status: Empfehlung vor Implementation
Datum: 2026-04-07
Bezug: `gpt-audit/delete-ack-plan.md`

## Kurzurteil

Die Grundentscheidung ist aus meiner Sicht richtig:

- **Option B (`doc_list`-Reconcile, keine Protokolländerung)** ist hier der beste Default.
- **Option A (explizites `DocDeleteAck`)** ist im aktuellen System kein echter Qualitätsgewinn, solange der Reconcile-Pfad sowieso als Safety-Net existieren muss.
- Das Delete-Journal sollte semantisch wirklich als **Intent-Liste** behandelt werden und **nicht** mehr beim bloßen `send()`-Erfolg geleert werden.

Kurz: **Richtung stimmt. Plan kann umgesetzt werden.**

Ich würde vor der Implementation aber noch ein paar Punkte nachschärfen.

## Was ich am Plan bestätigen würde

### 1. Architektur

Die vorgeschlagene Semantik passt gut zur bestehenden Architektur:

- Server bleibt dünn.
- `doc_list` bleibt die beobachtbare Wahrheitsquelle.
- Deletes sind bereits idempotent genug für Resends.
- Der Reconnect-Pfad ist schon heute der Ort, an dem Client-Intent gegen Server-Realität abgeglichen wird.

Das ist konsistenter als ein zusätzlicher spezieller Ack-Frame nur für Deletes.

### 2. Warum A kein Muss ist

Das Kernargument gegen Option A ist tragfähig:

- Selbst mit `DocDeleteAck` brauchst du **trotzdem** einen Reconcile-Fallback.
- Damit entstehen zwei Clearing-Pfade für denselben Journal-Eintrag.
- Der einzige echte Gewinn von A wäre vor allem **früheres Aufräumen innerhalb derselben Session**, nicht bessere Korrektheit.

Für das aktuelle Projekt ist das zu wenig, um die zusätzliche Protokollfläche zu rechtfertigen.

### 3. Trigger-Punkt

Der vorgeschlagene Ort ist richtig:

- `resendPendingDeletes()`
- dann `requestDocList()`
- dann `reconcilePendingDeletes()`
- downstream weiter mit dem **Snapshot vor dem Reconcile** filtern

Das ist lokal, verständlich und hält die Diffs klein.

## Was ich vor der Implementation ändern würde

### 1. Plan korrigieren: Tombstone-GC existiert bereits

Im Plan steht sinngemäß, der Server habe aktuell keinen Tombstone-GC. Das stimmt nicht mehr.

Im Server läuft bereits ein stündlicher Cleanup-Task, und `expire_tombstones()` wird mit Default **90 Tagen** aufgerufen (`vaultcrdt-server/src/main.rs`).

Konsequenz:

- Der Branch **"neither tombstoned nor active"** ist nicht nur ein hypothetischer Zukunftsfall.
- Er ist schon heute eine reale und korrekte Kategorie.
- Dafür sollte es auch mindestens **einen expliziten Test** geben.

Ich würde die Plan-Formulierung anpassen von "falls später GC kommt" zu "wegen bestehender Tombstone-Expiry".

### 2. Nicht in `CLAUDE.md` ziehen

Der Plan schlägt vor, die neue Delete-Journal-Invariante in `CLAUDE.md` zu ergänzen.

Das würde ich **nicht** tun.

Die Repo-Regeln für `gpt-audit/` sagen ausdrücklich, dass Audit-Details nicht in `CLAUDE.md` oder `next-session-handoff.md` gezogen werden sollen. Für diese Invariante sind bessere Orte:

- ein klarer Kommentar direkt in `src/push-handler.ts`
- optional ein kleiner Zusatz in `.claude/rules/plugin-src.md`
- `next-session-handoff.md` nur mit **Status**, nicht mit Detail-Rationale

### 3. `reconcilePendingDeletes()` klarer formulieren

Inhaltlich ist die Methode richtig. Ich würde sie aber minimal klarer bauen:

- nicht während der Iteration aus `this.pendingDeletes` löschen
- stattdessen ein neues `Set` aufbauen und am Ende ersetzen

Das ist lesbarer und vermeidet "mutation while iterating" als Denkballast.

Skizze:

```ts
const nextPending = new Set<string>();

for (const path of this.pendingDeletes) {
  if (tombstoneSet.has(path)) {
    confirmed.push(path);
  } else if (activeSet.has(path)) {
    stillPending.push(path);
    nextPending.add(path);
  } else {
    unknown.push(path);
  }
}

this.pendingDeletes = nextPending;
```

Funktional kein Muss, aber stilistisch besser.

## Antworten auf die offenen Fragen im Plan

### 1. Zielordner für diese Dokumente

Solange das Thema noch offen ist, sind `gpt-audit/delete-ack-plan.md` und diese Zweitmeinung im Top-Level tolerierbar.

**Nach Entscheidung oder Umsetzung** würde ich beide aber in
`gpt-audit/archive-2026-04-07/`
ablegen oder den Plan nach Merge löschen, damit `gpt-audit/` oben wieder klein bleibt.

Wenn das als Post-Audit-Follow-up aus Zyklus 2 verstanden wird, ist `archive-2026-04-07/` der natürlichste Zielort.

### 2. Reconcile-Trigger-Punkt

**Ja, genau nach `requestDocList()` in `runInitialSync()` ist richtig.**

Nicht früher abstrahieren. Kein eigener neuer Start-Block nötig. Die vorgeschlagene lokale Änderung reicht.

### 3. Log-Level für "still pending"

Ich würde es so halten:

- **`warn`** für `stillPending`
- **`log`** für `confirmed` und `unknown`

Begründung: Wenn `doc_list` auf derselben Connection nach dem Resend zurückkommt und der Pfad immer noch aktiv ist, ist das zumindest auffällig genug für `warn`.

### 4. `hasPendingDelete(path)` breiter verwenden?

**Nein, aktuell nicht nötig.**

Für jetzt reicht es, dass `runInitialSync()` der zentrale Schutz gegen Re-Download / Re-Adoption ist. Die Online-Pipeline würde ich nicht prophylaktisch weiter verflechten.

### 5. Delete während `runInitialSync`

Deine Einschätzung passt:

- kein Datenverlust
- neuer Eintrag bleibt bis zum nächsten Reconnect im Journal
- für jetzt akzeptabel

Das würde ich dokumentieren, aber **nicht** extra verkomplizieren.

## Race-Vollständigkeit

Ich sehe keinen zweiten gleichwertigen Korrektheits-Gap neben dem bereits benannten Fenster:

- **send erfolgreich, Server-Commit nicht sicher beobachtet, WS stirbt**

Mit Option B schließt du genau dieses Loch sauber.

Der Fall **"still active trotz Resend + `requestDocList` auf derselben Connection"** sollte unter den aktuellen Annahmen praktisch nicht normal auftreten.

Wenn er doch auftritt, deutet das eher auf einen dieser Punkte hin:

- Reconnect-/Promise-Bug auf Client-Seite
- unerwartete Message-Reihenfolge
- serverseitige Ordnungsannahme verletzt
- oder ein echter neuer Race, der gesondert untersucht werden muss

Gerade deshalb ist `warn` dort vertretbar.

## Test-Empfehlung

Die vorgeschlagenen Tests sind fast richtig, aber ich würde sie leicht zuschneiden.

### Pflicht

1. **Online delete keeps journal until reconcile**
   - `onFileDeleted()` bei offener WS
   - `doc_delete` wird gesendet
   - Journal bleibt trotzdem gesetzt

2. **Reconnect order is resend first, then `request_doc_list`**
   - explizit Reihenfolge prüfen

3. **Reconcile clears on tombstone**
   - `tombstoneSet` enthält Pfad
   - Eintrag verschwindet

4. **Reconcile keeps active path pending**
   - `activeSet` enthält Pfad
   - Eintrag bleibt
   - Downstream lädt den Pfad in derselben Initial-Sync-Runde nicht herunter

5. **Reconcile clears on neither**
   - wegen real existierender Tombstone-Expiry wichtig
   - nicht nur als theoretischer Future-Test behandeln

### Optional, falls stabil testbar

6. **Langer Zwei-Reconnect-Regressionstest**
   - delete online
   - erster Reconnect sieht Pfad noch aktiv
   - zweiter Reconnect sieht Tombstone
   - Journal wird erst dann leer

Den würde ich nur behalten, wenn er in der bestehenden Testumgebung nicht brittle wird. Die fünf fokussierten Tests oben tragen den Kern schon gut.

## Bottom line

Mein Votum wäre:

- **Option B beibehalten**
- **keine Server-/Protokolländerung**
- vor Implementation drei Korrekturen einziehen:
  1. Tombstone-GC im Plan korrekt berücksichtigen
  2. Delete-Invariante nicht in `CLAUDE.md`, sondern im Code / Rule-Kontext dokumentieren
  3. Testset um den realen `neither`-Fall ergänzen

Danach ist das eine saubere, kleine und architektonisch passende Härtung.

## Prompt-Vorschlag für Claude Code

```text
Lies bitte zuerst:
- gpt-audit/delete-ack-plan.md
- gpt-audit/delete-ack-second-opinion.md

Aufgabe:
1. Prüfe die Zweitmeinung gegen den Plan und ziehe die sinnvollen Korrekturen ein, bevor du implementierst.
2. Halte an Option B fest: plugin-only, keine Protokoll- und keine Server-Änderung, solange du keinen harten Gegenbeleg findest.
3. Korrigiere im Plan bzw. in der Umsetzung explizit diese Punkte:
   - Server hat bereits Tombstone-Expiry (Default 90 Tage) -> der "neither"-Branch ist ein realer Fall und soll in Logik + Tests als solcher behandelt werden.
   - Die Delete-Journal-Invariante nicht in CLAUDE.md ziehen; stattdessen im Code und bei Bedarf in .claude/rules/plugin-src.md dokumentieren. next-session-handoff.md nur mit Status updaten.
   - reconcilePendingDeletes moeglichst klar implementieren; bevorzugt ueber ein neues Set statt Loeschen waehrend der Iteration.
4. Setze danach die Option-B-Aenderungen in src/push-handler.ts und src/sync-initial.ts um.
5. Passe die Tests an. Pflichtfaelle:
   - online delete behaelt Journal-Eintrag bis Reconcile
   - resend vor request_doc_list
   - tombstone -> clear
   - active -> bleibt pending und wird in derselben Initial-Sync-Runde nicht heruntergeladen
   - neither -> clear
6. Fuehre danach die passenden Checks aus:
   - bun run test
   - bun run build
   - verify_plugin mit skipWasm=true, falls keine crates/-Aenderung erfolgt ist

Bitte zuerst kurz sagen, welche Teile aus der Zweitmeinung du uebernimmst und ob du irgendwo widersprichst. Danach implementieren.
```