import { describe, it, expect, vi } from 'vitest';

const { download } = vi.hoisted(() => ({ download: { publish: undefined as undefined | ((n: number) => void) } }));
vi.mock('../blob-downloader', () => ({
  BlobDownloader: class {
    constructor(deps: { onActiveCountChange?: (n: number) => void }) { download.publish = deps.onActiveCountChange; }
  },
}));
const notices: string[] = [];
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return {
    ...actual,
    Notice: class {
      constructor(msg: string, _t?: number) { notices.push(msg); }
      setMessage(msg: string): this { notices.push(msg); return this; }
      hide(): void {}
    },
    Platform: { isDesktop: false },
    requestUrl: vi.fn(),
    apiVersion: 'test',
  };
});
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {}, HYDRATION_DEBOUNCE_MS: 2000 }));
vi.mock('../setup-modal', () => ({ SetupModal: class {} }));
vi.mock('../wasm-bridge', () => ({ createDocument: vi.fn(), initWasm: vi.fn() }));
vi.mock('../document-manager', () => ({ DocumentManager: class {} }));

import VaultCRDTPlugin from '../main';
import { StatusPanelModal } from '../status-panel';
import { InboxModal } from '../inbox-modal';
import { Inbox } from '../inbox';
import { App } from 'obsidian';
import { PANEL_COPY, INBOX_COPY } from '../user-facing-copy';

function elementText(el: { textContent: string; children: unknown[] }): string {
  const kids = el.children as Array<{ textContent: string; children: unknown[] }>;
  return el.textContent + kids.map(elementText).join(' ');
}

function makeStatusBarEl() {
  const el = {
    text: '', classes: new Set<string>(), attrs: {} as Record<string, string>,
    empty() { el.text = ''; },
    appendText(t: string) { el.text += t; },
    createSpan(o: { text: string }) { el.text += o.text; return el; },
    setAttribute(k: string, v: string) { el.attrs[k] = v; },
    addClass(c: string) { el.classes.add(c); },
    toggleClass(c: string, on: boolean) { on ? el.classes.add(c) : el.classes.delete(c); },
    remove() { el.text = ''; },
  };
  return el;
}

function makePlugin(showSyncStatus: boolean) {
  const statusBarEl = makeStatusBarEl();
  const app = { vault: { getAbstractFileByPath: () => null }, workspace: {} } as unknown as App;
  const plugin = new VaultCRDTPlugin(app, {} as never);
  Object.assign(plugin, {
    app,
    settings: { showSyncStatus, serverUrl: 'https://s.example', vaultId: 'v' },
    addStatusBarItem: () => statusBarEl,
    inbox: { count: () => 2 },
  });
  return { plugin, statusBarEl };
}

describe('status bar badge gating', () => {
  it('appends ·N when the inbox has items and showSyncStatus is on', () => {
    const { plugin, statusBarEl } = makePlugin(true);
    plugin.updateStatusBar();
    expect(statusBarEl.text).toContain('\u00b72');
    expect(statusBarEl.attrs['aria-label']).toContain('not connected');
  });

  it('renders no status bar at all when showSyncStatus is off', () => {
    const { plugin, statusBarEl } = makePlugin(false);
    plugin.updateStatusBar();
    expect(statusBarEl.text).toBe('');
  });
});

interface UiNode {
  textContent: string;
  children: UiNode[];
  className: string;
  attrs: Record<string, string>;
}
function nodes(el: UiNode): UiNode[] { return [el, ...el.children.flatMap(nodes)]; }

async function loadActivityUi(show: boolean) {
  const { plugin, statusBarEl } = makePlugin(show);
  Object.assign(plugin.app.vault, { on: vi.fn(), getFiles: () => [] });
  Object.assign(plugin.app.workspace, { on: vi.fn(), onLayoutReady: vi.fn() });
  Object.assign(plugin.app, { metadataCache: { on: vi.fn() } });
  vi.spyOn(plugin, 'loadSettings').mockResolvedValue();
  vi.spyOn(plugin as unknown as { getServerFeatures(): Promise<string[]> }, 'getServerFeatures').mockResolvedValue([]);
  await plugin.onload();
  vi.spyOn(plugin.inbox, 'count').mockReturnValue(2);
  const opened: StatusPanelModal[] = [];
  const spy = vi.spyOn(StatusPanelModal.prototype, 'open').mockImplementation(function (this: StatusPanelModal) {
    opened.push(this);
    this.onOpen();
  });
  return { plugin, statusBarEl, opened, spy };
}

describe('download activity UI wiring', () => {
  it('isolates a broken status bar and panel listener from other activity observers', async () => {
    const { plugin, opened, spy } = await loadActivityUi(true);
    const internals = plugin as unknown as {
      renderStatusBar(): void;
      downloadListeners: Set<(count: number) => void>;
    };
    const bar = vi.spyOn(internals, 'renderStatusBar').mockImplementation(() => {
      throw new Error('synthetic status bar failure');
    });
    internals.downloadListeners.add(() => { throw new Error('synthetic panel failure'); });
    try {
      plugin.openStatusPanel();
      const root = opened[0].contentEl as unknown as UiNode;
      expect(() => download.publish!(2)).not.toThrow();
      expect(elementText(root)).toContain('Downloads: 2');
      expect(() => download.publish!(0)).not.toThrow();
      expect(elementText(root)).toContain('Downloads: 0');
    } finally {
      opened[0]?.close();
      bar.mockRestore();
      spy.mockRestore();
      plugin.onunload();
    }
  });

  it.each([true, false])('shows live activity independently of connection and quiet mode (status=%s)', async show => {
    const { plugin, statusBarEl, opened, spy } = await loadActivityUi(show);
    try {
      expect(download.publish).toBeTypeOf('function');
      expect(statusBarEl.text).not.toContain('Downloads');
      download.publish!(2);
      plugin.openStatusPanel();
      const modal = opened[0];
      const root = modal.contentEl as unknown as UiNode;
      const row = nodes(root).find(n => n.className.includes('vcrdt-panel-downloads'))!;
      expect(row.textContent).toBe('Downloads: 2');
      expect(row.attrs['role']).toBe('status');
      expect(elementText(root)).toContain(PANEL_COPY.offline);
      const actions = nodes(root).filter(n => n.className.includes('vcrdt-panel-action'));
      expect(actions).toHaveLength(5);
      if (show) {
        expect(statusBarEl.text).toContain('Downloads: 2');
        expect(statusBarEl.text).toContain('\u00b72'); // inbox remains independent
        expect(statusBarEl.attrs['aria-label']).toContain('not connected');
        expect(statusBarEl.attrs['aria-label']).toContain('Downloads: 2');
      } else expect(statusBarEl.text).toBe('');
      download.publish!(1);
      expect(row.textContent).toBe('Downloads: 1');
      nodes(root).filter(n => n.className.includes('vcrdt-panel-action'))
        .forEach((action, i) => expect(action).toBe(actions[i]));
      expect(nodes(root)).toContain(row);
      download.publish!(0);
      expect(row.textContent).toBe('Downloads: 0');
      expect(statusBarEl.text).not.toContain('Downloads');
      expect(elementText(root)).not.toMatch(/fully synced|up to date/i);
      modal.close();
      download.publish!(3);
      expect(row.textContent).toBe('Downloads: 0');
      expect(root.children).toHaveLength(0);
      modal.open();
      expect(elementText(root)).toContain('Downloads: 3');
      // Stop publication before an asynchronous shutdown wait settles.
      let finish!: () => void;
      Object.assign(plugin, { pendingSyncEngineInit: new Promise<void>(resolve => { finish = resolve; }) });
      plugin.onunload();
      const before = elementText(root);
      const barBefore = statusBarEl.text;
      download.publish!(0);
      expect(elementText(root)).toBe(before);
      expect(statusBarEl.text).toBe(barBefore);
      finish();
      await Promise.resolve();
      download.publish!(1);
      expect(elementText(root)).toBe(before);
      expect(statusBarEl.text).toBe(barBefore);
      modal.close();
    } finally { spy.mockRestore(); }
  });
});

describe('notice policy', () => {
  it('keeps sync progress + complete notices during the first onboarding sync', async () => {
    notices.length = 0;
    const { plugin } = makePlugin(true);
    const engine = {
      initialSync: async (cb: (d: number, t: number, c: number) => void) => { cb(1, 2, 1); },
    };
    await (plugin as unknown as {
      runSyncWithProgress(e: unknown, m: string, f: boolean): Promise<void>;
    }).runSyncWithProgress(engine, 'merge', true);
    expect(notices.some(n => n.includes('Syncing 1/2'))).toBe(true);
    expect(notices.some(n => n.includes('Sync complete'))).toBe(true);
  });

  it('drops progress notices outside onboarding (log-only)', async () => {
    notices.length = 0;
    const { plugin } = makePlugin(true);
    const engine = {
      initialSync: async (cb: (d: number, t: number, c: number) => void) => {
        for (let i = 0; i < 20; i++) cb(i, 20, i);
      },
    };
    await (plugin as unknown as {
      runSyncWithProgress(e: unknown, m: string, f: boolean): Promise<void>;
    }).runSyncWithProgress(engine, 'merge', false);
    expect(notices).toEqual([]);
  });

  it('keeps the failure notice for a failed sync', async () => {
    notices.length = 0;
    const { plugin } = makePlugin(true);
    const engine = { initialSync: async () => { throw new Error('boom'); } };
    await expect((plugin as unknown as {
      runSyncWithProgress(e: unknown, m: string, f: boolean): Promise<void>;
    }).runSyncWithProgress(engine, 'merge', false)).rejects.toThrow('boom');
    expect(notices).toEqual(['VaultCRDT: Sync failed']);
  });
});

describe('status panel', () => {
  it('renders connection, counts and actions from injected data', () => {
    const now = 2_000_000;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_listener: (count: number) => void) => unsubscribe);
    const modal = new StatusPanelModal(new App(), () => ({
      connected: true, lastActivityAt: now - 30_000, lastInitialSyncAt: now - 3_600_000,
      sentUnacked: 3, inboxCount: 2, serverProtocolVersion: 1, clientProtocolVersion: 1,
    }), {
      syncNow: () => {}, invite: () => {}, openInbox: () => {},
      exportDiagnostics: () => {}, openSettings: () => {},
    }, { current: () => 0, subscribe }, () => now);
    modal.open();
    const text = elementText(modal.contentEl as unknown as { textContent: string; children: unknown[] });
    expect(text).toContain(PANEL_COPY.connected);
    expect(text).toContain(`${PANEL_COPY.unconfirmed}: 3`);
    expect(text).toContain(`${PANEL_COPY.inbox}: 2`);
    expect(text).toContain('30s ago');
    expect(text).toContain('1h ago');
    expect(text).toContain('protocol OK');
    expect(subscribe).toHaveBeenCalledOnce();
    const root = modal.contentEl as unknown as UiNode;
    const row = nodes(root).find(n => n.className.includes('vcrdt-panel-downloads'))!;
    modal.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    subscribe.mock.calls[0][0](9); // retained callback must not touch the discarded element
    expect(row.textContent).toBe('Downloads: 0');
    expect(root.children).toHaveLength(0);
  });

  it('shows the inbox entries and an empty state', async () => {
    const files = new Map<string, unknown>();
    const inbox = new Inbox({
      storage: {
        async loadJson<T>(n: string) { return (files.get(n) as T) ?? null; },
        async saveJson(n: string, v: unknown) { files.set(n, v); },
      },
      fileExists: () => true, notify: () => {},
    });
    await inbox.load();
    const empty = new InboxModal(new App(), inbox);
    empty.open();
    expect(elementText(empty.contentEl as unknown as { textContent: string; children: unknown[] }))
      .toContain(INBOX_COPY.empty);

    inbox.add({ kind: 'conflict', path: 'a (conflict 2026-09-06).md', relatedPath: 'a.md' });
    const modal = new InboxModal(new App(), inbox);
    modal.open();
    expect(inbox.count()).toBe(1);
    expect(elementText(modal.contentEl as unknown as { textContent: string; children: unknown[] }))
      .toContain(INBOX_COPY.title);
  });
});
