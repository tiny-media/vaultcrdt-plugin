import { describe, it, expect, vi } from 'vitest';

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
vi.mock('../settings', () => ({ VaultCRDTSettingsTab: class {} }));
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
    const modal = new StatusPanelModal(new App(), () => ({
      connected: true, lastActivityAt: now - 30_000, lastInitialSyncAt: now - 3_600_000,
      sentUnacked: 3, inboxCount: 2, serverProtocolVersion: 1, clientProtocolVersion: 1,
    }), {
      syncNow: () => {}, invite: () => {}, openInbox: () => {},
      exportDiagnostics: () => {}, openSettings: () => {},
    }, () => now);
    modal.open();
    const text = elementText(modal.contentEl as unknown as { textContent: string; children: unknown[] });
    expect(text).toContain(PANEL_COPY.connected);
    expect(text).toContain(`${PANEL_COPY.unconfirmed}: 3`);
    expect(text).toContain(`${PANEL_COPY.inbox}: 2`);
    expect(text).toContain('30s ago');
    expect(text).toContain('1h ago');
    expect(text).toContain('protocol OK');
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
