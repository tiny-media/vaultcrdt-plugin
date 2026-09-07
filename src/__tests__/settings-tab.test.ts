import { describe, it, expect, vi } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return { ...actual, requestUrl: mockRequestUrl };
});

import { App } from 'obsidian';
import { VaultCRDTSettingsTab, DEFAULT_SETTINGS } from '../settings';
import { SETTINGS_COPY } from '../user-facing-copy';

function elementText(el: { textContent?: string; children?: unknown[] }): string {
  return [
    el.textContent ?? '',
    ...(el.children ?? []).map((child) => elementText(child as { textContent?: string })),
  ].join('\n');
}

/** Minimal element stub matching the shape settings.ts uses on containerEl. */
function makeStubContainer(): Record<string, unknown> {
  const spawn = (parent: Record<string, unknown>, tag: string, opts?: { text?: string; cls?: string }) => {
    const child = make(tag);
    if (opts?.text) child.textContent = opts.text;
    if (opts?.cls) child.className = opts.cls;
    (parent.children as unknown[]).push(child);
    return child;
  };
  function make(tag: string): Record<string, unknown> {
    const el: Record<string, unknown> = {
      tag, children: [] as unknown[], textContent: '', className: '', attrs: {},
      createEl: (t: string, opts?: { text?: string; cls?: string }) => spawn(el, t, opts),
      createDiv: (opts?: { text?: string; cls?: string }) => spawn(el, 'div', opts),
      createSpan: (opts?: { text?: string; cls?: string }) => spawn(el, 'span', opts),
      empty: () => { (el.children as unknown[]).length = 0; el.textContent = ''; },
      addClass: (cls: string) => { el.className = `${el.className as string} ${cls}`.trim(); },
      removeClass: () => {},
      setAttribute: (k: string, v: string) => { (el.attrs as Record<string, string>)[k] = v; },
    };
    return el;
  }
  return make('div');
}

function makeTab() {
  mockRequestUrl.mockRejectedValue(new Error('offline'));
  const plugin = {
    manifest: { version: '0.5.8' },
    settings: { ...DEFAULT_SETTINGS, serverUrl: 'https://sync.example.com', vaultId: 'friends' },
    saveSettings: vi.fn(),
    updateStatusBar: vi.fn(),
    openInviteModal: vi.fn(),
    collectDiagnosticsReport: vi.fn().mockResolvedValue('# report'),
    serverFeatures: { get: vi.fn().mockResolvedValue([]), protocolVersion: () => undefined },
    syncEngine: { getLocalStorageStats: vi.fn().mockResolvedValue({ loroFiles: [], syncedDocCount: 0 }) },
  };
  const tab = new VaultCRDTSettingsTab(new App(), plugin as never);
  const containerEl = makeStubContainer();
  // The PluginSettingTab stub has no containerEl of its own.
  (tab as unknown as { containerEl: unknown }).containerEl = containerEl;
  return { tab, plugin, containerEl };
}

describe('settings tab structure', () => {
  it('renders the three plain blocks plus the developer section', () => {
    const { tab, containerEl } = makeTab();
    tab.display();
    const text = elementText(containerEl);

    expect(text).toContain(SETTINGS_COPY.connection);
    expect(text).toContain(SETTINGS_COPY.sync);
    expect(text).toContain(SETTINGS_COPY.about);
    expect(text).toContain(SETTINGS_COPY.developer);
    expect(text).toContain(SETTINGS_COPY.addDevice);
    expect(text).toContain(SETTINGS_COPY.keepSettings);
    expect(text).toContain(SETTINGS_COPY.carryStyles);
  });

  it('shows read-only constants in the developer section', () => {
    const { tab, containerEl } = makeTab();
    tab.display();
    const text = elementText(containerEl);

    expect(text).toContain(SETTINGS_COPY.copyDiagnostics);
    expect(text).toContain(SETTINGS_COPY.activeConstants);
    expect(text).toContain('300 ms');
    expect(text).toContain('2000 ms');
    expect(text).toContain(SETTINGS_COPY.attachmentCapsValue);
  });

  it('no longer offers the sync-delay knob', () => {
    const { tab, plugin, containerEl } = makeTab();
    tab.display();

    expect(elementText(containerEl)).not.toContain('Sync delay');
    expect(plugin.settings).not.toHaveProperty('debounceMs');
  });
});
