import { describe, expect, it } from 'vitest';
import { TRUST_NOTICE_TEXT, conflictNoticeMessage, excalidrawConflictNoticeMessage, tombstoneNoticeMessage, OBSIDIAN_SYNC_COPY, SETUP_COPY, SETTINGS_COPY, vaultSecretSetting, ribbonBadgeState, authRejectedNoticeMessage } from '../user-facing-copy';
import * as copy from '../user-facing-copy';

describe('user-facing copy', () => {
  it('states the trust model clearly', () => {
    expect(TRUST_NOTICE_TEXT).toContain('does not currently use end-to-end encryption');
    expect(TRUST_NOTICE_TEXT).toContain('server operator');
    expect(TRUST_NOTICE_TEXT).toContain('paths and contents');
  });

  it('makes conflict recovery actionable', () => {
    const msg = conflictNoticeMessage('Folder/Note (conflict 2026-06-06).md');
    expect(msg).toContain('Open both files');
    expect(msg).toContain('merge');
    expect(msg).toContain('delete the conflict copy only after checking it');
  });

  it('explains that concurrent drawings are not merged', () => {
    const msg = excalidrawConflictNoticeMessage('Folder/Draw (conflict 2026-09-07).excalidraw.md');
    expect(msg).toContain('were not merged');
    expect(msg).toContain('other device');
    expect(msg).toContain('Open both files');
    expect(msg).toContain('delete the conflict copy only after checking it');
  });

  it('makes tombstone recovery actionable', () => {
    const msg = tombstoneNoticeMessage('Folder/Note.md');
    expect(msg).toContain('deleted on another device');
    expect(msg).toContain('will not sync');
    expect(msg).toContain('new filename');
    expect(msg).toContain('Trash');
    expect(msg).toContain('other synced device');
  });

  it('states LWW, never-syncs, and hardcoded configDir for .obsidian sync', () => {
    expect(OBSIDIAN_SYNC_COPY.heading).toBe('.obsidian sync');
    expect(OBSIDIAN_SYNC_COPY.settingsDesc).toContain('last-write-wins');
    expect(OBSIDIAN_SYNC_COPY.settingsDesc).toContain('No JSON-key merge');
    expect(OBSIDIAN_SYNC_COPY.settingsDesc).toContain('custom configDir');
    expect(OBSIDIAN_SYNC_COPY.stylesDesc).toContain('never sync');
    expect(OBSIDIAN_SYNC_COPY.neverSyncs).toContain('workspace.json');
    expect(OBSIDIAN_SYNC_COPY.configDirNote).toContain('.obsidian');
  });
});

describe('settings B7 vault secret modes', () => {
  it('keeps the text-field path when no device key is set', () => {
    const field = vaultSecretSetting(undefined);
    expect(field.usesTextField).toBe(true);
    expect(field.name).toBe('Vault secret');
    expect(field.placeholder).toBe('vault secret');
    expect(field.readonlyLine).toBe('');
    expect(field.desc).toContain('identical on every device');
    expect(field.desc.toLowerCase()).not.toContain('rotat');
  });

  it('replaces the text field with the device-key hint when deviceKey is set', () => {
    const field = vaultSecretSetting('dk-1');
    expect(field.usesTextField).toBe(false);
    expect(field.name).toBe('Vault secret');
    expect(field.readonlyLine).toBe('Authenticated via device key');
    expect(field.desc).toBe('This device joined via invite link. The vault secret is not used here.');
    expect(field.placeholder).toBe('');
  });
});

describe('ribbon badge logic', () => {
  it('shows no text and no offline dot when connected with an empty inbox', () => {
    expect(ribbonBadgeState(0, true)).toEqual({ text: '', offlineDot: false });
  });

  it('shows the inbox count when there are items', () => {
    expect(ribbonBadgeState(3, true)).toEqual({ text: '3', offlineDot: false });
    expect(ribbonBadgeState(3, false)).toEqual({ text: '3', offlineDot: false });
  });

  it('uses an offline dot when disconnected with an empty inbox', () => {
    expect(ribbonBadgeState(0, false)).toEqual({ text: '', offlineDot: true });
  });
});

function exportedStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    try { return exportedStrings(value(), depth + 1); } catch { /* needs args */ }
    try { return exportedStrings(value('x'), depth + 1); } catch { /* */ }
    try { return exportedStrings(value('x', 'y'), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap((item) => exportedStrings(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((item) => exportedStrings(item, depth + 1));
  }
  return [];
}

describe('terminology smoke', () => {
  it('exports Vault ID / Vault secret and drops Vault Name', () => {
    const strings = exportedStrings(copy);
    const joined = strings.join('\n');
    expect(joined).toContain('Vault ID');
    expect(joined).toContain('Vault secret');
    expect(strings.some((s) => s.includes('Vault Name'))).toBe(false);
    expect(SETUP_COPY.vault).toBe('Vault ID');
    expect(SETTINGS_COPY.vaultSecret).toBe('Vault secret');
    expect(authRejectedNoticeMessage()).toContain('vault ID');
  });
});
