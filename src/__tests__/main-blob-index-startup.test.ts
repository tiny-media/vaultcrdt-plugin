import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';

const spies = vi.hoisted(() => ({
  ready: vi.fn(), canonical: vi.fn(), loadJson: vi.fn(), saveJson: vi.fn(),
  notice: vi.fn(), order: [] as string[],
  handlers: vi.fn(), events: vi.fn(), layout: vi.fn(),
}));
vi.mock('obsidian', () => ({
  Plugin: class {
    registerObsidianProtocolHandler(name: string, handler: unknown) {
      spies.order.push(name); spies.handlers(name, handler);
    }
    addCommand() { spies.order.push('command'); }
    addSettingTab() {}
    addRibbonIcon() { return null; }
  },
  Platform: { isDesktop: false, isMobile: false },
  TFile: class {}, TFolder: class {}, MarkdownView: class {}, Modal: class {},
  Notice: class { constructor(...args: unknown[]) { spies.notice(...args); } },
  requestUrl: vi.fn(), apiVersion: 'test', normalizePath: (p: string) => p,
}));
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {}, HYDRATION_DEBOUNCE_MS: 2000 }));
vi.mock('../setup-modal', () => ({ SetupModal: class {} }));
vi.mock('../wasm-bridge', () => ({ createDocument: vi.fn(), initWasm: spies.ready }));
vi.mock('../../wasm/vaultcrdt_wasm', () => ({ blob_path_key: spies.canonical }));
vi.mock('../document-manager', () => ({ DocumentManager: class {} }));
vi.mock('../state-storage', () => ({ StateStorage: class {
  loadJson = spies.loadJson; saveJson = spies.saveJson;
  async existsRaw(name: string) { return name === 'blob-index.json'; }
  async readRaw(name: string) {
    if (name !== 'blob-index.json') return null;
    const value = await spies.loadJson(name);
    return value === null ? null : JSON.stringify(value);
  }
  async writeRaw() {}
} }));
vi.mock('../blob-uploader', () => ({ BlobUploader: class {
  constructor() { spies.order.push('uploader'); }
  async reconcilePendingDeletes(_networkReady: boolean) {}
} }));
vi.mock('../blob-downloader', () => ({ BlobDownloader: class {
  constructor() { spies.order.push('downloader'); }
} }));
vi.mock('../obsidian-sync', () => ({ ObsidianSync: class {
  constructor() { spies.order.push('categories'); }
} }));
import VaultCRDTPlugin from '../main';
import { WASM_INIT_FAILED_NOTICE, blobIndexRecoveryPausedMessage } from '../user-facing-copy';

const path = 'vcrdt-t-startup.png';
const candidate = { v: 1, maxSeq: 4, paths: { [path]: { key: path, hash: '' } } };
function setup() {
  const app = { workspace: { onLayoutReady: spies.layout }, vault: { adapter: {}, getAbstractFileByPath: () => null } };
  const plugin = new VaultCRDTPlugin(app as unknown as App, {} as PluginManifest);
  Object.assign(plugin, {
    app, loadSettings: vi.fn(async () => undefined), refreshInboxIndicators: vi.fn(),
    registerEditorAndVaultEvents: spies.events, syncObsidianRawListener: vi.fn(),
    setupStatusBar: vi.fn(),
  });
  return plugin;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  spies.order.length = 0;
  spies.loadJson.mockResolvedValue(candidate);
  spies.canonical.mockImplementation((p: string) => { spies.order.push('canonical'); return p; });
});

describe('main cold-start persisted index wiring (synthetic registration, not native dispatch)', () => {
  it.each(['saved', 'absent', 'quarantine-failed'])('poison notification persists and deduplicates on restart (%s)', async variant => {
    let inbox: unknown = null;
    spies.loadJson.mockImplementation(async name => name === 'inbox.json' ? inbox : variant === 'absent' ? null : { v: 0 });
    spies.saveJson.mockImplementation(async (name, value) => { if (name === 'inbox.json') inbox = value; });
    // Absent-main poisoning needs an invalid backup; quarantine failure must not claim a diagnostic.
    const { StateStorage } = await import('../state-storage');
    const read = vi.spyOn(StateStorage.prototype, 'readRaw');
    read.mockImplementation(async name => name === 'blob-index.json' && variant === 'absent' ? null : '{');
    const write = vi.spyOn(StateStorage.prototype, 'writeRaw');
    if (variant === 'quarantine-failed') write.mockRejectedValue(new Error('diagnostic denied'));
    const plugin = setup();
    await plugin.onload();
    expect(plugin.blobIndex.poisoned()).toBe(true);
    expect(plugin.inbox.list()).toHaveLength(1);
    expect(plugin.inbox.list()[0]).toMatchObject({ kind: 'blob-index-recovery', path: 'blob-index.json' });
    expect(plugin.inbox.list()[0].note).toContain(variant !== 'saved' ? 'see console' : 'saved diagnostic');
    await plugin.inbox.flush();
    const restarted = setup();
    await restarted.onload();
    expect(restarted.blobIndex.poisoned()).toBe(true);
    expect(restarted.inbox.list()).toHaveLength(1);
    expect(spies.notice).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(null);
    const outcome = await restarted.blobIndex.load();
    expect(outcome.outcome).toBe('poisoned');
    restarted.inbox.add({ kind: 'blob-index-recovery', path: 'blob-index.json',
      note: blobIndexRecoveryPausedMessage(outcome.quarantine ?? null) });
    restarted.inbox.scanExisting([]);
    restarted.inbox.onFileDeleted('blob-index.json');
    expect(restarted.inbox.list()).toHaveLength(1);
    expect(spies.notice).toHaveBeenCalledTimes(1);
    restarted.inbox.dismiss(restarted.inbox.list()[0].id);
    expect(restarted.blobIndex.poisoned()).toBe(true);
    await restarted.inbox.flush();
    plugin.blobIndex.dispose(); restarted.blobIndex.dispose();
    read.mockRestore(); write.mockRestore();
  });
  it('waits before canonical admission, consumers, both setup handlers, commands/events and layout scheduling', async () => {
    const gate = deferred();
    spies.ready.mockImplementation(() => gate.promise);
    const plugin = setup();
    const loading = plugin.onload();
    await vi.waitFor(() => expect(spies.ready).toHaveBeenCalledTimes(1));
    expect(spies.order).toEqual([]);
    expect(plugin.blobIndex.entries()).toEqual([]);
    expect(plugin.blobUploader).toBeUndefined();
    expect(plugin.blobDownloader).toBeUndefined();
    expect(plugin.obsidianSync).toBeUndefined();
    expect(spies.handlers).not.toHaveBeenCalled();
    expect(spies.events).not.toHaveBeenCalled();
    expect(spies.layout).not.toHaveBeenCalled();
    gate.resolve();
    await loading;
    expect(plugin.blobIndex.get(path)?.key).toBe(path);
    expect(spies.order.slice(0, 7)).toEqual([
      'canonical', 'uploader', 'downloader', 'categories',
      'vaultcrdt/setup', 'vaultcrdt-setup', 'command',
    ]);
    expect(spies.handlers).toHaveBeenCalledTimes(2);
    expect(spies.handlers.mock.calls[0][1]).toBe(spies.handlers.mock.calls[1][1]);
    expect(spies.events).toHaveBeenCalledTimes(1);
    expect(spies.layout).toHaveBeenCalledTimes(1);
    expect(spies.ready).toHaveBeenCalledTimes(1);
    expect(spies.notice).not.toHaveBeenCalled();
  });

  it('aborts on readiness failure with existing notice and no registrations/consumers/writes', async () => {
    const gate = deferred();
    spies.ready.mockImplementation(() => gate.promise);
    const plugin = setup();
    const failure = new Error('vcrdt-t-failure');
    const result = plugin.onload().then(() => undefined, (err: unknown) => err);
    await vi.waitFor(() => expect(spies.ready).toHaveBeenCalledTimes(1));
    gate.reject(failure);
    expect(await result).toBe(failure);
    expect(spies.order).toEqual([]);
    expect(plugin.blobIndex.entries()).toEqual([]);
    expect(plugin.blobUploader).toBeUndefined();
    expect(plugin.blobDownloader).toBeUndefined();
    expect(plugin.obsidianSync).toBeUndefined();
    expect(spies.handlers).not.toHaveBeenCalled();
    expect(spies.events).not.toHaveBeenCalled();
    expect(spies.layout).not.toHaveBeenCalled();
    expect(spies.saveJson.mock.calls.every(([name]) => name === 'inbox.json')).toBe(true);
    expect(spies.notice).toHaveBeenCalledExactlyOnceWith(WASM_INIT_FAILED_NOTICE, 0);
  });

  it.each([null, { v: 1, paths: {} }, { v: 1, paths: { [path]: { key: 3, hash: '' } } }])(
    'keeps candidate-free startup lazy: %j', async (raw) => {
      spies.loadJson.mockResolvedValue(raw);
      spies.ready.mockRejectedValue(new Error('must remain lazy'));
      await setup().onload();
      expect(spies.ready).not.toHaveBeenCalled();
      expect(spies.canonical).not.toHaveBeenCalled();
      expect(spies.order.slice(0, 6)).toEqual([
        'uploader', 'downloader', 'categories', 'vaultcrdt/setup', 'vaultcrdt-setup', 'command',
      ]);
      expect(spies.layout).toHaveBeenCalledTimes(1);
    },
  );
});
