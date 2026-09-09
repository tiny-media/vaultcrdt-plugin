import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Plugin: class {
    registerEvent() {}
    registerObsidianProtocolHandler() {}
    addCommand() {}
    addSettingTab() {}
    addRibbonIcon() { return { toggleClass() {} }; }
    addStatusBarItem() { return { addClass() {} }; }
  },
  Platform: { isDesktop: false },
  TFile: class { path = 'window.md'; },
  TFolder: class {},
  MarkdownView: class {},
  Notice: class {},
  Modal: class {},
  requestUrl: vi.fn(),
  apiVersion: 'test',
  normalizePath: (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, ''),
}));
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {}, HYDRATION_DEBOUNCE_MS: 2000 }));
vi.mock('../setup-modal', () => ({ SetupModal: class {} }));
vi.mock('../wasm-bridge', () => ({ createDocument: vi.fn(), initWasm: vi.fn() }));
vi.mock('../document-manager', () => ({ DocumentManager: class {} }));

import VaultCRDTPlugin from '../main';
import { SyncEngine } from '../sync-engine';
import { TFile } from 'obsidian';
import { FEATURE_BLOBS } from '../server-features';
import { PROTOCOL_VERSION } from '../protocol';
import type { BlobIndexEntry } from '../blob-index';

function fileAt(path: string): TFile {
  const f = new TFile();
  f.path = path;
  return f;
}

function setIndexEntry(plugin: VaultCRDTPlugin, path: string, entry: Partial<BlobIndexEntry>): void {
  (plugin.blobIndex as any).file.paths[path] = {
    key: `key:${path}`,
    hash: '',
    size: 0,
    generation: 0,
    seq: 0,
    hydrated: true,
    lastRemoteHash: '',
    ...entry,
  };
}

async function setup() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const app = {
    vault: {
      adapter: { exists: vi.fn(async () => false) }, // Raw index storage: fresh install.
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      read: vi.fn().mockResolvedValue(''),
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
      getFiles: vi.fn().mockReturnValue([]),
    },
    fileManager: {
      trashFile: vi.fn().mockResolvedValue(undefined),
    },
    workspace: {
      on: vi.fn(),
      onLayoutReady: vi.fn(),
      iterateAllLeaves: vi.fn(),
    },
    metadataCache: { getFileCache: vi.fn().mockReturnValue(null), on: vi.fn() },
  } as any;
  const engine = new SyncEngine(app, { vaultId: 'test', peerId: 'test' } as any);
  const plugin = new VaultCRDTPlugin(app, {} as any);
  Object.assign(plugin, {
    app,
    syncEngine: engine,
    syncEngineInitialized: true,
    settings: { serverUrl: 'https://s.example.com', peerId: 'p', vaultId: 'v' },
  });
  vi.spyOn(plugin, 'loadSettings').mockResolvedValue();
  vi.spyOn(plugin, 'updateStatusBar').mockImplementation(() => {});
  vi.spyOn(plugin, 'addCommand').mockImplementation((c: any) => c);
  (engine as any).acceptVaultChangeEvents = true;
  await plugin.onload();
  return { engine, app, handlers, plugin };
}

describe('backfillAttachments', () => {
  it('checks poison before listing or enqueueing attachments', async () => {
    const { plugin, app } = await setup();
    vi.spyOn(plugin.blobIndex, 'poisoned').mockReturnValue(true);
    const enqueue = vi.spyOn(plugin.blobUploader, 'onFileChanged');
    const enabled = vi.spyOn(plugin, 'blobsEnabled');
    await plugin.backfillAttachments();
    expect(enabled).not.toHaveBeenCalled();
    expect(app.vault.getFiles).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('enqueues only attachments when the index is empty, and none when blobs are off', async () => {
    const { plugin, app } = await setup();
    app.vault.getFiles.mockReturnValue([
      { path: 'Bilder/a.png' },
      { path: 'Bilder/b.jpg' },
      { path: 'Bilder/c.webp' },
      { path: 'note.md' },
      { path: 'other.md' },
    ]);
    const changed = vi.spyOn(plugin.blobUploader, 'onFileChanged').mockImplementation(() => {});
    const features = vi.spyOn(plugin.serverFeatures, 'get');
    features.mockResolvedValue([FEATURE_BLOBS]);

    await (plugin as any).backfillAttachments();
    expect(changed.mock.calls.map((c) => c[0]).sort()).toEqual([
      'Bilder/a.png',
      'Bilder/b.jpg',
      'Bilder/c.webp',
    ]);

    changed.mockClear();
    features.mockResolvedValue([]);
    await (plugin as any).backfillAttachments();
    expect(changed).not.toHaveBeenCalled();
  });

  it('triggers only missing and skipped:true entries, never hydrated:false', async () => {
    const { plugin, app } = await setup();
    const healthy = 'Bilder/healthy.png';
    const skipped = 'Bilder/skipped.png';
    const missing = 'Bilder/missing.png';
    const remoteNewer = 'Bilder/remote.png';
    app.vault.getFiles.mockReturnValue(
      [healthy, skipped, missing, remoteNewer].map((path) => ({ path })),
    );
    setIndexEntry(plugin, healthy, { hash: 'local', skipped: false });
    setIndexEntry(plugin, skipped, { skipped: true });
    setIndexEntry(plugin, remoteNewer, { hash: 'remote-hash', hydrated: false });
    vi.spyOn(plugin.serverFeatures, 'get').mockResolvedValue([FEATURE_BLOBS]);
    const changed = vi.spyOn(plugin.blobUploader, 'onFileChanged').mockImplementation(() => {});

    await (plugin as any).backfillAttachments();
    expect(changed.mock.calls.map((c) => c[0]).sort()).toEqual([missing, skipped]);
  });
});

describe('blob lane protocol gate (#7)', () => {
  it('enables the lane on a matching version and disables it on a mismatch', async () => {
    const { plugin } = await setup();
    vi.spyOn(plugin.serverFeatures, 'get').mockResolvedValue([FEATURE_BLOBS]);
    const version = vi.spyOn(plugin.serverFeatures, 'protocolVersion');

    version.mockReturnValue(PROTOCOL_VERSION);
    expect(await (plugin as any).blobsEnabled()).toBe(true);

    version.mockReturnValue(PROTOCOL_VERSION + 1);
    expect(await (plugin as any).blobsEnabled()).toBe(false);

    // Absent field (older/offline server): the flags decide.
    version.mockReturnValue(undefined);
    expect(await (plugin as any).blobsEnabled()).toBe(true);
  });

  it('blocks download hydration on a version mismatch', async () => {
    const { plugin } = await setup();
    vi.spyOn(plugin.serverFeatures, 'get').mockResolvedValue([FEATURE_BLOBS]);
    vi.spyOn(plugin.serverFeatures, 'protocolVersion').mockReturnValue(PROTOCOL_VERSION + 1);
    const one = vi.spyOn(plugin.blobDownloader as any, 'hydrateOne');
    await plugin.blobDownloader.hydratePending();
    expect(one).not.toHaveBeenCalled();
  });
});

describe('attachment rename routing', () => {
  it('routes a new attachment path to the blob uploader, not the md branch', async () => {
    const { plugin, engine, handlers } = await setup();
    const changed = vi.spyOn(plugin.blobUploader, 'onFileChanged').mockImplementation(() => {});
    const renamed = vi.spyOn(engine, 'onFileRenamed').mockImplementation(() => {});
    const deletedOnly = vi.spyOn(engine, 'onFileDeletedOnly').mockImplementation(() => {});
    const push = vi.spyOn(engine, 'onFileChangedImmediate').mockImplementation(() => {});

    await handlers.get('rename')!(fileAt('Bilder/photo.png'), 'note.md');

    expect(changed).toHaveBeenCalledExactlyOnceWith('Bilder/photo.png');
    expect(renamed).not.toHaveBeenCalled();
    expect(deletedOnly).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('routes attachment-to-attachment rename to onFileRenamed', async () => {
    const { plugin, engine, handlers } = await setup();
    const blobRenamed = vi.spyOn(plugin.blobUploader, 'onFileRenamed').mockResolvedValue(undefined);
    const changed = vi.spyOn(plugin.blobUploader, 'onFileChanged').mockImplementation(() => {});
    const renamed = vi.spyOn(engine, 'onFileRenamed').mockImplementation(() => {});

    await handlers.get('rename')!(fileAt('Bilder/renamed.png'), 'Bilder/photo.png');

    expect(blobRenamed).toHaveBeenCalledExactlyOnceWith('Bilder/photo.png', 'Bilder/renamed.png');
    expect(changed).not.toHaveBeenCalled();
    expect(renamed).not.toHaveBeenCalled();
  });

  it('routes attachment delete to the blob uploader, not the md branch', async () => {
    const { plugin, engine, handlers } = await setup();
    const blobDeleted = vi.spyOn(plugin.blobUploader, 'onFileDeleted').mockResolvedValue(undefined);
    const deleted = vi.spyOn(engine, 'onFileDeleted').mockImplementation(() => {});

    await handlers.get('delete')!(fileAt('Bilder/photo.png'));

    expect(blobDeleted).toHaveBeenCalledExactlyOnceWith('Bilder/photo.png');
    expect(deleted).not.toHaveBeenCalled();
  });

  it('registers a file-open hook for mobile lazy hydration', async () => {
    const { app } = await setup();
    expect(app.workspace.on).toHaveBeenCalledWith('file-open', expect.any(Function));
  });
});
