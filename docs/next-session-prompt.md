# Next Session: S7 — Release & Polish

## Completed in S6

### Plugin (v0.2.0)
- [x] `package.json`: pinned `obsidian` to `^1.8.9`, version → 0.2.0
- [x] `tsconfig.json`: removed unused `outDir`
- [x] `wasm-bridge.ts`: fixed TS error — `createDocument()` now passes required `(docUuid, peerId)` to WASM constructor
- [x] `awareness-state.ts`: deleted (unused cursor tracking module)
- [x] Console logging: created `logger.ts` — `log()` gated behind debug flag, replaced all 38 console statements
- [x] Tests: +36 new tests (conflict-utils 17, promise-manager 6, document-manager 12, wasm-bridge +1) → 117 total
- [x] CI: added build size check (main.js < 3 MB)
- [x] CHANGELOG.md created (v0.1.0 + v0.2.0)
- [x] Version bumped: package.json, manifest.json, versions.json, settings.ts → 0.2.0

### Server (v0.2.0)
- [x] Mutex: replaced 4x `lock().unwrap()` with `lock().expect("...mutex poisoned")`
- [x] Idle timeout: 300s → 60s
- [x] Request size limit: 50 MB max WS message size
- [x] Pool size: configurable via `VAULTCRDT_POOL_SIZE` env var
- [x] `.env.example` created
- [x] CHANGELOG.md created (v0.1.0 + v0.2.0)
- [x] Version bumped: Cargo.toml → 0.2.0
- [x] README: added `VAULTCRDT_POOL_SIZE` to env var table, updated version

### Verification
- Plugin: 117 tests pass, 0 TS errors, build OK (2.3 MB)
- Server: 62 tests pass, 0 clippy warnings, format OK

---

## TODO for S7

### Git Tags + GitHub Releases
- [ ] Commit all changes in both repos
- [ ] Tag `v0.2.0` in both repos
- [ ] `gh release create v0.2.0` in plugin repo with `main.js` + `manifest.json` as assets
- [ ] `gh release create v0.2.0` in server repo (Docker image auto-built via `docker.yml` on tag push)

### Optional Polish
- [ ] Push-handler + editor-integration tests (MEDIUM priority from S6, deferred)
- [ ] CONTRIBUTING.md for both repos
- [ ] Plugin: expose debug logging toggle in settings UI
- [ ] Server: docker-compose.yml — replace hardcoded secrets with env_file reference

## Repos
- **Plugin:** `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin)
- **Server:** `/home/richard/projects/vaultcrdt-server/` (GitHub: tiny-media/vaultcrdt-server)

## SSH-Hinweis
`SSH_AUTH_SOCK` zeigt auf 1Password Agent (`~/.1password/agent.sock`), konfiguriert in `~/.zshrc`.
