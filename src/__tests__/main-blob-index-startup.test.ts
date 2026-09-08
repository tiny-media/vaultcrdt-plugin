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
vi.mock('../inbox', () => ({ Inbox: class { async load() {} } }));
vi.mock('../state-storage', () => ({ StateStorage: class {
  loadJson = spies.loadJson; saveJson = spies.saveJson;
} }));
vi.mock('../blob-uploader', () => ({ BlobUploader: class {
  constructor() { spies.order.push('uploader'); }
} }));
vi.mock('../blob-downloader', () => ({ BlobDownloader: class {
  constructor() { spies.order.push('downloader'); }
} }));
vi.mock('../obsidian-sync', () => ({ ObsidianSync: class {
  constructor() { spies.order.push('categories'); }
} }));
import VaultCRDTPlugin from '../main';
import { WASM_INIT_FAILED_NOTICE } from '../user-facing-copy';

const path = 'vcrdt-t-startup.png';
const candidate = { v: 1, maxSeq: 4, paths: { [path]: { key: path, hash: '' } } };
function setup() {
  const app = { workspace: { onLayoutReady: spies.layout }, vault: { adapter: {} } };
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
    expect(spies.saveJson).not.toHaveBeenCalled();
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
