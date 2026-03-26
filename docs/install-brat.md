# Installing VaultCRDT via BRAT

VaultCRDT is not yet in the Obsidian community plugin store. You can install it with **BRAT** (Beta Reviewers Auto-update Tool), which lets you install plugins directly from GitHub.

---

## Prerequisites

VaultCRDT requires a **self-hosted VaultCRDT server**. The plugin syncs notes — it does not provide a server. Before installing, get the following from your server admin:

- **Server URL** — e.g. `https://sync.example.com`
- **Vault Name** — e.g. `family-notes` (lowercase, letters, numbers, hyphens)
- **Password** — the shared vault password, same on every device

If you ARE the server admin, see the [server README](https://github.com/tiny-media/vaultcrdt-server) for how to set up the server and create vaults.

---

## Step 1 — Install BRAT

1. Open Obsidian → **Settings** → **Community plugins**
2. If restricted mode is on, click **Turn on community plugins**
3. Click **Browse**, search for **BRAT**, install and enable it

---

## Step 2 — Add VaultCRDT via BRAT

1. Open **Settings** → **BRAT**
2. Click **Add Beta plugin**
3. Enter the repository URL:
   ```
   https://github.com/tiny-media/vaultcrdt-plugin
   ```
4. Click **Add Plugin** — BRAT downloads the latest release
5. Go to **Settings** → **Community plugins**, find **VaultCRDT**, and enable it

---

## Step 3 — Connect

After enabling the plugin, the **Setup** screen appears automatically:

| Field | What to enter |
|---|---|
| **Server** | The URL your admin gave you |
| **Vault Name** | The vault name — must match on every device |
| **Password** | The shared vault password |

Click **Connect**. The plugin verifies your credentials, then syncs your notes.

If you see an error, double-check the details with your server admin.

---

## Adding another device

Install BRAT and VaultCRDT the same way (Steps 1–2). When the Setup screen appears, enter the **same Vault Name and Password** as on your first device.

---

## Keeping VaultCRDT up to date

BRAT checks for updates automatically. You can also trigger a manual check:

**Settings** → **BRAT** → **Check for updates**
