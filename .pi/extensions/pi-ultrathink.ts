import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

/**
 * pi-ultrathink (vaultcrdt-plugin edition)
 *
 * Sets a status indicator before tool calls (when thinking level is high/xhigh)
 * and provides `verify_plugin` — a repo-aware invariant checker tailored to the
 * Rust + TypeScript hybrid:
 *
 *  - wasm/ freshness (via scripts/check-wasm-fresh.sh)
 *  - wasm-bindgen pin in Cargo.toml == =0.2.117
 *  - version sync between package.json, manifest.json, versions.json
 *  - emoji guard in src/, crates/, docs/, README.md, CLAUDE.md
 *  - forbidden `bun test` invocations (must be `bun run test`)
 *
 * Call after non-trivial changes and before `/commit`.
 */

const PIN_VERSION = "0.2.117";

// Emoji range — rough but catches the usual suspects.
// Covers emoticons, symbols, pictographs, transport, flags, misc symbols.
const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{1F600}-\u{1F64F}]/u;

interface Finding {
  level: "FAIL" | "WARN" | "OK";
  check: string;
  detail: string;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const level = (ctx as any).settings?.defaultThinkingLevel;
    if (level !== "high" && level !== "xhigh") return;
    ctx.ui.setStatus(
      "ultrathink",
      `Ultrathink: Checking ${event.toolName}...`,
    );
  });

  pi.registerTool({
    name: "verify_plugin",
    label: "vaultcrdt-plugin Verify",
    description:
      "Prueft vaultcrdt-plugin Invariants: WASM-Freshness gegen crates/, wasm-bindgen Version-Pin (=0.2.117), Versions-Sync (package.json/manifest.json/versions.json), Emoji-Guard in src/crates/docs, und verbotene `bun test`-Aufrufe. Liefert FAIL/WARN/OK pro Check. Nach groesseren Aenderungen und vor /commit aufrufen.",
    parameters: Type.Object({
      skipWasm: Type.Optional(
        Type.Boolean({
          description:
            "WASM-Freshness-Check ueberspringen (nur wenn sicher dass keine crates/-Aenderung relevant ist)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const root = process.cwd();
      const findings: Finding[] = [];

      findings.push(...checkCargoPin(root));
      findings.push(...checkVersionsSync(root));
      if (!params.skipWasm) findings.push(...checkWasmFresh(root));
      findings.push(...checkEmojis(root));
      findings.push(...checkBunTestMisuse(root));

      const fails = findings.filter((f) => f.level === "FAIL").length;
      const warns = findings.filter((f) => f.level === "WARN").length;
      const oks = findings.filter((f) => f.level === "OK").length;

      const lines = findings.map(
        (f) => `${f.level.padEnd(4)} ${f.check}: ${f.detail}`,
      );
      const summary = `Summary: ${fails} FAIL, ${warns} WARN, ${oks} OK`;

      return {
        content: [
          {
            type: "text" as const,
            text: [summary, "", ...lines].join("\n"),
          },
        ],
        details: { fails, warns, oks },
      };
    },
  });
}

// ---- checks --------------------------------------------------------------

function checkCargoPin(root: string): Finding[] {
  const path = join(root, "Cargo.toml");
  if (!existsSync(path))
    return [{ level: "WARN", check: "cargo-pin", detail: "Cargo.toml fehlt" }];
  const content = safeRead(path);
  if (content === null)
    return [
      { level: "FAIL", check: "cargo-pin", detail: "Cargo.toml unlesbar" },
    ];
  const m = content.match(/wasm-bindgen\s*=\s*"(=?)([^"]+)"/);
  if (!m)
    return [
      {
        level: "FAIL",
        check: "cargo-pin",
        detail: "wasm-bindgen nicht in Cargo.toml workspace.dependencies",
      },
    ];
  const [, eq, ver] = m;
  if (eq !== "=")
    return [
      {
        level: "FAIL",
        check: "cargo-pin",
        detail: `wasm-bindgen nicht exakt gepinnt (= fehlt): "${ver}"`,
      },
    ];
  if (ver !== PIN_VERSION)
    return [
      {
        level: "FAIL",
        check: "cargo-pin",
        detail: `wasm-bindgen pin ist ${ver}, erwartet ${PIN_VERSION}`,
      },
    ];
  return [{ level: "OK", check: "cargo-pin", detail: `=${PIN_VERSION}` }];
}

function checkVersionsSync(root: string): Finding[] {
  const pkgPath = join(root, "package.json");
  const manifestPath = join(root, "manifest.json");
  const versionsPath = join(root, "versions.json");

  const pkg = safeJson<{ version?: string }>(pkgPath);
  const manifest = safeJson<{ version?: string; minAppVersion?: string }>(
    manifestPath,
  );
  const versions = safeJson<Record<string, string>>(versionsPath);

  const out: Finding[] = [];
  if (!pkg?.version)
    out.push({
      level: "FAIL",
      check: "version-sync",
      detail: "package.json version fehlt",
    });
  if (!manifest?.version)
    out.push({
      level: "FAIL",
      check: "version-sync",
      detail: "manifest.json version fehlt",
    });
  if (pkg?.version && manifest?.version && pkg.version !== manifest.version) {
    out.push({
      level: "FAIL",
      check: "version-sync",
      detail: `package.json (${pkg.version}) != manifest.json (${manifest.version})`,
    });
  }
  if (manifest?.version && versions && !versions[manifest.version]) {
    out.push({
      level: "WARN",
      check: "version-sync",
      detail: `versions.json hat keinen Eintrag fuer ${manifest.version} (minAppVersion-Mapping)`,
    });
  }
  if (out.length === 0 && pkg?.version) {
    out.push({
      level: "OK",
      check: "version-sync",
      detail: `all at ${pkg.version}`,
    });
  }
  return out;
}

function checkWasmFresh(root: string): Finding[] {
  const script = join(root, "scripts", "check-wasm-fresh.sh");
  if (!existsSync(script))
    return [
      {
        level: "WARN",
        check: "wasm-fresh",
        detail: "scripts/check-wasm-fresh.sh fehlt",
      },
    ];
  try {
    execSync("./scripts/check-wasm-fresh.sh", {
      cwd: root,
      stdio: "pipe",
      timeout: 120_000,
    });
    return [
      { level: "OK", check: "wasm-fresh", detail: "committed wasm/ ist frisch" },
    ];
  } catch (e: any) {
    const stderr = (e.stderr?.toString?.() ?? "").trim();
    const stdout = (e.stdout?.toString?.() ?? "").trim();
    const msg = [stderr, stdout].filter(Boolean).join(" | ").slice(0, 300);
    return [
      {
        level: "FAIL",
        check: "wasm-fresh",
        detail: `Drift oder Build-Fehler: ${msg || "unknown"}`,
      },
    ];
  }
}

function checkEmojis(root: string): Finding[] {
  const roots = [
    { dir: "src", exts: [".ts", ".tsx", ".js", ".mjs"] },
    { dir: "crates", exts: [".rs", ".toml"] },
    { dir: "docs", exts: [".md"] },
    { dir: "gpt-audit", exts: [".md"] },
  ];
  const topLevel = ["CLAUDE.md", "README.md", "next-session-handoff.md"];

  const offenders: string[] = [];

  for (const { dir, exts } of roots) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    walk(absDir, (file) => {
      if (!exts.some((e) => file.endsWith(e))) return;
      const content = safeRead(file);
      if (content && EMOJI_RE.test(content)) {
        offenders.push(relative(root, file));
      }
    });
  }
  for (const f of topLevel) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    const content = safeRead(abs);
    if (content && EMOJI_RE.test(content)) offenders.push(f);
  }

  if (offenders.length === 0)
    return [{ level: "OK", check: "emoji-guard", detail: "keine Emojis" }];
  return [
    {
      level: "FAIL",
      check: "emoji-guard",
      detail: `Emojis in: ${offenders.slice(0, 10).join(", ")}${
        offenders.length > 10 ? ` (+${offenders.length - 10} mehr)` : ""
      }`,
    },
  ];
}

function checkBunTestMisuse(root: string): Finding[] {
  // Suche nach `bun test` ohne `run` in package.json scripts, .md docs, und shell scripts
  const files: string[] = [];
  const add = (p: string) => existsSync(p) && files.push(p);
  add(join(root, "package.json"));
  add(join(root, "README.md"));
  add(join(root, "CLAUDE.md"));
  add(join(root, "next-session-handoff.md"));

  for (const dir of ["scripts", "docs", ".claude", ".pi", "gpt-audit"]) {
    const absDir = join(root, dir);
    if (!existsSync(absDir)) continue;
    walk(absDir, (file) => {
      if (file.endsWith(".md") || file.endsWith(".sh") || file.endsWith(".json")) {
        files.push(file);
      }
    });
  }

  // `bun test` that is NOT preceded by `run ` and NOT `bun test:...` nor `bun run test`
  const bad = /(^|[^\w])bun test(?![:\w])/;
  const offenders: string[] = [];

  for (const f of files) {
    const content = safeRead(f);
    if (!content) continue;
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (bad.test(line) && !/bun run test/.test(line)) {
        // Ignore if it's describing the pitfall itself (contains NOT/NIEMALS/NEVER)
        if (/NIEMALS|NOT|NEVER|nicht|NICHT/.test(line)) return;
        offenders.push(`${relative(root, f)}:${i + 1}`);
      }
    });
  }

  if (offenders.length === 0)
    return [
      {
        level: "OK",
        check: "bun-test-misuse",
        detail: "keine `bun test`-Aufrufe (nur `bun run test`)",
      },
    ];
  return [
    {
      level: "FAIL",
      check: "bun-test-misuse",
      detail: `verbotene \`bun test\`-Aufrufe: ${offenders
        .slice(0, 10)
        .join(", ")}${offenders.length > 10 ? ` (+${offenders.length - 10})` : ""}`,
    },
  ];
}

// ---- helpers -------------------------------------------------------------

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeJson<T>(path: string): T | null {
  const content = safeRead(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function walk(dir: string, visit: (file: string) => void) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "target" || name === ".git") continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, visit);
    else if (st.isFile()) visit(abs);
  }
}
