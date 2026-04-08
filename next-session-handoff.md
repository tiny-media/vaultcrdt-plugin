# Session Handoff — Release v0.2.17 live, Dogfooding ansteht

Datum: 2026-04-08 (Ende der neunten Session)
Branch: `main`, sauber, **auf `origin/main`** gepusht.
Release: **`v0.2.17`** live auf GitHub (main.js + manifest.json als Assets).

## Status in einem Satz

Conflict-Storm-Haertung ist released und BRAT-ready — naechste Session ist
**Server-Repo analog umstellen**, **alte Vaults loeschen + frisch aufsetzen**,
**BRAT ziehen lassen** und **Dogfooding-Checkliste durchlaufen**.

## Was seit dem letzten Handoff passiert ist

Sieben Commits oben drauf, alle gepusht, beide Workflows gruen:

```
0f12339 chore(release): v0.2.17                                 ← triggert Release-Workflow
ca2cbd4 chore(docs): archive conflict-storm + delete-ack cycles, dogfooding v0.2.17
589e837 docs(rules): require tsc --noEmit before committing plugin/wasm changes
071360e fix(test): pass peerId to DocumentManager ctor in test setup
c49b098 docs(handoff): close conflict-storm follow-up cycle
f366dd8 fix(sync): stable peer-id, adopt-not-merge, and editor-first content reads
3276d16 chore: vendor coding-agent tooling, pin-aligned to wasm-bindgen 0.2.117
```

**Release `v0.2.17`:** https://github.com/tiny-media/vaultcrdt-plugin/releases/tag/v0.2.17

**Deploy-Workflow umgestellt (dauerhaft):** Plugin-Deploy laeuft jetzt ueber
GitHub Releases + BRAT, *nicht* mehr manuelle Copy an 4 Vault-Locations.
Memory `reference_deploy.md` ist entsprechend neu geschrieben.

**CI-Slip-Lektion:** `bunx tsc --noEmit` ist jetzt Pflicht vor Commits — siehe
`.claude/rules/plugin-src.md` + `.claude/rules/rust-crates.md`. Vitest-Mocks
fangen argc-Mismatches nicht (gemockte Constructors ignorieren args). Die
`DocumentManager(app, peerId)`-Signatur-Aenderung war genau so durchgerutscht
(siehe `071360e`). Wenn du plugin-src oder crates anfasst, fuehre vor dem
Commit `bun run test && bunx tsc --noEmit && bun run build` aus.

## Naechste Session — Aufgaben in Reihenfolge

### 1. Server-Repo auf Release-Flow umstellen

**Anderer Ordner:** `/home/richard/projects/vaultcrdt-server`

Der Server muss analog zum Plugin auf GitHub Releases + `fleet deploy`
umgestellt werden. Was konkret zu tun ist:

- Aktuellen Release-Workflow im Server-Repo pruefen (`.github/workflows/`)
  — gibt es schon einen Release-Workflow? Wenn nein, analog zum Plugin anlegen
  (Trigger auf Tag-Push, Build, Release mit Binary/Image-Asset)
- Server-Version bumpen (vermutlich in `Cargo.toml` + `compose.yaml` in `fleet`)
- Tag + Push → Release-Workflow laeuft
- `fleet deploy vaultcrdt` (bzw `just home-deploy vaultcrdt`) zieht das neue
  Release

**Aufgabe fuer die naechste Session:** In das Server-Repo wechseln, den Stand
inspizieren, Release-Flow vergleichen, ggf. Workflow anlegen/anpassen, dann
deployen. Memory `reference_deploy.md` bei Bedarf nach dem Server-Deploy
praezisieren.

### 2. Alte Vaults loeschen + frisch aufsetzen

Wir sind nicht in Prod. Der Fix heilt existierenden Schaden NICHT — saubere
Neustarts sind einfacher als Recovery. Zu loeschen/resetten:

- `richardsachen`-Vault (hatte 805 Conflict-Files)
- alle anderen Test-Vaults mit Sync-Beteiligung

Fuer jeden Vault:
- `.obsidian/plugins/vaultcrdt/data.json` wird beim ersten Start neu erzeugt,
  mit frischer `peerId` (stable ab v0.2.17)
- `.loro`-Dateien im State-Storage entfernen, damit keine Ops von frueheren
  Random-PeerIDs mitgeschleppt werden
- Serverseitig: Datenbank-Zustand clearen oder Container neu mit leerem
  Volume starten — je nach Server-Setup

### 3. BRAT Release ziehen

In Obsidian (Desktop + Android):
- BRAT-Plugin → "Add Beta plugin" → Repo-URL `tiny-media/vaultcrdt-plugin`
  (falls noch nicht hinzugefuegt)
- Falls schon hinzugefuegt: "Check for updates" → zieht `v0.2.17`
- Plugin neu laden
- Peer-ID/Device-Name Setup durchlaufen (Startup-Invariante erzwingt jetzt
  beide Felder, siehe `ensureDeviceIdentity` in `src/settings.ts`)

### 4. Dogfooding-Checkliste durchlaufen

`dogfooding-checklist.md` im Repo-Root, jetzt versioniert auf v0.2.17.
Neun Sektionen, Sektion 9 ist die Conflict-Storm-Haertung mit sechs
Sub-Faellen:

- 9a: Stabile PeerID ueber Restarts
- 9b: Phase-3 Adopt (disjoint VV, gleicher Text)
- 9c: Phase-2 Adopt (fehlender lokaler CRDT-State)
- 9d: Editor-first Content Reads (stale disk vs. frisches Editor-Buffer)
- 9e: Local-only `doc_create` mit offenem Editor
- 9f: Vault-Klon-Caveat (erwartet bricht — nur dokumentieren)

Ergebnisse direkt in `dogfooding-checklist.md` eintragen, Datum + Versionen
ausfuellen, bei Funden die `Issues`-Section befuellen.

### 5. Handoff + Close

Nach dem Durchlauf: Handoff schliessen (dieser File), ggf. Issues als neues
`gpt-audit/archive-2026-04-08-dogfooding/` anlegen falls etwas zu fixen ist.

## Known caveats / parkend

- **Vault-Klon-Caveat** — `peerId` liegt vault-lokal in `data.json`. Wer Vault
  inkl. Plugin-Konfig auf ein zweites Geraet kopiert, schleppt dieselbe
  Loro-PeerID mit. Memory: `project_peerid_clone_caveat.md`. Loesung (Klon-
  Detection-Hook) ist pre-community-release Arbeit, nicht jetzt. In der
  Dogfooding-Checkliste als Sektion 9f dokumentiert.
- **Snapshot-Migration bestehender Vaults** — alte `.loro`-Files enthalten
  Ops von frueheren Random-PeerIDs. Praktisch loesen wir das in der naechsten
  Session durch Delete-and-rebuild, siehe Aufgabe 2.
- **versions.json ist stale** — Eintraege fuer 0.2.2..0.2.16 fehlen. Fuer BRAT
  irrelevant, fuer den offiziellen Obsidian Plugin Store waere das relevant —
  aber wir sind self-hosted. Kein Handlungsbedarf jetzt.

## Deferred (unveraendert)

- **#7 Multi-Editor-Konsistenz** — public release
- **#8 WS-Token-Logging** — public release

Siehe `gpt-audit/archive-2026-04-06/claude-response.md`.

## Wenn etwas schiefgeht

- **BRAT zieht das Release nicht:** `manifest.json` Version pruefen
  (muss `0.2.17` sein). `gh release view v0.2.17` zeigt die Assets.
- **Plugin startet nicht nach Update:** Console-Errors pruefen, haeufigste
  Ursache: `data.json` fehlt Felder die der neue `ensureDeviceIdentity`
  erwartet — der Helper fuellt beide Felder auf, persistiert und laeuft
  weiter. Sollte transparent sein.
- **Server akzeptiert die neuen Plugin-Clients nicht:** Server ist noch
  nicht redeployed (Aufgabe 1). Bis dahin gegen den alten Server testen —
  der ist kompatibel, `createDocument(doc_uuid, peer_id)` ist eine
  reine Plugin-interne Signatur-Aenderung ohne Wire-Format-Impact.
- **`tsc --noEmit` meldet Fehler nach lokaler Aenderung:** Das ist die
  neue Pflicht-Verifikation. Lokal fixen bevor committen, NICHT
  im CI rausfinden.
