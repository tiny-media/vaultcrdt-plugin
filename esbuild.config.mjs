import esbuild from 'esbuild';
import fs from 'node:fs';
import zlib from 'node:zlib';

const watch = process.argv.includes('--watch');

// The wasm module is embedded in main.js as gzip+base64. Obsidian's community
// store and BRAT install only main.js, manifest.json and styles.css — a
// sibling .wasm file is never delivered, so inlining is the only distributable
// shape. gzip first: base64 of the raw module costs +33 % on a 2.1 MB binary,
// base64 of the gzipped module costs ~0.89 MB instead of ~2.83 MB.
// Level 9 is deterministic for a given runtime; nothing compares these bytes
// across machines (scripts/check-wasm-fresh.sh guards wasm/ itself).
const wasmBytes = fs.readFileSync('wasm/vaultcrdt_wasm_bg.wasm');
const wasmGzB64 = zlib.gzipSync(wasmBytes, { level: 9 }).toString('base64');
console.log(
  `wasm ${wasmBytes.length} B -> gzip+base64 ${wasmGzB64.length} B ` +
    `(${((wasmGzB64.length / wasmBytes.length) * 100).toFixed(1)} % of raw)`,
);

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  // es2020: native BigInt literals + import.meta. Obsidian 1.12+ runtimes
  // (Electron desktop, iOS WKWebView, Android WebView) all support es2020.
  target: 'es2020',
  minify: true,
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  define: {
    __VAULTCRDT_WASM_GZ_B64__: JSON.stringify(wasmGzB64),
  },
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
