# Plan — Plugin SetupModal Admin-Token + Vault-Reconfigure

Datum: 2026-04-08
Status: open, vorbereitet fuer naechste Session
Cycle-Typ: out-of-band UX-Fix (kein externes GPT-Audit)

## Problem

Nach dem Server-DB-Wipe in Session 10 stand der User vor der Frage: "Wie
lege ich neue Vaults auf dem Server an?" Die Antwort ist heute fummelig,
weil das Plugin selbst keinen neuen Vault registrieren kann.

**Aktueller Server-Vertrag** (`vaultcrdt-server/src/lib.rs:125-164`):

```
POST /auth/verify
  { vault_id, api_key, admin_token? }

  - Vault existiert    → vault_id + api_key reichen, JWT zurueck
                          (admin_token wird komplett ignoriert)
  - Vault existiert nicht → admin_token MUSS state.admin_token matchen,
                            sonst 401 "Authentication failed". Bei Match
                            wird der Vault on-the-fly mit api_key als
                            Argon2id-Hash angelegt.
```

Es gibt **keinen separaten `/vault/create`-Endpoint** — Vault-Creation
ist eine implizite Side-Effect-Variante von `/auth/verify`.

**Aktueller Plugin-Stand** (alle vier `auth/verify`-Aufrufstellen):

| Datei                | Zeile | Was wird gesendet                |
|----------------------|-------|----------------------------------|
| `setup-modal.ts`     | 148   | `{ vault_id, api_key }`          |
| `sync-engine.ts`     | 133   | `{ vault_id, api_key }`          |
| `settings.ts`        | 344   | `{ vault_id, api_key }`          |
| `settings.ts`        | 394   | `{ vault_id, api_key }`          |

**Keine** dieser Stellen sendet `admin_token`. Konsequenz: Das Plugin
kann sich nur an *bestehende* Vaults connecten, nie einen neuen anlegen.
Der User muss out-of-band einen `curl` mit dem Token aus SOPS feuern,
bevor das SetupModal funktioniert.

**Zweiter Gap** (verwandt, aber nicht aktut): Der Settings-Tab hat heute
keinen "Re-Run Setup"-Button. Wenn der User auf einen anderen Vault
wechseln will (z.B. nach `richardsachen` jetzt `arbeitsnotizen`), muss
er heute `data.json` per Hand loeschen oder Plugin deinstallieren.

## Ziel

Ein nachhaltiger UX-Pfad fuer Vault-Erstellung **ohne curl**, mobile- und
desktop-tauglich, ohne Server-Aenderung, ohne Wire-Format-Bruch.

**Nicht-Ziele:**

- Keine Server-API-Erweiterung (`/vault/create` o.ae.) — der bestehende
  `/auth/verify`-Pfad ist ausreichend, ein zweiter Endpoint erzeugt nur
  Drift.
- Keine Persistierung des Admin-Tokens auf der Disk. Der Token ist eine
  one-shot Credential, die nur waehrend des ersten Auth-Calls existiert.
- Kein Multi-Vault-Switching innerhalb einer einzelnen Plugin-Instanz.
  Ein Plugin-Setup, ein Vault. Wechseln geht nur via Reconfigure-Flow,
  der einen *neuen* Initial-Sync ausloest.

## Scope — was wird geaendert

### Plugin-Code

1. **`src/setup-modal.ts`** — neues optionales Feld
2. **`src/sync-engine.ts`** — `auth()` akzeptiert one-shot admin_token
3. **`src/main.ts`** — Result aus SetupModal in den one-shot durchreichen
4. **`src/settings.ts`** — neuer "Reconnect to a different vault" Button
5. **`src/__mocks__/obsidian.ts`** — Stubs fuer `Modal` + `Notice`
6. **`src/__tests__/setup-modal.test.ts`** — neuer Smoke-Test
7. **`src/__tests__/sync-engine.test.ts`** — admin_token-Pfad
8. **`manifest.json` + `package.json`** — bump 0.2.17 → 0.2.18
9. **`CHANGELOG.md`** — `[0.2.18]` Eintrag

### Server-Code

Keine Aenderung. Der bestehende `auth_verify`-Pfad akzeptiert
`admin_token` schon als optionales Body-Feld.

### Memory / Docs

- `memory/reference_deploy.md` ggf. minimal ergaenzen ("Vault-Erstellung
  geht jetzt im Plugin-Setup, kein curl mehr")
- `dogfooding-checklist.md` ggf. um eine Sektion 10 erweitern, die den
  neuen Setup-Flow auf Desktop + Android verifiziert

## Architektur

### Datenfluss admin_token

```
SetupModal
   ├─ Eingabefeld "Admin Token" (collapsible "Advanced for new vaults")
   ├─ submit() → SetupResult { serverUrl, vaultId, vaultSecret, adminToken? }
   │
main.ts startWithSetup()
   ├─ Object.assign(settings, result)   ← OHNE adminToken
   ├─ saveSettings()                    ← persistiert vaultId/Secret/URL
   ├─ if (result.adminToken)
   │     syncEngine.setOneShotAdminToken(result.adminToken)
   └─ syncEngine.start()
        │
SyncEngine
   ├─ private oneShotAdminToken: string | null = null
   ├─ setOneShotAdminToken(t) { this.oneShotAdminToken = t }
   ├─ private async auth() {
   │     const body = { vault_id, api_key }
   │     if (this.oneShotAdminToken) {
   │         body.admin_token = this.oneShotAdminToken
   │         this.oneShotAdminToken = null    ← clear nach use
   │     }
   │     POST /auth/verify with body
   │   }
```

**Invariante:** Der Token lebt nur im RAM, vom SetupModal-Submit bis zum
ersten erfolgreichen `auth()`-Call. Failed der Auth (z.B. falscher Token),
wird der `oneShotAdminToken` **nicht** gecleared, damit ein Retry den
Token nochmal mitsendet — aber er wird auch **nicht** persistiert. Plugin-
Reload nach Fail = Token weg = User muss im SetupModal neu eintippen.

**Edge case:** Wenn der Vault inzwischen schon existiert (Race mit zweitem
Geraet, oder User hat den Vault zwischendurch via curl angelegt), wird
der Server `admin_token` ignorieren und ueber den `verify_vault`-Pfad
authen. Das ist OK — der oneShot wird trotzdem nach dem Call gecleared.

### SetupModal UI

Aktuelles Layout (`src/setup-modal.ts:34-99`):

```
VaultCRDT — Setup
   Server                                    [text]
   Vault Name                                [text]
   Password                                  [password]
   [Cancel]   [Connect]
```

Neues Layout:

```
VaultCRDT — Setup
   Server                                    [text]
   Vault Name                                [text]
   Password                                  [password]

   ▶ Creating a new vault?
       ↓  (collapsible, default-collapsed)
       Admin Token                           [password]
       (Only needed when registering a new vault for
        the first time. Ask your server admin.)

   [Cancel]   [Connect]
```

Default-collapsed verhindert dass bestehende User mit dem zusaetzlichen
Feld verwirrt werden. Mobile-tauglich, ein simples `<details>` reicht.

### SettingsTab Reconfigure-Button

Nach der "Connection"-Sektion ein neuer Block:

```
[Reconnect to a different vault]
```

Klick → `new SetupModal(this.app, this.plugin.settings).prompt()` mit
preset Values. Bei OK: settings ueberschreiben, **`onboardingComplete =
false` setzen** (damit der Initial-Sync nochmal als pull/push/merge
auto-detection laeuft), `syncEngine.restart()`. Bei Cancel: nichts
veraendern.

**Achtung:** Vault-Wechsel sollte den lokalen `.obsidian/plugins/vaultcrdt/state/`
Storage nicht automatisch wischen — sonst wuerde ein Tippfehler im
Vault-Namen die ganze CRDT-State zerstoeren. Stattdessen: neuer `vaultId`
ueberschreibt den state-storage-Pfad sowieso (er ist vault-id-prefixed
... ist er das?). **TODO in der Implementation:** verifizieren ob
`StateStorage` per vault-id geschluesselt ist; wenn nicht, eine kleine
Migration noetig.

## Code-Skizzen

### `src/setup-modal.ts` — neue Felder

```typescript
export interface SetupResult {
  serverUrl: string;
  vaultId: string;
  vaultSecret: string;
  adminToken?: string;       // ← NEU, optional
}

export class SetupModal extends Modal {
  // ... bestehende Felder
  private adminToken = '';   // ← NEU

  onOpen(): void {
    // ... bestehende Felder unveraendert

    // NEU: collapsible Advanced section
    const advanced = contentEl.createEl('details');
    advanced.createEl('summary', { text: 'Creating a new vault?' });
    new Setting(advanced)
      .setName('Admin Token')
      .setDesc('Only needed when registering a new vault for the first time.')
      .addText((text) => {
        text
          .setPlaceholder('admin token')
          .setValue('')
          .onChange((v) => { this.adminToken = v.trim(); });
        text.inputEl.type = 'password';
        return text;
      });

    // ... Buttons unveraendert
  }

  private async submit(btn: ...): Promise<void> {
    // ... bestehende Validation

    // Body bauen — admin_token nur wenn gesetzt
    const body: Record<string, string> = {
      vault_id: this.vaultId,
      api_key: this.vaultSecret,
    };
    if (this.adminToken) body.admin_token = this.adminToken;

    try {
      const resp = await requestUrl({
        url: `${httpBase}/auth/verify`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (resp.json?.token) {
        this.resolve?.({
          serverUrl: this.serverUrl,
          vaultId: this.vaultId,
          vaultSecret: this.vaultSecret,
          // adminToken durchreichen — caller (main.ts) entscheidet was
          // damit passiert; SetupModal selbst persistiert nichts
          ...(this.adminToken ? { adminToken: this.adminToken } : {}),
        });
        // ...
      }
    } catch (e: unknown) {
      // ... bestehende Fehlerbehandlung; bei 401 zusaetzlicher Hinweis:
      //     "If this is a NEW vault, expand 'Creating a new vault?'
      //      and enter the admin token."
    }
  }
}
```

### `src/sync-engine.ts` — one-shot Token

```typescript
export class SyncEngine {
  // ... bestehende Felder
  private oneShotAdminToken: string | null = null;

  setOneShotAdminToken(token: string): void {
    this.oneShotAdminToken = token;
  }

  private async auth(): Promise<void> {
    const body: Record<string, string> = {
      vault_id: this.settings.vaultId,
      api_key: this.settings.vaultSecret,
    };
    if (this.oneShotAdminToken) {
      body.admin_token = this.oneShotAdminToken;
      this.oneShotAdminToken = null;     // clear nach use
    }
    const resp = await requestUrl({
      url: `${this.httpBase()}/auth/verify`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.token = resp.json.token as string;
  }
}
```

### `src/main.ts` — Token an SyncEngine durchreichen

```typescript
private async startWithSetup(): Promise<void> {
  const needsSetup = !this.settings.serverUrl || !this.settings.vaultId
                  || !this.settings.vaultSecret;
  if (needsSetup) {
    const result = await new SetupModal(this.app, this.settings).prompt();
    if (result) {
      // Persistente Settings (ohne adminToken)
      this.settings.serverUrl = result.serverUrl;
      this.settings.vaultId = result.vaultId;
      this.settings.vaultSecret = result.vaultSecret;
      await this.saveSettings();

      // One-shot Admin Token NICHT persistieren
      if (result.adminToken) {
        this.syncEngine.setOneShotAdminToken(result.adminToken);
      }
    } else {
      new Notice('VaultCRDT: open Settings to configure sync', 5000);
      return;
    }
  }
  this.syncEngine.start().catch(...);
}
```

### `src/settings.ts` — Reconfigure-Button

In `display()` nach der Connection-Sektion (~Zeile 178):

```typescript
new Setting(containerEl)
  .setName('Reconnect to a different vault')
  .setDesc('Run the setup again — useful if you want to switch to a new vault.')
  .addButton((btn) =>
    btn.setButtonText('Reconfigure').onClick(async () => {
      const result = await new SetupModal(this.app, this.plugin.settings).prompt();
      if (!result) return;
      this.plugin.settings.serverUrl = result.serverUrl;
      this.plugin.settings.vaultId = result.vaultId;
      this.plugin.settings.vaultSecret = result.vaultSecret;
      this.plugin.settings.onboardingComplete = false;  // re-run pull/push detection
      await this.plugin.saveSettings();
      if (result.adminToken) {
        this.plugin.syncEngine.setOneShotAdminToken(result.adminToken);
      }
      void this.plugin.syncEngine.restart();
      this.display();   // refresh tab
    })
  );
```

## Tests

### Neue Tests

**`src/__tests__/setup-modal.test.ts`** (neu):

- Smoke-Test: render, Felder auslesen, submit() ohne admin_token → Body
  enthaelt nur `vault_id` + `api_key` (kein `admin_token`-Key)
- Mit gesetztem Admin-Token → Body enthaelt `admin_token`
- 401-Response → `showError()` zeigt einen Hint zum Admin-Token-Feld
- Cancel → `resolve(null)`

Vor dem Test muss `__mocks__/obsidian.ts` erweitert werden:

```typescript
export class Modal {
  app: App;
  contentEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.contentEl = document.createElement('div');
  }
  open(): void {}
  close(): void {}
}

export class Notice {
  constructor(_msg: string, _timeout?: number) {}
  setMessage(_msg: string): this { return this; }
  hide(): void {}
}
```

JSDOM ist im Vitest-Setup vermutlich schon aktiv (settings-identity-Tests
nutzen `crypto.randomUUID()` ohne extra Setup). Falls nicht, in
`vitest.config.ts` `environment: 'jsdom'` setzen — pruefen.

### Updated Tests

**`src/__tests__/sync-engine.test.ts`**:

- Bestehender Test "calls /auth/verify with vault_id and api_key" bleibt
  unveraendert (Default-Pfad ohne admin_token).
- Neu: "includes admin_token when one-shot is set" → setOneShotAdminToken
  vor start, dann start, dann body parsen + admin_token pruefen.
- Neu: "clears one-shot after first auth" → setOneShotAdminToken, start,
  zweiter call (z.B. via reconnect/restart) → admin_token nicht mehr im
  Body.

### CI

`bun run test && bunx tsc --noEmit && bun run build` muss komplett gruen
sein (Pflicht laut `.claude/rules/plugin-src.md`). CI-Slip-Vermeidung
besonders wichtig hier wegen neuer Modal/Notice-Mocks.

## Release

1. Code-Changes oben
2. `bun run test` + `bunx tsc --noEmit` + `bun run build`
3. `manifest.json` + `package.json` Version 0.2.17 → 0.2.18
4. `CHANGELOG.md` Eintrag `[0.2.18]`
5. Commit, Tag `v0.2.18`, Push main + Tag
6. Release-Workflow gruen pruefen
7. BRAT zieht das Release auf Desktop + Android

Server bleibt auf `v0.2.6`, kein Server-Redeploy.

## Risiken / offene Punkte

- **`StateStorage` vault-id-prefixing**: Verifizieren ob ein Vault-Wechsel
  via Reconfigure-Button den lokalen CRDT-State nicht verschmutzt. Wenn
  nicht prefixed, eine Migration einbauen ODER explizit dokumentieren
  ("Vault wechseln loescht lokalen Cache fuer den alten Vault").
- **Mobile keyboard UX**: Admin-Token ist lang, paste-from-clipboard auf
  Android sollte funktionieren (`text.inputEl.type = 'password'` blockt
  paste nicht). Smoke-Test im Dogfooding.
- **Onboarding-mode reset bei Reconfigure**: `onboardingComplete = false`
  loest pull/push/merge-Auto-Detection nochmal aus. Das ist gewollt, sonst
  ginge der Reconfigure direkt in einen Merge-Mode der falsch waere.
- **401-Fehlermeldung-Wording**: Heute "Authentication failed. Check vault
  name and password." → ergaenzen um "If you are creating a NEW vault,
  expand 'Creating a new vault?' and enter the admin token."

## Aufwandsschaetzung

Klein. Geschaetzt:
- ~80 Zeilen Code in 4 Dateien
- ~50 Zeilen neue + geaenderte Tests
- 2 Stubs in `__mocks__/obsidian.ts`
- 1 Release-Bump

Eine Session sollte reichen — inkl. Tests, Doku, Release.
