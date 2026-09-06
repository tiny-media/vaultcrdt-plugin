import esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  // es2020: native BigInt literals + import.meta. Obsidian 1.12+ runtimes
  // (Electron desktop, iOS WKWebView, Android WebView) all support es2020.
  target: 'es2020',
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  logLevel: 'info',
});

if (watch) {
  fs.copyFileSync('wasm/vaultcrdt_wasm_bg.wasm', 'vaultcrdt_wasm_bg.wasm');
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  // The wasm ships as a sibling file next to main.js (loaded at runtime via
  // adapter.readBinary), not inlined into the bundle.
  fs.copyFileSync('wasm/vaultcrdt_wasm_bg.wasm', 'vaultcrdt_wasm_bg.wasm');
}
