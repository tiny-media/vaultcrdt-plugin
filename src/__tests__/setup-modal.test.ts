import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted: mock requestUrl so individual tests can override per-case ───

const { mockRequestUrl } = vi.hoisted(() => ({
  mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../__mocks__/obsidian');
  return {
    ...actual,
    requestUrl: mockRequestUrl,
  };
});

import { SetupModal, type SetupResult } from '../setup-modal';
import { TRUST_NOTICE_TEXT } from '../user-facing-copy';
import { App } from 'obsidian';

// ── Helpers ─────────────────────────────────────────────────────────────────

const makeSettings = () => ({
  serverUrl: 'http://localhost:3737',
  vaultSecret: '',
  peerId: 'peer-x',
  vaultId: '',
  deviceName: 'test',
  debounceMs: 700,
  showSyncStatus: true,
  onboardingComplete: false,
});

const fakeBtn = () => ({
  setButtonText: vi.fn(),
  setDisabled: vi.fn(),
});

function elementText(el: Pick<HTMLElement, 'textContent' | 'children'>): string {
  return [
    el.textContent ?? '',
    ...Array.from(el.children).map((child) => elementText(child as HTMLElement)),
  ].join('\n');
}

/**
 * Drives the SetupModal lifecycle manually: open() → set private fields
 * (because the Setting stub doesn't re-fire onChange callbacks) → submit().
 * Returns the promise that resolves when the user clicks Connect/Cancel.
 */
function openAndFill(
  modal: SetupModal,
  fields: { serverUrl?: string; vaultId?: string; vaultSecret?: string; adminToken?: string },
): Promise<SetupResult | null> {
  const promise = modal.prompt();
  // open() triggered onOpen() via the Modal stub — now override the private
  // fields the way a user filling in the form would.
  const m = modal as unknown as Record<string, unknown>;
  if (fields.serverUrl !== undefined) m.serverUrl = fields.serverUrl;
  if (fields.vaultId !== undefined) m.vaultId = fields.vaultId;
  if (fields.vaultSecret !== undefined) m.vaultSecret = fields.vaultSecret;
  if (fields.adminToken !== undefined) m.adminToken = fields.adminToken;
  return promise;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SetupModal', () => {
  let modal: SetupModal;

  beforeEach(() => {
    vi.clearAllMocks();
    modal = new SetupModal(new App(), makeSettings());
  });

  it('shows the trust notice before connecting', async () => {
    const pending = modal.prompt();
    expect(elementText(modal.contentEl)).toContain(TRUST_NOTICE_TEXT);

    modal.close();
    await pending;
  });

  it('omits admin_token from /auth/verify body when the field is empty', async () => {
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt-1' } });

    const pending = openAndFill(modal, {
      serverUrl: 'http://localhost:3737',
      vaultId: 'my-vault',
      vaultSecret: 'pw',
    });

    // Drive submit()
    await (modal as unknown as { submit: (b: unknown) => Promise<void> }).submit(fakeBtn());
    const result = await pending;

    expect(result).toEqual({
      serverUrl: 'http://localhost:3737',
      vaultId: 'my-vault',
      vaultSecret: 'pw',
    });

    expect(mockRequestUrl).toHaveBeenCalledTimes(1);
    const call = mockRequestUrl.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({ vault_id: 'my-vault', api_key: 'pw' });
    expect(body.admin_token).toBeUndefined();
  });

  it('includes admin_token in the body when the user entered one', async () => {
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt-2' } });

    const pending = openAndFill(modal, {
      serverUrl: 'http://localhost:3737',
      vaultId: 'fresh-vault',
      vaultSecret: 'pw',
      adminToken: 'secret-admin-token',
    });

    await (modal as unknown as { submit: (b: unknown) => Promise<void> }).submit(fakeBtn());
    const result = await pending;

    expect(result).toEqual({
      serverUrl: 'http://localhost:3737',
      vaultId: 'fresh-vault',
      vaultSecret: 'pw',
      adminToken: 'secret-admin-token',
    });

    const call = mockRequestUrl.mock.calls[0][0] as { body: string };
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({
      vault_id: 'fresh-vault',
      api_key: 'pw',
      admin_token: 'secret-admin-token',
    });
  });

  it('shows an admin-token hint when the server replies 401', async () => {
    const err: Error & { status?: number } = new Error('Unauthorized');
    err.status = 401;
    mockRequestUrl.mockRejectedValueOnce(err);

    const pending = openAndFill(modal, {
      serverUrl: 'http://localhost:3737',
      vaultId: 'unknown-vault',
      vaultSecret: 'pw',
    });

    await (modal as unknown as { submit: (b: unknown) => Promise<void> }).submit(fakeBtn());

    // Don't await `pending` — submit() reports the error via showError()
    // and keeps the promise open so the user can retry without closing.
    const errorEl = (modal as unknown as { errorEl: { textContent: string } }).errorEl;
    expect(errorEl.textContent).toContain('Authentication failed');
    expect(errorEl.textContent).toContain('Creating a new vault');

    // Clean up the dangling promise so vitest doesn't hang.
    (modal as unknown as { resolve: ((r: SetupResult | null) => void) | null }).resolve?.(null);
    await pending;
  });

  it('persists the normalized server URL (strips trailing slash)', async () => {
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt-3' } });

    const pending = openAndFill(modal, {
      serverUrl: 'http://localhost:3737/',
      vaultId: 'my-vault',
      vaultSecret: 'pw',
    });

    await (modal as unknown as { submit: (b: unknown) => Promise<void> }).submit(fakeBtn());
    const result = await pending;

    expect(result?.serverUrl).toBe('http://localhost:3737');

    // The /auth/verify URL must not contain a double slash.
    const call = mockRequestUrl.mock.calls[0][0] as { url: string };
    expect(call.url).toBe('http://localhost:3737/auth/verify');
    expect(call.url.includes('//auth')).toBe(false);
  });

  it('resolves with null when the user cancels via close()', async () => {
    const pending = modal.prompt();
    modal.close();
    const result = await pending;
    expect(result).toBeNull();
  });
});

describe('prefilled join', () => {
  it('shows known fields, trust and future hints; change opens the expert block', async () => {
    const modal = new SetupModal(new App(), makeSettings(), {
      serverUrl: 'https://sync.example.com', vaultId: 'friends', newerVersion: true,
      invite: 'a'.repeat(22),
    });
    const pending = modal.prompt();
    const text = elementText(modal.contentEl);
    expect(text).toContain('Join vault friends');
    expect(text).toContain('Invited to sync.example.com');
    expect(text).toContain(TRUST_NOTICE_TEXT);
    expect(text).toContain('This link needs a newer VaultCRDT plugin');
    expect(text).toContain('Invite token detected');
    expect(text).not.toContain('Creating a new vault?');
    const change = Array.from(modal.contentEl.children).find((el: any) => el.tag === 'a') as any;
    change.listeners.click({ preventDefault() {} });
    expect(elementText(modal.contentEl)).toContain('Creating a new vault?');
    expect(elementText(modal.contentEl)).toContain(TRUST_NOTICE_TEXT);
    modal.close(); await pending;
  });
  it('requires second-channel secret and verifies the locked connection, carrying invite only in the result', async () => {
    mockRequestUrl.mockReset();
    const modal = new SetupModal(new App(), { ...makeSettings(), vaultSecret: 'old-secret' }, {
      serverUrl: 'https://sync.example.com', vaultId: 'friends', newerVersion: false, invite: 'a'.repeat(22),
    });
    const pending = modal.prompt();
    const m = modal as any;
    await m.submit(fakeBtn());
    expect(mockRequestUrl).not.toHaveBeenCalled();
    expect(m.errorEl.textContent).toBe('Vault secret is required');
    m.vaultSecret = 'pasted-secret';
    mockRequestUrl.mockResolvedValueOnce({ json: { token: 'jwt' } });
    await m.submit(fakeBtn());
    expect(mockRequestUrl.mock.calls[0][0].url).toBe('https://sync.example.com/auth/verify');
    expect(JSON.parse(mockRequestUrl.mock.calls[0][0].body)).toEqual({ vault_id: 'friends', api_key: 'pasted-secret' });
    expect(await pending).toMatchObject({ vaultId: 'friends', invite: 'a'.repeat(22), deviceName: 'device' });
  });
});
