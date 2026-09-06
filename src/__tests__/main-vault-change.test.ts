import { describe, it, expect, vi, afterEach } from 'vitest';

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
}));
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {} }));
vi.mock('../setup-modal', () => ({ SetupModal: class {} }));
vi.mock('../wasm-bridge', () => ({ createDocument: vi.fn(), initWasm: vi.fn() }));
vi.mock('../document-manager', () => ({ DocumentManager: class {} }));

import VaultCRDTPlugin from '../main';
import { SyncEngine } from '../sync-engine';
import { TFile } from 'obsidian';
import { fnv1aHash64 } from '../conflict-utils';
import { PANEL_COPY } from '../user-facing-copy';

async function setup(content: string) {
  const handlers = new Map<string, (file: TFile) => Promise<void>>();
  const app = {
    vault: {
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      read: vi.fn().mockResolvedValue(content),
      getAbstractFileByPath: vi.fn().mockReturnValue(null),
    },
    fileManager: {
      trashFile: vi.fn().mockResolvedValue(undefined),
    },
    workspace: {
      on: vi.fn(),
      onLayoutReady: vi.fn(),
      iterateAllLeaves: vi.fn(),
    },
  } as any;
  const engine = new SyncEngine(app, { vaultId: 'test', peerId: 'test' } as any);
  const plugin = new VaultCRDTPlugin(app, {} as any);
  Object.assign(plugin, { app, syncEngine: engine, syncEngineInitialized: true });
  vi.spyOn(plugin, 'loadSettings').mockResolvedValue();
  vi.spyOn(plugin, 'updateStatusBar').mockImplementation(() => {});
  const push = vi.spyOn(engine, 'onFileChangedImmediate').mockImplementation(() => {});
  const commands: Array<{ id: string; name: string; icon?: string; callback?: () => void }> = [];
  vi.spyOn(plugin, 'addCommand').mockImplementation((c: any) => { commands.push(c); return c; });
  (engine as any).acceptVaultChangeEvents = true;
  // The real EditorIntegration holds these shared collections (same seam as
  // sync-engine.test.ts's remote-write guard tests), not a mocked decision.
  const editor = (engine as any).editor;
  editor.writingFromRemote.add('window.md');
  editor.lastRemoteWrite.set('window.md', fnv1aHash64('remote content'));
  await plugin.onload();
  return { engine, push, app, handlers, editor, plugin, commands };
}

describe('mobile command registration', () => {
  // Phones render no ribbon and no status bar, so panel + inbox must exist as
  // commands (palette / pinnable toolbar) with an icon.
  it('registers open-status-panel and open-inbox with icons and working callbacks', async () => {
    const { plugin, commands } = await setup('');
    const panel = commands.find(c => c.id === 'open-status-panel');
    const inbox = commands.find(c => c.id === 'open-inbox');
    expect(panel).toMatchObject({ name: PANEL_COPY.command, icon: 'refresh-cw' });
    expect(inbox).toMatchObject({ name: PANEL_COPY.inboxCommand, icon: 'inbox' });
    const openPanel = vi.spyOn(plugin, 'openStatusPanel').mockImplementation(() => {});
    const openInbox = vi.spyOn(plugin, 'openInbox').mockImplementation(() => {});
    panel!.callback!();
    inbox!.callback!();
    expect(openPanel).toHaveBeenCalledOnce();
    expect(openInbox).toHaveBeenCalledOnce();
  });
});

describe('vault delete remote-write window', () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])('rechecks disk existence (exists=%s)', async (exists) => {
    vi.useFakeTimers();
    const { engine, handlers, app, editor } = await setup('remote content');
    const deleted = vi.spyOn(engine, 'onFileDeleted').mockImplementation(() => {});
    await handlers.get('delete')!(new TFile());
    expect(deleted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    editor.writingFromRemote.clear();
    app.vault.getAbstractFileByPath.mockReturnValue(exists ? new TFile() : null);
    vi.advanceTimersByTime(100);
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledExactlyOnceWith('window.md');
    if (exists) {
      expect(deleted).not.toHaveBeenCalled();
      expect(engine.getStartupTraceReport()).toContain('vault-change.delete-echo-dropped | path=window.md');
    } else {
      expect(deleted).toHaveBeenCalledExactlyOnceWith('window.md');
    }
  });

  it.each(['live', 'initial'])('suppresses the %s remote trash echo, including an overlapping write window', async (source) => {
    vi.useFakeTimers();
    const { engine, handlers, app } = await setup('');
    const file = new TFile();
    const deleted = vi.spyOn(engine, 'onFileDeleted').mockImplementation(() => {});
    Object.assign((engine as any).docs, {
      get: vi.fn(), removeAndClean: vi.fn().mockResolvedValue(undefined),
      saveVVCache: vi.fn().mockResolvedValue(undefined),
      cleanOrphans: vi.fn().mockResolvedValue(0),
      saveDeleteJournal: vi.fn().mockResolvedValue(undefined),
    });
    app.vault.getAbstractFileByPath.mockReturnValue(file);
    app.fileManager.trashFile = vi.fn(async () => {
      expect(engine.isDeletingFromRemote(file.path)).toBe(true);
      app.vault.getAbstractFileByPath.mockReturnValue(null);
      await handlers.get('delete')!(file);
    });
    if (source === 'live') {
      await (engine as any).onDocDeleted(file.path);
    } else {
      app.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      vi.spyOn(engine, 'requestDocList').mockResolvedValue({ docs: [], tombstones: [file.path] });
      await engine.initialSync();
    }
    expect(app.fileManager.trashFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(engine.getStartupTraceReport()).toContain('vault-change.delete-remote-suppressed | path=window.md');
    vi.advanceTimersByTime(600);
    expect(deleted).not.toHaveBeenCalled();
    expect(engine.isDeletingFromRemote(file.path)).toBe(false);
  });

  it('deletes immediately outside the write window', async () => {
    vi.useFakeTimers();
    const { engine, handlers, editor } = await setup('');
    editor.writingFromRemote.clear();
    const deleted = vi.spyOn(engine, 'onFileDeleted').mockImplementation(() => {});
    await handlers.get('delete')!(new TFile());
    expect(deleted).toHaveBeenCalledExactlyOnceWith('window.md');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates pending deletes even after the write flag clears', async () => {
    vi.useFakeTimers();
    const { engine, handlers, app, editor } = await setup('');
    const deleted = vi.spyOn(engine, 'onFileDeleted').mockImplementation(() => {});
    await handlers.get('delete')!(new TFile());
    await handlers.get('delete')!(new TFile());
    expect(vi.getTimerCount()).toBe(1);
    expect(engine.getStartupTraceReport()).toContain('vault-change.delete-echo-dropped | path=window.md');
    editor.writingFromRemote.clear();
    await handlers.get('delete')!(new TFile());
    expect(deleted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(app.vault.getAbstractFileByPath).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledExactlyOnceWith('window.md');
  });
});

describe.each(['modify', 'create'])('vault %s remote-write window', (event) => {
  it('accepts different disk content and traces the decision', async () => {
    const { engine, push, handlers, app } = await setup('remote content + local edit');
    expect(engine.isWritingFromRemote('window.md')).toBe(true);
    await handlers.get(event)!(new TFile());
    expect(app.vault.read).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledExactlyOnceWith('window.md', 'remote content + local edit');
    expect(engine.getStartupTraceReport()).toContain('vault-change.accepted-in-window | path=window.md');
    expect(engine.getStartupTraceReport()).not.toContain('vault-change.echo-dropped');
  });

  it('drops identical disk content with a hash-match trace', async () => {
    const { engine, push, handlers, editor } = await setup('remote content');
    await handlers.get(event)!(new TFile());
    expect(push).not.toHaveBeenCalled();
    expect(engine.getStartupTraceReport()).toContain('vault-change.echo-dropped | path=window.md | data={"hashMatch":true}');
    expect(engine.getStartupTraceReport()).not.toContain('vault-change.accepted-in-window');
    editor.writingFromRemote.clear();
    editor.lastRemoteWrite.clear();
    expect(engine.isWritingFromRemote('window.md')).toBe(false);
  });
});
