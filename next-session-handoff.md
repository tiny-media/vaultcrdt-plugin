# Session Handoff — Server v0.2.6 live, Plugin SetupModal-Fix wartet

Datum: 2026-04-08 (Ende der zehnten Session)
Branch: `main`, sauber, **auf `origin/main`** gepusht (Plugin-Repo).
Plugin-Release: weiterhin **`v0.2.17`** (kein neuer Release diese Session).
Server-Release: **`v0.2.6`** live + auf `home` deployt.

## Status in einem Satz

Server-Repo ist auf Release-Flow umgestellt und v0.2.6 deployt, DB ist
gewiped fuer eine saubere Baseline — naechste Session muss **das Plugin-
SetupModal um ein Admin-Token-Feld erweitern**, weil der User sonst fuer
jeden neuen Vault einen `curl` out-of-band feuern muss.

## Was diese Session passiert ist

### 1. Server-Repo auf Release-Flow umgestellt

`vaultcrdt-server` (anderes Repo, `/home/richard/projects/vaultcrdt-server`):

- Neuer `.github/workflows/release.yml` analog zum Plugin: Tag-Push triggert
  cargo fmt/clippy/test + `softprops/action-gh-release@v2` mit
  `generate_release_notes: true`. Der bestehende `docker.yml` (GHCR-Image
  Publish) bleibt unveraendert.
- Cargo `0.2.5 → 0.2.6`, Cargo.lock mitgezogen, CHANGELOG `[0.2.6]` Eintrag.
- Commit `98479ba`, Tag `v0.2.6`, beide gepusht. Alle vier Workflows gruen
  (Release, CI, Docker main, Docker v0.2.6).
- GitHub Release `v0.2.6` ist live, diesmal vom `github-actions[bot]`
  erstellt — nicht mehr manuell wie v0.2.5.

### 2. Server auf home redeployt

- Fleet compose `hosts/home/stacks/vaultcrdt/compose.yaml` Version-Bump
  v0.2.5 → v0.2.6 (lokal committed in fleet als `23d748b`, **nicht
  gepusht** — die anderen dirty files in fleet sind nicht unsere Baustelle).
- `just home-deploy vaultcrdt` lief durch (nach 1Password-Desktop-Restart,
  weil `op`-CLI als Broker dient).
- Container `vaultcrdt-server:0.2.6` gestartet 2026-04-08 13:45,
  healthy, external HTTP 200 gegen `https://obsidian-sync.hyys.de/health`.

### 3. Server-DB komplett gewiped + Baseline gesichert

- **Vor Wipe:** 50 MB total in `/opt/docker-setups-home/vaultcrdt/data/`
  (24 MB main.db + 24 MB WAL + 2.9 MB v1→v2 .bak)
- **Nach Wipe + Restart:** 177 KB total — leeres Schema nach Migrations.
- **Memory gespeichert:** `memory/project_server_baseline_2026-04-08.md`
  enthaelt Disk + NET I/O Baseline und einen `ssh home ...`-One-liner
  fuer den Re-Check. Target: **2026-07-08** (3-Monats-Delta).
- **Caveat im Memory:** `docker stats` NET-I/O Counter resetten bei jedem
  Container-Restart. Wenn der Container zwischen jetzt und Juli neugestartet
  wird, ist das Network-Delta verloren — Disk-Delta bleibt.

### 4. Plugin-SetupModal Gap entdeckt

User hat seine Vaults aufgeraeumt und ueber BRAT v0.2.17 frisch
installiert. Beim Versuch, sich nach dem DB-Wipe zu connecten, kam die
Frage: "Wie lege ich neue Vaults auf dem Server an?"

Antwort: Heute fummelig. Der Server hat keinen `/vault/create`-Endpoint;
Vault-Erstellung passiert implizit ueber `POST /auth/verify` mit einem
zusaetzlichen `admin_token`-Feld im Body. **Das Plugin sendet dieses
Feld nirgendwo** (siehe `setup-modal.ts:148`, `sync-engine.ts:133`,
`settings.ts:344+394`). Der User muss out-of-band per `curl` mit dem
Admin-Token aus SOPS einen neuen Vault anlegen, *bevor* das Plugin sich
verbinden kann.

User hat sich entschieden: nicht curl-Workaround, sondern den UX-Fix
nachhaltig im Plugin loesen. Diese Session hat dafuer den Plan geschrieben,
die Implementation kommt naechste Session.

## Naechste Session — Aufgaben in Reihenfolge

### 1. Plugin SetupModal Admin-Token-Feld + Reconfigure-Button

**Plan:** [`gpt-audit/archive-2026-04-08-setup-admin-token/plan.md`](gpt-audit/archive-2026-04-08-setup-admin-token/plan.md)

Kurz:

- `SetupModal` bekommt ein collapsible "Creating a new vault?" mit einem
  optionalen Admin-Token-Feld.
- `SyncEngine.auth()` akzeptiert einen one-shot Admin-Token (RAM-only,
  niemals in `data.json` persistiert, gecleared nach erstem Auth).
- `main.ts startWithSetup()` reicht den Token vom SetupModal an
  `SyncEngine.setOneShotAdminToken()` durch.
- `SettingsTab` bekommt einen "Reconnect to a different vault" Button,
  der das SetupModal mit Preset-Werten oeffnet (fuer Vault-Wechsel).
- Tests: neuer `setup-modal.test.ts`, erweiterte `sync-engine.test.ts`,
  `__mocks__/obsidian.ts` um `Modal` + `Notice` ergaenzen.
- Release: Plugin `v0.2.18`, BRAT zieht.

**Server bleibt auf v0.2.6**, kein Server-Redeploy. Der bestehende
`auth_verify`-Pfad in `vaultcrdt-server/src/lib.rs:125-164` akzeptiert
`admin_token` schon als optionales Body-Feld.

**Offene TODOs aus dem Plan:**

- Verifizieren ob `StateStorage` per vault-id geschluesselt ist (sonst
  wuerde ein Reconfigure-Vault-Wechsel den lokalen CRDT-State
  verschmutzen).
- Falsche-Auth-Fehlermeldung um Hinweis auf Admin-Token-Feld erweitern
  (bei 401: "If you are creating a NEW vault, expand 'Creating a new
  vault?' and enter the admin token.")

### 2. Vaults via Plugin anlegen

Mit `v0.2.18` BRAT-installiert auf Desktop:

- SetupModal oeffnen
- Server-URL `https://obsidian-sync.hyys.de`, Vault-Name (lowercase, z.B.
  `richardsachen`), Password frei waehlen
- "Creating a new vault?" aufklappen, Admin-Token aus 1Password (oder
  via `sops -d /home/richard/fleet/hosts/home/stacks/vaultcrdt/secrets.sops.yaml | yq -r '.VAULTCRDT_ADMIN_TOKEN'`)
- Connect → Vault wird angelegt → Token verschwindet aus Memory
- Auf Android: gleicher Vault-Name + gleiches Password, Admin-Token
  ist NICHT mehr noetig (Vault existiert dann ja schon)

### 3. Dogfooding-Checkliste durchlaufen

`dogfooding-checklist.md`, neun Sektionen, Sektion 9 ist die Conflict-
Storm-Haertung mit sechs Sub-Faellen:

- 9a: Stabile PeerID ueber Restarts
- 9b: Phase-3 Adopt (disjoint VV, gleicher Text)
- 9c: Phase-2 Adopt (fehlender lokaler CRDT-State)
- 9d: Editor-first Content Reads (stale disk vs. frisches Editor-Buffer)
- 9e: Local-only `doc_create` mit offenem Editor
- 9f: Vault-Klon-Caveat (erwartet bricht — nur dokumentieren)

Optional Sektion 10 ergaenzen, die den neuen Setup-Flow auf Desktop +
Android verifiziert.

### 4. Handoff + Close

Nach Durchlauf: Handoff schliessen, ggf. Funde in
`gpt-audit/archive-2026-04-08-setup-admin-token/response.md` (oder ein
neuer Cycle-Ordner) sammeln.

## Wichtige Dateipfade fuer den Plugin-Fix

```
src/setup-modal.ts                       (148: auth/verify body)
src/sync-engine.ts                       (128-139: auth() method)
src/settings.ts                          (74-381: SettingsTab.display)
src/main.ts                              (122-138: startWithSetup)
src/__mocks__/obsidian.ts                (Modal + Notice fehlen)
src/__tests__/sync-engine.test.ts        (185-220: auth tests)

vaultcrdt-server/src/lib.rs:125-164      (auth_verify, server-side)
```

## Known caveats / parkend

- **Vault-Klon-Caveat** — `peerId` liegt vault-lokal in `data.json`. Wer
  Vault inkl. Plugin-Konfig auf ein zweites Geraet kopiert, schleppt
  dieselbe Loro-PeerID mit. Memory: `project_peerid_clone_caveat.md`.
  Pre-community-release Arbeit.
- **Server-Baseline NET-I/O** — Counter reset bei jedem Container-Restart.
  Wenn `home` zwischen jetzt und Juli neu booted oder der Container neu
  startet, ist das Network-Delta zur Baseline verloren. Disk-Delta bleibt
  belastbar.
- **Fleet-Commit `23d748b` ist lokal, nicht gepusht.** Der Rest des dirty
  state in fleet ist nicht unsere Baustelle, deshalb kein `git push`.
  Beim naechsten fleet-Push sollte er mit raus.
- **versions.json ist stale** — Eintraege fuer 0.2.2..0.2.16 fehlen. Fuer
  BRAT irrelevant, fuer den offiziellen Obsidian Plugin Store relevant —
  aber wir sind self-hosted. Kein Handlungsbedarf.

## Deferred (unveraendert)

- **#7 Multi-Editor-Konsistenz** — public release
- **#8 WS-Token-Logging** — public release

Siehe `gpt-audit/archive-2026-04-06/claude-response.md`.

## Wenn etwas schiefgeht

- **`bun run test` schlaegt fehl wegen `Modal`/`Notice`**: `__mocks__/obsidian.ts`
  fehlen die Stubs, siehe Plan-Skizze.
- **`bunx tsc --noEmit` schlaegt fehl**: vermutlich SetupResult-Interface-
  Drift; das `adminToken?: string` muss ueberall konsistent durchgereicht
  werden. tsc ist Pflicht laut `.claude/rules/plugin-src.md` — wenn das
  nicht laeuft, kein Commit.
- **BRAT zieht v0.2.18 nicht**: `manifest.json` Version pruefen, dann
  `gh release view v0.2.18` Assets pruefen.
- **SetupModal Admin-Token-Feld bleibt sichtbar nach Connect**: das ist
  OK und gewollt — der Token wird aus dem Memory gecleared, das Feld
  selbst ist aber Teil des UI bis das Modal schliesst. Beim naechsten
  Oeffnen ist das Feld leer.
- **Reconfigure-Button wechselt Vault, aber alter CRDT-State bleibt**:
  TODO aus dem Plan: `StateStorage` per vault-id keying verifizieren.
  Falls nicht prefixed, vor dem Restart `state-storage.ts` clearen oder
  Migration einbauen.
