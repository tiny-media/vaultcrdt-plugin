// The plugin uses window.setTimeout/setInterval (obsidianmd/prefer-window-timers)
// for popout-window compatibility. The vitest "node" environment has no window
// object, so tests get a minimal alias onto globalThis (timers only; there is
// deliberately no localStorage, matching the plugin's mobile fallback path).
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}

export {};
