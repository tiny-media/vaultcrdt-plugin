# Next Session — Onboarding / Setup-Flow verbessern

## Ziel

Der Setup-Prozess für neue Geräte / neue Vaults soll benutzerfreundlicher werden.
Mindestanforderung: Der User soll beim Einrichten einen **Vault-Namen** (= `vaultId`) eingeben können, statt mit einer zufälligen UUID arbeiten zu müssen.

---

## Aktueller Zustand (Probleme)

### 1. vaultId ist ein zufälliges UUID — unbrauchbar beim Einrichten

In `settings.ts` Z. 64–76:
```typescript
if (!this.plugin.settings.vaultId) {
    this.plugin.settings.vaultId = crypto.randomUUID();  // z.B. "f47ac10b-58cc-4372-a567-..."
    needsSave = true;
}
```

Das passiert beim ersten Öffnen der Settings-Seite automatisch. Der User sieht dann in "Advanced" eine UUID als Vault ID, aber nie die Möglichkeit, einen lesbaren Namen einzugeben. In der Praxis hat Richards Vault die ID `richardsachen` — die wurde manuell in der settings.json gesetzt.

**Der vaultId-Wert IST der vault-identifier auf dem Server.** Er kann ein lesbarer String sein (`richardsachen`, `work-notes`, etc.) — nicht nur UUID. Das macht ihn zur "Vault-Adresse".

### 2. Onboarding-Modal kommt ZU SPÄT (nach erfolgreicher Verbindung)

Flow derzeit in `main.ts`:
```
Plugin lädt → syncEngine.start() → auth() → connect() → onInitialSync() → OnboardingModal
```

Das Onboarding-Modal (`onboarding-modal.ts`) erscheint erst, NACHDEM die Verbindung zum Server erfolgreich war. Es fragt nur Pull/Push/Merge, aber KEINE Zugangsdaten.

Problem: Wenn `serverUrl`, `vaultSecret` oder `vaultId` leer/falsch sind → Verbindung schlägt fehl → Modal erscheint nie. Der User landet bei einer kryptischen "Connection failed"-Meldung.

### 3. Zugangsdaten müssen manuell in Settings eingetippt werden

Aktuell muss ein neuer User:
1. Plugin installieren
2. Settings öffnen
3. Server-URL eintragen
4. Admin-Token eintragen
5. Vault Secret eintragen
6. vaultId in Advanced kopieren/anpassen (erst nachdem UUID generiert wurde)
7. Settings schließen, Obsidian warten lassen
8. Onboarding-Modal bestätigen

Besonders auf Android ist das umständlich.

---

## Gewünschter Zustand

### Minimale Lösung (was der User konkret will)

**Beim Onboarding kann der User einen Vault-Namen eingeben** statt mit UUID zu arbeiten.

Das bedeutet:
- Die `vaultId`-Autogenerierung (UUID) in `VaultCRDTSettingsTab.display()` soll NICHT mehr automatisch passieren
- Stattdessen: Entweder im Onboarding-Modal ein Feld für den Vault-Namen, ODER das Settings-Tab zeigt ein editierbares Textfeld für die Vault ID (statt nur "Copy"-Button)

### Bessere Lösung (Setup-Wizard als erster Schritt)

Ein **Setup-Modal** das erscheint wenn die Zugangsdaten fehlen, BEVOR die Verbindung versucht wird:

```
Plugin lädt → Zugangsdaten vorhanden?
  Nein → SetupModal (Server URL + Vault Name + Vault Secret + Admin Token)
  Ja  → syncEngine.start() → OnboardingModal (Pull/Push/Merge)
```

---

## Relevante Dateien

| Datei | Zweck |
|-------|-------|
| `src/onboarding-modal.ts` | Aktuelles Modal (Pull/Push/Merge-Auswahl) |
| `src/settings.ts` | Settings-Interface + SettingsTab + vaultId-Autogenerierung |
| `src/main.ts` | Plugin-Lifecycle, onInitialSync-Hook |

### settings.ts — vaultId-Felder

```typescript
// Aktuell: Auto-UUID in display() — das soll weg / änderbar sein
if (!this.plugin.settings.vaultId) {
    this.plugin.settings.vaultId = crypto.randomUUID();  // Problem
}

// Aktuell: vaultId nur als "Copy"-Button in Advanced
new Setting(advancedContainer)
    .setName('Vault ID')
    .setDesc(`Identifies this vault on the server: ${this.plugin.settings.vaultId}`)
    .addButton((btn) => btn.setButtonText('Copy')...);
```

### main.ts — wo der Setup-Check hin soll

```typescript
// In start() oder onload() — BEVOR syncEngine.start()
// Prüfen ob serverUrl + vaultId + vaultSecret gesetzt sind
// Falls nicht → SetupModal öffnen, auf Ergebnis warten, dann starten
this.syncEngine.start().catch(...)
```

### onboarding-modal.ts — aktuelles Modal

Zeigt derzeit nur Pull/Push/Merge. Könnte erweitert werden oder durch einen mehrstufigen Wizard ersetzt werden.

---

## Implementierungs-Vorschlag für die nächste Session

### Option A: Minimal — vaultId editierbar machen

1. In `settings.ts`: UUID-Autogenerierung entfernen, stattdessen `vaultId`-Feld als editierbares `addText()` in den normalen (nicht Advanced) Bereich verschieben
2. Placeholder: `"my-vault"` oder `"vault name (lowercase, no spaces)"`
3. `vaultId` mit `crypto.randomUUID()` nur dann vorbelegen wenn der User explizit einen Button "Generate" klickt
4. Validierung: lowercase alphanumeric + Bindestrich

### Option B: Setup-Wizard Modal

1. Neue Datei `src/setup-modal.ts`
2. Mehrstufig (oder einseitig mit allen Feldern):
   - Step 1: Server URL eingeben + Verbindung testen
   - Step 2: Vault Name eingeben (= vaultId) + Vault Secret
   - Step 3: Admin Token (nur für neue Vaults nötig)
3. In `main.ts` vor `syncEngine.start()`: Wenn `!settings.serverUrl || !settings.vaultId || !settings.vaultSecret` → SetupModal öffnen

**Empfehlung: Option B**, weil es den User durch den gesamten Setup-Prozess führt und besonders auf Android viel besser ist.

---

## Bestehende Obsidian Modal API

```typescript
import { Modal, App, Setting } from 'obsidian';

// Pattern aus onboarding-modal.ts:
class SetupModal extends Modal {
    prompt(): Promise<SetupResult> {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.open();
        });
    }
    onOpen(): void { /* Felder aufbauen mit new Setting(contentEl)... */ }
    onClose(): void { /* Default-Werte wenn Modal geschlossen */ }
}
```

`requestUrl` ist die Obsidian-API für HTTP-Requests (kein fetch auf Mobile):
```typescript
import { requestUrl } from 'obsidian';
const resp = await requestUrl({ url: `${base}/health`, method: 'GET' });
```

---

## Vault-Name Constraints (Server-seitig)

Der Server nutzt `vault_id` als DB-Key. Erlaubt sind: `[a-z0-9\-_]` (lowercase). Der Server macht keine Validierung — das muss das Plugin tun. Beispiele: `richardsachen`, `work-notes`, `my-vault-2025`.

---

## Was NICHT geändert werden soll

- Die Server-API selbst (kein Server-Deploy nötig)
- Der Sync-Mechanismus (funktioniert in v0.2.13)
- `onboardingComplete`-Flag-Logik (bleibt als Guard gegen Onboarding-Loop)

---

## SSH / Deploy (zur Erinnerung)
- Deploy Server: `cd ~/fleet && just home-deploy vaultcrdt`
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
- Version in `package.json` + `manifest.json` erhöhen → nächste wäre `v0.2.14`
