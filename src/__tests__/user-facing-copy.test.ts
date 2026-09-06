import { describe, expect, it } from 'vitest';
import { TRUST_NOTICE_TEXT, conflictNoticeMessage, tombstoneNoticeMessage } from '../user-facing-copy';

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

  it('makes tombstone recovery actionable', () => {
    const msg = tombstoneNoticeMessage('Folder/Note.md');
    expect(msg).toContain('deleted on another device');
    expect(msg).toContain('will not sync');
    expect(msg).toContain('new filename');
    expect(msg).toContain('Trash');
    expect(msg).toContain('other synced device');
  });
});
