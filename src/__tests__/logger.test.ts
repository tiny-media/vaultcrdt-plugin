import { afterEach, describe, expect, it, vi } from 'vitest';
import { error, getRecentIssues, log, redact, setSecretProvider, warn } from '../logger';

 afterEach(() => { setSecretProvider(() => ''); vi.restoreAllMocks(); });

describe('issue ring', () => {
  it('redacts ring and console before truncation, including objects and errors', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSecretProvider(() => 'sekret-123');
    warn('boom', { vaultSecret: 'sekret-123' });
    expect(getRecentIssues().at(-1)?.text).toContain('(redacted)');
    warn('x'.repeat(295) + 'sekret-123', new Error('sekret-123'));
    expect(getRecentIssues().at(-1)?.text).not.toContain('sekr');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('sekret-123');
    expect(redact('escaped a\\"b', 'a"b')).toBe('escaped (redacted)');
  });

  it('keeps only 50 warn/error entries; debug noise never enters the ring', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = getRecentIssues();
    for (let i = 0; i < 100; i++) log('noise');
    expect(getRecentIssues()).toEqual(before);
    for (let i = 0; i < 60; i++) error('e' + i);
    const ring = getRecentIssues();
    expect(ring).toHaveLength(50);
    expect(ring[0].text).toBe('e10');
    expect(ring[49].text).toBe('e59');
    expect(ring[0].level).toBe('error');
    expect(new Date(ring[0].ts).toISOString()).toBe(ring[0].ts);
  });
});
