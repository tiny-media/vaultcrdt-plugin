---
description: Regeln fuer den Rust-Workspace unter crates/
globs: crates/**, Cargo.toml, Cargo.lock, rust-toolchain.toml, rustfmt.toml, .cargo/config.toml
---

# Rust Crates (crates/vaultcrdt-{core,crdt,wasm})

## Invariants

- **Edition 2024**, **MSRV 1.94** — siehe `workspace.package` in `Cargo.toml`
- **`wasm-bindgen = "=0.2.117"`** exakt gepinnt — darf **niemals** ohne expliziten User-Auftrag bewegt werden. CLI-Version muss matchen, sonst meldet `bun run wasm:check` Drift
- Drei-Crate-Layout: `vaultcrdt-core` (shared types) → `vaultcrdt-crdt` (Loro wrapper + merge logic) → `vaultcrdt-wasm` (wasm-bindgen shell)
- Release-Profile in `.cargo/config.toml`: `opt-level = "z"`, `lto`, `strip` — nicht lockern ohne Grund
- Single user, kein Backwards-Compat — toter Code darf geloescht werden

## Code-Standards

- `cargo fmt --all` vor jedem Commit
- `cargo clippy --all-targets --workspace -- -D warnings` muss clean sein
- Kein `unwrap()` / `expect()` in Non-Test-Code ausser mit Kommentar *warum* es unmoeglich ist
- Fehler via `thiserror` an Crate-Grenzen, `Result<T, E>` durchreichen
- Keine `println!` / `eprintln!` im Library-Code (WASM-Targets haben kein Stdout)

## Nach Aenderungen an crates/

1. `cargo fmt` + `cargo clippy`
2. `cargo test --workspace`
3. `bun run wasm` um `wasm/` neu zu bauen (es wird sonst driften)
4. `bun run wasm:check` zur Verifikation
5. `bun run test` — Plugin-Tests laufen gegen die neuen WASM-Artefakte
6. Commit mit **beiden** Aenderungen (Rust + wasm/) im selben Commit oder direkt nacheinander

## Was NICHT tun

- `wasm/` manuell editieren
- `Cargo.lock` per Hand fixen (loeschen + `cargo build` ist erlaubt bei Konflikten)
- Neue Dependencies ohne Ruecksprache — das Release-Profil ist auf minimale WASM-Groesse optimiert
- `wasm-bindgen` upgraden ohne CLI-Version parallel zu aktualisieren
