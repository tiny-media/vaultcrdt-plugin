# Conflict-Storm Follow-up — Run Sheet

Pragmatischer Schritt-für-Schritt-Ablauf für die nächste Session. Ergänzt
`next-session-handoff.md` (Status-Story) und `gpt-audit/conflict-storm-follow-up-plan.md`
(definitiver Plan-Detail). Wenn etwas im Run-Sheet unklar ist → Plan lesen.

## Vor dem Start

```bash
git status
```

Erwartet (Auszug):
- modified: `CLAUDE.md`, `crates/vaultcrdt-crdt/src/document.rs`,
  `crates/vaultcrdt-wasm/src/lib.rs`, `main.js`, `next-session-handoff.md`,
  `src/__tests__/sync-engine.test.ts`, `src/document-manager.ts`,
  `src/main.ts`, `src/settings.ts`, `src/sync-engine.ts`, `src/sync-initial.ts`,
  `wasm/vaultcrdt_wasm_bg.wasm`
- untracked: `.claude/`, `.pi/`, `gpt-audit/conflict-storm-*.md`,
  `gpt-audit/delete-ack-*.md`, `dogfooding-checklist.md`,
  `gpt-audit/conflict-storm-follow-up-runsheet.md` (diese Datei)

```bash
grep -rn "0.2.117" CLAUDE.md .claude .pi | wc -l
```

Erwartet: > 0 (Pin-Edits aus voriger Session sind drin).

```bash
wasm-bindgen --version  # → 0.2.117
bun run wasm:check       # → OK
```

## Phase 1 — Pin-Aligning (Commit 1a + Commit 1b)

**Strategie**: Option B (zwei Commits, git-historisch sauber). Begründung im
Handoff. Wenn du anders entscheidest, brich hier ab.

### Commit 1a — vendor coding-agent tooling (mit altem 0.2.114-Stand)

```bash
# Pin-Edits temporär zurück auf 0.2.114
sed -i 's/0\.2\.117/0.2.114/g' \
  CLAUDE.md \
  .claude/rules/rust-crates.md \
  .claude/rules/wasm-build.md \
  .claude/agents/reviewer.md \
  .claude/commands/wasm.md \
  .claude/commands/commit.md \
  .claude/settings.json \
  .pi/SYSTEM.md \
  .pi/skills/wasm-rebuild/SKILL.md \
  .pi/skills/check/SKILL.md \
  .pi/skills/commit/SKILL.md \
  .pi/extensions/pi-ultrathink.ts

# Verify: nur historische gpt-audit-Files dürfen 0.2.117 noch enthalten
grep -rn "0.2.117" CLAUDE.md .claude .pi  # → leer
grep -rn "0.2.114" CLAUDE.md .claude .pi  # → 14 Treffer

# Stage NUR die Tooling-Files (NICHT die anderen modified Plugin-Files!)
git add CLAUDE.md .claude .pi

git status  # → nur tooling-Files staged, Rest unstaged

git commit -m "$(cat <<'EOF'
chore: vendor .claude/.pi coding-agent tooling

Brings the Claude Code and pi-coding-agent harnesses (settings, hooks,
slash commands, path-scoped rules, reviewer agent, skills, ultrathink
verify_plugin tool) under version control. CLAUDE.md gets a section
describing where these live.

This commit captures the tooling at the wasm-bindgen=0.2.114 pin that
predates the dep bump in fe6b88e. The pin-alignment to =0.2.117 follows
in the next commit so the diff stays focused.
EOF
)"
```

Wenn der Pre-commit-Hook drüber meckert (z.B. wegen `verify_plugin`-FAIL an
cargo-pin): das ist hier **erwartet** — Commit 1a soll bewusst mit dem alten
Pin-Stand reingehen. Hook bei Bedarf temporär durchlassen oder im Hook-Code
nachschauen ob es einen Skip-Mechanismus gibt. **NICHT** `--no-verify`.

### Commit 1b — align wasm-bindgen pin to 0.2.117

```bash
# Pin-Edits wieder forward
sed -i 's/0\.2\.114/0.2.117/g' \
  CLAUDE.md \
  .claude/rules/rust-crates.md \
  .claude/rules/wasm-build.md \
  .claude/agents/reviewer.md \
  .claude/commands/wasm.md \
  .claude/commands/commit.md \
  .claude/settings.json \
  .pi/SYSTEM.md \
  .pi/skills/wasm-rebuild/SKILL.md \
  .pi/skills/check/SKILL.md \
  .pi/skills/commit/SKILL.md \
  .pi/extensions/pi-ultrathink.ts

grep -rn "0.2.114" CLAUDE.md .claude .pi  # → leer
grep -rn "0.2.117" CLAUDE.md .claude .pi  # → 14 Treffer

git add CLAUDE.md .claude .pi

git commit -m "$(cat <<'EOF'
build: align wasm-bindgen pin to 0.2.117 across docs and tooling

Commit fe6b88e bumped wasm-bindgen 0.2.114 → 0.2.117 in Cargo.toml and
rebuilt wasm/. Rules, hooks, and verify_plugin weren't pulled along,
so verify_plugin reports FAIL on cargo-pin even though Cargo.toml +
wasm/ are consistent.

This syncs everything: path-scoped rules, agent + command prompts,
PostCompact hook, .pi system prompt + skills, and the PIN_VERSION
constant in pi-ultrathink.ts.
EOF
)"
```

Nach 1b sollte `verify_plugin` an `cargo-pin` grün sein.

## Phase 2 — TS-Härtung (Commit 2)

Reihenfolge bewusst klein → groß, jeder Schritt für sich kompilier- und testbar.

### 2.1 — PROBE-Konstanten (Task #3, P4 7.1)

`src/sync-initial.ts` am Datei-Kopf nach den Imports:

```ts
const PROBE_DOC_UUID = '__probe__';
const PROBE_PEER_ID = '__probe__';
```

Drei `createDocument('__probe__', '__probe__')`-Aufrufe (aktuell ~Zeile 317,
369, 408) ersetzen durch `createDocument(PROBE_DOC_UUID, PROBE_PEER_ID)`.

`bun run test` muss weiter grün sein.

### 2.2 — ensureDeviceIdentity Helper (Task #4, P2 5.1)

In `src/settings.ts` exportieren:

```ts
export function ensureDeviceIdentity(
  settings: VaultCRDTSettings,
  genPeerId: () => string = () => crypto.randomUUID(),
  genDeviceName: () => string = defaultDeviceName,
): boolean {
  let changed = false;
  if (!settings.peerId) {
    settings.peerId = genPeerId();
    changed = true;
  }
  if (!settings.deviceName) {
    settings.deviceName = genDeviceName();
    changed = true;
  }
  return changed;
}
```

Achtung: `defaultDeviceName` ist eine Funktion, also `defaultDeviceName` (nicht
`defaultDeviceName()`) als Default-Wert.

In `src/main.ts::loadSettings()` (aktuell Zeile ~270-279) die Inline-Logik
ersetzen durch:

```ts
import { ensureDeviceIdentity } from './settings';
// ...
if (ensureDeviceIdentity(this.settings)) {
  await this.saveSettings();
}
```

### 2.3 — Unit-Tests für ensureDeviceIdentity (Task #6, P2 5.2)

Neue Datei `src/__tests__/settings-identity.test.ts` mit den vier Pflichtfällen
aus Plan §5.2:
1. fills missing peerId and deviceName
2. does not overwrite existing values
3. returns false when nothing was missing
4. returns true when one or both fields were missing

Stub für `defaultDeviceName` über den optionalen 3. Parameter, kein
`obsidian`-Mock nötig.

### 2.4 — readEffectiveLocalContent + Editor-first (Task #5, P1)

In `src/sync-initial.ts`:

```ts
async function readEffectiveLocalContent(
  app: App,
  editor: EditorIntegration,
  file: TFile,
): Promise<string> {
  const fromEditor = editor.readCurrentContent(file.path);
  if (fromEditor !== null) return fromEditor;
  return await app.vault.read(file);
}
```

Verwendung an drei Stellen in `runInitialSync()`:

- **Priority sync** (~Zeile 132): `await app.vault.read(file)` →
  `await readEffectiveLocalContent(app, editor, file)`. Auch
  `contentHashes.set(activeDoc, fnv1aHash(localContent))` läuft auf dem
  effective Content
- **Overlapping loop** (~Zeilen 210, 229): beide `vault.read(file)`-Aufrufe
  ersetzen. Wichtig: auch im hash-skip-Pfad, damit der `diskHash`-Vergleich auf
  effectivem Content basiert (sonst falscher Skip)
- **Local-only loop** (~Zeile 241): `vault.read(file)` ersetzen — sonst geht
  ein offenes neues Doc mit ungespeicherten Edits als `doc_create` mit
  Disk-Snapshot raus

Belt-and-suspenders in `syncOverlappingDoc()` am Anfang:

```ts
const freshEditorContent = editor.readCurrentContent(path);
if (freshEditorContent !== null) {
  localContent = freshEditorContent;
}
```

`localContent` braucht `let` statt `const` dafür.

### 2.5 — Phase-2 sync_start uniqueness assert (Task #7, P2 5.3)

In `src/__tests__/sync-engine.test.ts` im bestehenden Test "missing local CRDT
+ same text → adopt server, no conflict, no resync" (~Zeile 1208) **vor** dem
Test-Ende ergänzen:

```ts
const syncStartCalls = mockEncode.mock.calls.filter(
  (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'state-lost.md'
);
expect(syncStartCalls.length).toBe(1);
expect(syncStartCalls[0][0].client_vv).toBeNull();
```

### 2.6 — Probe null/empty fall-through Test (Task #8, P2 5.4)

Neuer Test in `src/__tests__/sync-engine.test.ts`. Setup wie 2.5, aber das
`sync_delta` wird mit leerem `delta: new Uint8Array(0)` gefired. Erwartung:
- kein Conflict-File
- `sync_from_disk` darf in diesem Sonderfall **wieder** laufen
- ein normaler Push/Create-Pfad wird sichtbar (z.B. push-Aufruf)

### 2.7 — Stale-editor Regressionstests (Tasks #9, #10, #11)

Drei neue Tests, die `iterateAllLeaves` so mocken, dass `readCurrentContent`
einen frischen Editor-Text liefert, während `vault.read(file)` einen alten
Disk-Text liefert. Patterns:

**#9 (Phase 3, P3 6.1)** — Disjoint VV + Disk stale + Editor differs:
- `vault.read` → "alter text"
- `iterateAllLeaves` → MarkdownView mit `editor.getValue() = "neuer text"`
- Server: "alter text" mit disjunkter VV
- Erwartet: Conflict-File mit `body === "neuer text"` (Editor-Inhalt)

**#10 (Phase 2, P3 6.2)** — Missing local + Disk stale + Editor differs:
- gleiche Editor-Mock-Strategie
- `version()` → 0 (kein persisted state)
- Server liefert "alter text"
- Erwartet: Conflict-File mit `body === "neuer text"`

**#11 (local-only, P3 6.3)**:
- `getMarkdownFiles` → ein File
- `serverDocs` → leer
- Disk-Read alt, Editor frisch
- Erwartet: `sync_from_disk` mit Editor-Text, `pushDocCreate` aufgerufen

**#12 (optional, P3 6.4)** — non-active leaf preferred:
- `getActiveViewOfType` → null (nichts ist active)
- `iterateAllLeaves` → trotzdem ein MarkdownView mit dem path
- `readCurrentContent` muss trotzdem den Editor-Inhalt liefern (per
  iterateAllLeaves)
- Wenn der Mock-Setup das billig hergibt → mitnehmen, sonst skippen

### 2.8 — Verifikation

```bash
cargo fmt --all
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace
bun run wasm
bun run wasm:check
bun run test
bun run build
# verify_plugin (pi-coding-agent only — call wenn verfügbar)
```

Alle müssen grün sein. Wenn `bun run test` rot ist → fixen, nicht weiter.

### 2.9 — Commit 2

Geänderte Files:
- `src/sync-initial.ts` (PROBE-Konstanten, readEffectiveLocalContent,
  Verwendung an 4 Stellen, belt-and-suspenders)
- `src/settings.ts` (ensureDeviceIdentity export)
- `src/main.ts` (verwendet ensureDeviceIdentity)
- `src/__tests__/sync-engine.test.ts` (Phase-2 assert + neue Tests)
- `src/__tests__/settings-identity.test.ts` (neu)
- `main.js` (rebuild durch `bun run build`)

```bash
git add src main.js
git commit -m "$(cat <<'EOF'
fix(sync): use editor content for adopt decisions during initial sync

Phase 2 (missing local CRDT) and Phase 3 (disjoint VV) adopt decisions
previously used app.vault.read(file), which returns stale disk content
when an editor has unsaved changes. The conflict-file body would then
contain the wrong text.

Introduces readEffectiveLocalContent(app, editor, file) which prefers
editor.readCurrentContent(path) (iterates all leaves) and falls back to
vault.read. Used at all three initial-sync entry points (priority active
doc, overlapping loop incl. hash-skip path, local-only loop). Belt-and-
suspenders guard at the top of syncOverlappingDoc() too.

Also extracts ensureDeviceIdentity() from main.ts so the startup
invariant is unit-testable. Centralises the probe-doc marker strings as
PROBE_DOC_UUID / PROBE_PEER_ID constants.

Tests:
- settings-identity.test.ts: four cases covering the helper
- sync-engine.test.ts: explicit sync_start uniqueness assert for the
  Phase-2 path, fall-through-on-empty-probe test, and three regression
  tests for stale-disk-vs-fresh-editor (Phase 2, Phase 3, local-only).
EOF
)"
```

## Phase 3 — Handoff aktualisieren + Commit 3

Wenn alles grün ist:

```bash
# Handoff neu schreiben mit dem neuen Status
# (Conflict-Storm-Härtung + Follow-up beide kommittet, nächste Aufgabe = Deploy)
git add next-session-handoff.md
git commit -m "docs(handoff): close conflict-storm follow-up cycle"
```

Run-Sheet selbst danach optional aufräumen (`rm gpt-audit/conflict-storm-follow-up-runsheet.md`),
oder als Referenz für ähnliche Follow-ups stehen lassen.

## Wenn etwas schief geht

- **`bun run test` rot nach 2.4**: vermutlich Mock-Setup von `iterateAllLeaves`
  in den bestehenden Tests passt nicht zur Editor-first-Logik. Test-Setup
  prüfen — `editor.readCurrentContent(path)` muss in den meisten Tests `null`
  liefern (kein Editor offen), damit der Fallback auf `vault.read` greift.
- **Pre-commit-Hook bei 1a meckert**: cargo-pin-FAIL ist erwartet, weil 1a
  bewusst den alten Stand committet. NICHT `--no-verify`. Hook in
  `.claude/settings.json` oder `.pi/` nachschauen ob es einen Override gibt.
  Notfalls 1a und 1b zu einem Commit zusammenziehen (Option A).
- **`wasm:check` Drift nach 2.8**: nichts in `crates/` anfassen, nur
  `bun run wasm` neu, Diff anschauen. Drift bedeutet meistens Reproducibility-
  Bug, nicht eigene Schuld.
- **`grep -rn "0.2.114"` zeigt nach 1b noch Treffer in `gpt-audit/`**: das ist
  OK — historische Audit-Files sind frozen, nicht anfassen.
