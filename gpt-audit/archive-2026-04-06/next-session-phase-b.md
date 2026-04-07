# Phase B: Nächste Session — Items 4, 5, 6

Erstellt: 2026-04-07  
Voraussetzung: Phase A (Initial-Sync-Hash, State-Key, Path-Policy) ist merged.

---

## Empfohlene Reihenfolge

1. **Auth-/Secret-Härtung** (Item 6) — selbstständig, nur Server, klarer Scope
2. **Delete-/Tombstone-Härtung** (Item 4) — Server + Plugin, wichtigster Korrektheitsfix
3. **WASM-Build-Reproduzierbarkeit** (Item 5) — reines Tooling, niedrigste Dringlichkeit

Items 5 und 6 sind vollständig unabhängig und können parallel bearbeitet werden.

---

## Item 6: Auth-/Secret-Härtung

### Repo: vaultcrdt-server

### Ist-Zustand (verifiziert)
- `db.rs:create_vault` speichert `api_key` als Klartext via `INSERT OR IGNORE`
- `db.rs:verify_vault` vergleicht direkt: `stored == api_key`
- `lib.rs:auth_verify` unterscheidet "Invalid API key" vs "Invalid admin token" (Vault-Enumeration)

### Designentscheidungen (vorab)
- **Argon2id** über `argon2` Crate (v0.5) — Rust-Standard, PHC-Format
- **Lazy Migration**: Bei verify prüfen ob Wert mit `$argon2id$` beginnt. Falls nein: Klartext-Vergleich, dann sofort hashen und updaten. Kein separates Migrations-SQL nötig.
- **Einheitliche Fehlermeldung**: Beide Auth-Fehler werden zu `"Authentication failed"`

### Implementierungsschritte

1. `Cargo.toml`: `argon2 = "0.5"` und `password-hash = "0.5"` hinzufügen

2. `db.rs` — zwei Hilfsfunktionen:
   ```rust
   pub fn hash_secret(plaintext: &str) -> Result<String>  // → PHC string
   pub fn verify_secret(plaintext: &str, stored: &str) -> bool
   ```
   `verify_secret` prüft: beginnt `stored` mit `$argon2id$`? Ja → Argon2-Verify. Nein → Klartext-Vergleich (Legacy).

3. `db.rs:create_vault` — vor INSERT: `let hashed = hash_secret(&api_key)?;`

4. `db.rs:verify_vault` — Ablauf:
   - Stored Key laden
   - `verify_secret(api_key, &stored)` aufrufen
   - Falls Klartext-Match: sofort `UPDATE vaults SET api_key = hash_secret(api_key) WHERE vault_id = ?`
   - Boolean zurückgeben

5. `lib.rs:auth_verify` — beide Fehlertexte auf `"Authentication failed"` vereinheitlichen

6. Tests:
   - Neuer Vault → gespeicherter Wert beginnt mit `$argon2id$`
   - Verify mit richtigem Secret → true
   - Verify mit falschem Secret → false
   - Legacy-Klartext-Eintrag → Verify funktioniert, Wert wird automatisch gehasht

### Dateien
- `vaultcrdt-server/Cargo.toml`
- `vaultcrdt-server/src/db.rs`
- `vaultcrdt-server/src/lib.rs`

### Aufwand: ~45 min

---

## Item 4: Delete-/Tombstone-Härtung (Phase 1)

### Repos: vaultcrdt-server (primär) + vaultcrdt-plugin (sekundär)

### Ist-Zustand (verifiziert)
- `main.rs:22`: Tombstones expiren nach **7 Tagen** (zu kurz für Offline-Geräte)
- `handlers.rs:186` (`sync_push`) und `:235` (`doc_create`): beide rufen `db::remove_tombstone()` auf → **jeder Push löscht den Tombstone** → stale Resurrection möglich
- Plugin `push-handler.ts:43`: `this.docs.remove(path)` entfernt nur In-Memory, nicht die `.loro`-Datei auf Disk
- Plugin `sync-engine.ts:411`: `this.docs.remove(docUuid)` — gleiches Problem bei Remote-Delete

### Designentscheidungen (vorab)
- **Tombstone-Retention: 90 Tage** — via `VAULTCRDT_TOMBSTONE_DAYS` env-var, Default 90
- **Anti-Resurrection-Guard im Server**: `sync_push` und `doc_create` prüfen **vor** dem Speichern ob ein aktiver Tombstone existiert. Falls ja → neuer Message-Typ `doc_tombstoned` zurückschicken, Push ablehnen
- **Kein Recreate-Flow** in Phase 1 — tombstoned docs können erst nach Ablauf der 90 Tage am selben Pfad neu erstellt werden. Für Single-User akzeptabel.
- **`.loro`-Cleanup**: `removeAndClean()` statt `remove()` — existiert bereits in `document-manager.ts`

### Implementierungsschritte

**Server:**

1. `main.rs`: Tombstone-Retention von 7 auf 90 Tage erhöhen (oder env-var)

2. `db.rs` — neue Funktion:
   ```rust
   pub async fn is_tombstoned(pool: &SqlitePool, vault_id: &str, doc_uuid: &str) -> Result<bool>
   ```

3. `handlers.rs:sync_push` — **vor** dem Speichern:
   ```rust
   if db::is_tombstoned(pool, vault_id, &doc_uuid).await? {
       return Ok(ServerMsg::DocTombstoned { doc_uuid });
   }
   ```
   `db::remove_tombstone()` Aufruf entfernen.

4. `handlers.rs:doc_create` — gleicher Guard, `remove_tombstone()` entfernen

5. `ws.rs` — neuer `ServerMsg`-Variant:
   ```rust
   DocTombstoned { doc_uuid: String }
   ```
   Serialisierung als `{ "type": "doc_tombstoned", "doc_uuid": "..." }`

6. Server-seitige Pfadvalidierung (Bonus): `isSyncablePath`-Äquivalent in `handlers.rs` vor `sync_push`/`doc_create`/`doc_delete`

**Plugin:**

7. `push-handler.ts:43` (`onFileDeleted`): `this.docs.remove(path)` → `void this.docs.removeAndClean(path)`

8. `sync-engine.ts:411` (`onDocDeleted`): `this.docs.remove(docUuid)` → `await this.docs.removeAndClean(docUuid)`

9. `sync-engine.ts:onMessage` — neuer Case:
   ```typescript
   case 'doc_tombstoned':
     warn(`${this.tag} doc is tombstoned on server`, { doc: msg.doc_uuid });
     break;
   ```

10. Tests:
    - Server: create → delete → sync_push für gleichen Pfad → `doc_tombstoned`
    - Plugin: lokaler Delete → `.loro`-Datei ist weg
    - Plugin: Remote Delete → `.loro`-Datei ist weg

### Dateien
- `vaultcrdt-server/src/main.rs`
- `vaultcrdt-server/src/db.rs`
- `vaultcrdt-server/src/handlers.rs`
- `vaultcrdt-server/src/ws.rs`
- `vaultcrdt-plugin/src/push-handler.ts`
- `vaultcrdt-plugin/src/sync-engine.ts`

### Aufwand: ~60-90 min

---

## Item 5: WASM-Build-Reproduzierbarkeit

### Repo: vaultcrdt (Monorepo)

### Ist-Zustand (verifiziert)
- `Cargo.toml`: `wasm-bindgen = "0.2"` (Semver-Range, nicht exakt)
- `Cargo.lock`: `wasm-bindgen 0.2.114` (tatsächlich gelockt)
- `rust-toolchain.toml`: `channel = "stable"`, Rust 1.94
- `Justfile:wasm` baut nach `crates/vaultcrdt-wasm/pkg/` — **nicht** direkt ins Plugin-Repo
- Plugin `wasm/` enthält committed Artefakte, manuell kopiert

### Designentscheidungen (vorab)
- **wasm-bindgen exakt pinnen** auf `"=0.2.114"` (Match zum Lock)
- **Rust-Toolchain pinnen** auf `stable` (reicht, da Cargo.lock die Reproduzierbarkeit sichert)
- **Build-Script** das direkt ins Plugin-Repo ausgibt (Annahme: Repos sind Geschwister auf Disk)
- **CI-Check**: Diff-basiert — Rebuild + Vergleich mit committed Artefakten

### Implementierungsschritte

1. `Cargo.toml`: `wasm-bindgen = "=0.2.114"`

2. Neues Script `scripts/build-wasm.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release
   wasm-bindgen --target web \
     --out-dir ../vaultcrdt-plugin/wasm/ \
     target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm
   echo "WASM artifacts written to ../vaultcrdt-plugin/wasm/"
   ```

3. `Justfile:wasm` aktualisieren → ruft `scripts/build-wasm.sh` auf

4. Neues Script `scripts/check-wasm-fresh.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   TMPDIR=$(mktemp -d)
   cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release
   wasm-bindgen --target web --out-dir "$TMPDIR" \
     target/wasm32-unknown-unknown/release/vaultcrdt_wasm.wasm
   diff -r "$TMPDIR" ../vaultcrdt-plugin/wasm/ && echo "OK: artifacts are fresh" || {
     echo "STALE: committed WASM artifacts differ from source"; exit 1
   }
   rm -rf "$TMPDIR"
   ```

5. Optional: GitHub Action im Monorepo die `check-wasm-fresh.sh` auf Push laufen lässt

### Dateien
- `vaultcrdt/Cargo.toml`
- `vaultcrdt/Justfile`
- Neu: `vaultcrdt/scripts/build-wasm.sh`
- Neu: `vaultcrdt/scripts/check-wasm-fresh.sh`

### Aufwand: ~30 min

---

## Parallelisierungsmöglichkeiten

```
Item 6 (Auth)  ────────────►  fertig
                                        ─► Item 4 (Tombstone) Server ─► Plugin ─► fertig
Item 5 (WASM)  ────────────►  fertig
```

Items 5 und 6 haben null Code-Überlappung (verschiedene Repos). Können parallel in Worktrees oder Branches laufen. Item 4 danach, weil es das einzige Cross-Repo-Item ist.

---

## Zusammenfassung

| Item | Repo(s) | Aufwand | Kritisch für |
|------|---------|---------|-------------|
| 6 Auth-Härtung | Server | ~45 min | Public Release |
| 4 Tombstone-Härtung | Server + Plugin | ~60-90 min | Private Zuverlässigkeit |
| 5 WASM-Build | Monorepo | ~30 min | Wartbarkeit |

Nach dieser Session: alle 8 Audit-Punkte in der Roadmap adressiert (3 umgesetzt, 3 geplant, 2 bewusst aufgeschoben).
