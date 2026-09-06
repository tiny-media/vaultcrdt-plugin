import { describe, it, expect } from 'vitest';
import { createSetupUri, parseSetupParams, parseSetupUri } from '../setup-link';
import { validateServerUrl } from '../url-policy';
import { assertNoSecret } from '../diagnostics';
const params = { v: '1', server: 'https://sync.example.com/', vaultId: 'my-notes' };
describe('setup links', () => {
  it('round trips known fields, ignoring unknown params and vault', () => {
    const uri = createSetupUri(params.server, params.vaultId);
    expect(parseSetupUri(uri + '&vault=other&secret=ignored&future=yes')).toEqual({
      serverUrl: 'https://sync.example.com', vaultId: 'my-notes', newerVersion: false,
    });
    expect(() => parseSetupParams({ ...params, vaultId: '', vault: 'other' })).toThrow();
  });
  it('rejects bad schemes, invalid vault IDs and versions', () => {
    expect(() => parseSetupUri('https://vaultcrdt/setup?v=1')).toThrow();
    for (const v of ['', '0', '-1', '1.5', 'NaN']) expect(() => parseSetupParams({ ...params, v })).toThrow();
    expect(() => parseSetupParams({ ...params, vaultId: '../notes' })).toThrow();
    expect(validateServerUrl('http://sync.example.com').ok).toBe(false);
    for (const server of ['http://sync.example.com', 'http://localhost:3737', 'wss://sync.example.com'])
      expect(() => parseSetupParams({ ...params, server })).toThrow();
    expect(validateServerUrl('http://localhost:3737').ok).toBe(true);
  });
  it('supports both actions and newer versions', () => {
    expect(parseSetupUri(createSetupUri(params.server, params.vaultId).replace('vaultcrdt/setup', 'vaultcrdt-setup')).vaultId).toBe('my-notes');
    expect(parseSetupParams({ ...params, v: '2' }).newerVersion).toBe(true);
  });
  it('validates optional base64url invite tokens', () => {
    const invite = 'aB09_-'.repeat(3) + 'abcd';
    expect(parseSetupParams({ ...params, invite }).invite).toBe(invite);
    for (const invite of ['', 'short', '+'.repeat(22), 'a'.repeat(23)])
      expect(() => parseSetupParams({ ...params, invite })).toThrow();
  });
  it('never includes a vault secret in generated setup URIs', () => {
    const secret = 'never-burn-this-vault-secret';
    const uri = createSetupUri(params.server, params.vaultId);
    expect(uri).not.toContain(secret);
    expect(uri).not.toMatch(/invite=|secret=/i);
    expect(uri.length).toBeLessThan(200);
    expect(() => assertNoSecret(uri, secret)).not.toThrow();
  });
});

describe('createSetupUri with invite token', () => {
  it('appends a valid invite token and keeps it out when absent', () => {
    const withToken = createSetupUri('https://sync.example.com', 'my-notes', 'AbCdEfGhIJkLmnopQRSTuv');
    expect(withToken).toContain('&invite=AbCdEfGhIJkLmnopQRSTuv');
    expect(parseSetupUri(withToken).invite).toBe('AbCdEfGhIJkLmnopQRSTuv');
    const without = createSetupUri('https://sync.example.com', 'my-notes');
    expect(without).not.toContain('invite=');
  });
});
