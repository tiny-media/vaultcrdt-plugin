import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
const ui = vi.hoisted(() => ({ texts: [] as any[], buttons: [] as any[] }));

vi.mock('obsidian', async () => {
  const base = await vi.importActual<any>('../__mocks__/obsidian');
  return {
    ...base,
    requestUrl: mockRequestUrl,
    Setting: class {
      setName(n: string) { this.name = n; return this; } setDesc() { return this; } name = '';
      addText(cb: any) {
        const t = { name: this.name, inputEl: { readOnly: false, focus() {} }, value: '',
          setValue(v: string) { this.value = v; return this; }, setPlaceholder() { return this; },
          onChange(fn: any) { this.change = fn; return this; }, change: null };
        ui.texts.push(t); cb(t); return this;
      }
      addButton(cb: any) {
        const b = { label: '', click: null, setButtonText(v: string) { this.label = v; return this; },
          setCta() { return this; }, setWarning() { return this; }, setDisabled() { return this; },
          onClick(fn: any) { this.click = fn; return this; } };
        ui.buttons.push(b); cb(b); return this;
      }
    },
  };
});

import { App } from 'obsidian';
import { SetupModal } from '../setup-modal';
import { ServerFeatureCache } from '../server-features';
import { DEFAULT_SETTINGS } from '../settings';
import { SETUP_COPY } from '../user-facing-copy';

const INVITE = 'a'.repeat(22);
const settings = { ...DEFAULT_SETTINGS, serverUrl: 'https://sync.example.com', vaultId: 'friends', peerId: 'peer-1', deviceName: 'phone' };
const prefill = { serverUrl: 'https://sync.example.com', vaultId: 'friends', invite: INVITE, newerVersion: false };
const fakeBtn = () => ({ setButtonText: vi.fn(), setDisabled: vi.fn() });

const health = (features?: string[]) => ({ json: features ? { features } : {} });
const httpErr = (status: number) => Object.assign(new Error('http'), { status });
const secretField = () => ui.texts.find(t => t.name === SETUP_COPY.secret);
const bodies = () => mockRequestUrl.mock.calls.map(c => [c[0].url, c[0].body ? JSON.parse(c[0].body) : null] as const);

async function openWithFeatures(features?: string[]) {
  mockRequestUrl.mockResolvedValueOnce(health(features));
  const modal = new SetupModal(new App(), settings, prefill, new ServerFeatureCache());
  const pending = modal.prompt();
  await vi.waitFor(() => expect((modal as any).inviteSupported).not.toBeUndefined());
  return { modal, pending };
}

beforeEach(() => { ui.texts.length = 0; ui.buttons.length = 0; mockRequestUrl.mockReset(); });

describe('invite redemption (S1b)', () => {
  it('hides the secret field and stores the device key on a successful redeem', async () => {
    const { modal, pending } = await openWithFeatures(['invite', 'device_keys']);
    expect(secretField()).toBeUndefined();
    mockRequestUrl.mockResolvedValueOnce({ json: { device_key: 'dk-1', token: 'jwt', vault_id: 'friends' } });
    await (modal as any).submit(fakeBtn());
    expect(await pending).toEqual({
      serverUrl: 'https://sync.example.com', vaultId: 'friends', vaultSecret: '',
      deviceKey: 'dk-1', deviceName: 'device',
    });
    expect(bodies()).toEqual([
      ['https://sync.example.com/health', null],
      ['https://sync.example.com/invite/redeem', { invite: INVITE, peer_id: 'peer-1', device_name: 'device' }],
    ]);
  });

  it.each([
    [410, SETUP_COPY.inviteHintExpired],
    [409, SETUP_COPY.inviteHintUsed],
    [401, SETUP_COPY.inviteHintInvalid],
  ])('reveals the secret field with a reason on %i', async (status, reason) => {
    const { modal, pending } = await openWithFeatures(['invite']);
    mockRequestUrl.mockRejectedValueOnce(httpErr(status));
    await (modal as any).submit(fakeBtn());
    expect((modal as any).inviteFallbackReason).toBe(reason);
    expect(secretField()).toBeDefined();
    // Secret path is intact and the invite is never resent.
    (modal as any).vaultSecret = 'pasted';
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt' } });
    await (modal as any).submit(fakeBtn());
    const calls = bodies();
    expect(calls.at(-1)).toEqual(['https://sync.example.com/auth/verify', { vault_id: 'friends', api_key: 'pasted' }]);
    expect(JSON.stringify(calls.slice(2))).not.toContain(INVITE);
    expect(await pending).toMatchObject({ vaultSecret: 'pasted', invite: INVITE });
  });

  it('falls back to the secret form on an old server without features', async () => {
    const { modal, pending } = await openWithFeatures(undefined);
    expect(secretField()).toBeDefined();
    (modal as any).vaultSecret = 'pw';
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt' } });
    await (modal as any).submit(fakeBtn());
    await pending;
    expect(bodies().map(([url]) => url)).toEqual([
      'https://sync.example.com/health', 'https://sync.example.com/auth/verify',
    ]);
  });

  it('treats an unreachable /health as "no features" and caches within the TTL', async () => {
    mockRequestUrl.mockRejectedValueOnce(new Error('offline'));
    const cache = new ServerFeatureCache();
    expect(await cache.get('https://sync.example.com')).toEqual([]);
    expect(await cache.get('https://sync.example.com')).toEqual([]);
    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
  });

  it('re-probes /health after the TTL expires', async () => {
    let now = 0;
    const cache = new ServerFeatureCache(() => now);
    mockRequestUrl.mockResolvedValue(health(['invite']));
    expect(await cache.get('https://sync.example.com')).toEqual(['invite']);
    now = 5 * 60 * 1000 + 1;
    await cache.get('https://sync.example.com');
    expect(mockRequestUrl).toHaveBeenCalledTimes(2);
  });
});
