import esbuild from 'esbuild';

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
  loader: { '.wasm': 'binary' },
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
