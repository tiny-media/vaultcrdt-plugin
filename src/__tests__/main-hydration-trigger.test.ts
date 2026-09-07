import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { platform } = vi.hoisted(() => ({ platform: { isDesktop: true, isMobile: true } }));
vi.mock('obsidian', () => ({
  Plugin: class {
    registerEvent() {}
    registerObsidianProtocolHandler() {}
    addCommand() {}
    addSettingTab() {}
    addRibbonIcon() { return { toggleClass() {} }; }
    addStatusBarItem() { return { addClass() {} }; }
  },
  Platform: platform,
  TFile: class { path = 'note.md'; },
  TFolder: class {},
  MarkdownView: class {},
  Notice: class {},
  Modal: class {},
  requestUrl: vi.fn(),
  apiVersion: 'test',
  normalizePath: (p: string) => p,
}));
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {} }));
vi.mock('../setup-modal', () => ({ SetupModal: class {} }));
vi.mock('../wasm-bridge', () => ({ createDocument: vi.fn(), initWasm: vi.fn() }));
vi.mock('../document-manager', () => ({ DocumentManager: class {} }));

import VaultCRDTPlugin from '../main';
import { TFile } from 'obsidian';

function file(path: string): TFile {
  const f = new TFile();
  f.path = path;
  return f;
}

/**
 * Wires only registerEditorAndVaultEvents (no onload): the scheduler and the
 * metadataCache gate are the unit under test.
 */
function setup(opts: { isMobile?: boolean; initialized?: boolean } = {}) {
  platform.isMobile = opts.isMobile ?? true;
  const metaHandlers: Array<(f: TFile) => void> = [];
  let active: TFile | null = file('note.md');
  const app = {
    vault: { on: vi.fn() },
    workspace: {
      on: vi.fn(),
      getActiveFile: () => active,
    },
    metadataCache: {
      on: vi.fn((event: string, handler: (f: TFile) => void) => {
        if (event === 'changed') metaHandlers.push(handler);
      }),
    },
  } as any;
  const hydrateForOpenFile = vi.fn().mockResolvedValue(undefined);
  const plugin = new VaultCRDTPlugin(app, {} as any);
  Object.assign(plugin, {
    app,
    syncEngineInitialized: opts.initialized ?? true,
    blobDownloader: { hydrateForOpenFile },
    syncEngine: { stop: async () => undefined },
  });
  (plugin as any).registerEditorAndVaultEvents();
  const changed = (f: TFile) => { for (const h of metaHandlers) h(f); };
  return {
    plugin, hydrateForOpenFile, changed,
    setActive: (f: TFile | null) => { active = f; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('mobile metadata-cache hydration trigger', () => {
  it('bursts of changed-events on the active note produce exactly one pass', () => {
    const { hydrateForOpenFile, changed } = setup();
    const note = file('note.md');
    changed(note); changed(note); changed(note);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hydrateForOpenFile).toHaveBeenCalledTimes(1);
    expect(hydrateForOpenFile.mock.calls[0][0].path).toBe('note.md');
  });

  it('changed-events for non-active files are ignored', () => {
    const { hydrateForOpenFile, changed } = setup();
    changed(file('other.md'));
    vi.advanceTimersByTime(5000);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
  });

  it('a file switch replaces the pending target', () => {
    const { hydrateForOpenFile, changed, setActive } = setup();
    changed(file('note.md'));
    vi.advanceTimersByTime(1000);
    const next = file('second.md');
    setActive(next);
    changed(next);
    vi.advanceTimersByTime(2000);
    expect(hydrateForOpenFile).toHaveBeenCalledTimes(1);
    expect(hydrateForOpenFile.mock.calls[0][0].path).toBe('second.md');
  });

  it('unload cancels the pending pass', () => {
    const { plugin, hydrateForOpenFile, changed } = setup();
    changed(file('note.md'));
    plugin.onunload();
    vi.advanceTimersByTime(5000);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
  });

  it('does nothing before the sync engine is initialized', () => {
    const { hydrateForOpenFile, changed } = setup({ initialized: false });
    changed(file('note.md'));
    vi.advanceTimersByTime(5000);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
  });

  it('desktop invariance: no hydration pass is scheduled', () => {
    const { hydrateForOpenFile, changed } = setup({ isMobile: false });
    changed(file('note.md'));
    vi.advanceTimersByTime(5000);
    expect(hydrateForOpenFile).not.toHaveBeenCalled();
  });
});
