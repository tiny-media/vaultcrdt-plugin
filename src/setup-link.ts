import { normalizeServerUrl, validateServerUrl } from './url-policy';
import { SETUP_COPY } from './user-facing-copy';

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export interface SetupPrefill { serverUrl: string; vaultId: string; invite?: string; newerVersion: boolean }
export function parseSetupParams(params: Record<string, string>): SetupPrefill {
  const check = validateServerUrl(params.server ?? '');
  if (!check.ok || check.url.protocol !== 'https:') throw new Error(SETUP_COPY.https);
  if (!/^[1-9][0-9]*$/.test(params.v ?? '') || !VAULT_NAME_RE.test(params.vaultId ?? '') ||
      (params.invite !== undefined && !/^[A-Za-z0-9_-]{22}$/.test(params.invite))) {
    throw new Error(SETUP_COPY.invalid);
  }
  return { serverUrl: normalizeServerUrl(params.server), vaultId: params.vaultId,
    ...(params.invite !== undefined ? { invite: params.invite } : {}), newerVersion: Number(params.v) > 1 };
}
export function parseSetupUri(uri: string): SetupPrefill {
  const url = new URL(uri);
  if (url.protocol !== 'obsidian:' || !((url.hostname === 'vaultcrdt' && url.pathname === '/setup') ||
      (url.hostname === 'vaultcrdt-setup' && !url.pathname))) throw new Error(SETUP_COPY.invalid);
  return parseSetupParams(Object.fromEntries(url.searchParams));
}
// Deliberately accepts only public connection fields, never credentials.
export function createSetupUri(serverUrl: string, vaultId: string, invite?: string): string {
  const params: Record<string, string> = { v: '1', server: serverUrl, vaultId };
  if (invite !== undefined) params.invite = invite;
  const prefill = parseSetupParams(params);
  return `obsidian://vaultcrdt/setup?v=1&server=${encodeURIComponent(prefill.serverUrl)}&vaultId=${encodeURIComponent(prefill.vaultId)}` +
    (prefill.invite !== undefined ? `&invite=${encodeURIComponent(prefill.invite)}` : '');
}
