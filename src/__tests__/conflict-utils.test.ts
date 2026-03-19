import { describe, it, expect, vi } from 'vitest';
import { vvCovers, hasSharedHistory, conflictPath } from '../conflict-utils';

// -- Tests --------------------------------------------------------------------

describe('vvCovers', () => {
  it('returns true when A covers all peers in B', () => {
    const a = JSON.stringify({ peer1: 5, peer2: 3 });
    const b = JSON.stringify({ peer1: 3, peer2: 2 });
    expect(vvCovers(a, b)).toBe(true);
  });

  it('returns true when A equals B exactly', () => {
    const a = JSON.stringify({ peer1: 5 });
    const b = JSON.stringify({ peer1: 5 });
    expect(vvCovers(a, b)).toBe(true);
  });

  it('returns false when A is missing a peer from B', () => {
    const a = JSON.stringify({ peer1: 5 });
    const b = JSON.stringify({ peer1: 3, peer2: 2 });
    expect(vvCovers(a, b)).toBe(false);
  });

  it('returns false when A has a lower counter than B', () => {
    const a = JSON.stringify({ peer1: 2 });
    const b = JSON.stringify({ peer1: 5 });
    expect(vvCovers(a, b)).toBe(false);
  });

  it('returns true for empty VVs', () => {
    expect(vvCovers('{}', '{}')).toBe(true);
  });

  it('returns true when B is empty (A trivially covers nothing)', () => {
    const a = JSON.stringify({ peer1: 5 });
    expect(vvCovers(a, '{}')).toBe(true);
  });

  it('returns true on invalid JSON (safe default)', () => {
    expect(vvCovers('not json', '{"peer1":1}')).toBe(true);
    expect(vvCovers('{"peer1":1}', 'bad')).toBe(true);
  });
});

describe('hasSharedHistory', () => {
  it('returns true when VVs share peers', () => {
    const client = JSON.stringify({ peer1: 3, peer2: 1 });
    const server = JSON.stringify({ peer1: 5, peer3: 2 });
    expect(hasSharedHistory(client, server)).toBe(true);
  });

  it('returns false when VVs have no shared peers', () => {
    const client = JSON.stringify({ peer1: 3 });
    const server = JSON.stringify({ peer2: 5 });
    expect(hasSharedHistory(client, server)).toBe(false);
  });

  it('returns false for empty VVs (no peers to share)', () => {
    expect(hasSharedHistory('{}', '{}')).toBe(false);
  });

  it('returns false when client is empty', () => {
    expect(hasSharedHistory('{}', '{"peer1":1}')).toBe(false);
  });

  it('returns true on invalid JSON (safe default)', () => {
    expect(hasSharedHistory('not json', '{"peer1":1}')).toBe(true);
    expect(hasSharedHistory('{"peer1":1}', 'bad')).toBe(true);
  });
});

describe('conflictPath', () => {
  it('generates a basic conflict path with current date', () => {
    const date = new Date().toISOString().slice(0, 10);
    const app = {
      vault: { getAbstractFileByPath: vi.fn().mockReturnValue(null) },
    } as any;

    const result = conflictPath(app, 'notes/daily.md');
    expect(result).toBe(`notes/daily (conflict ${date}).md`);
  });

  it('increments counter when conflict file already exists', () => {
    const date = new Date().toISOString().slice(0, 10);
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (path === `notes/daily (conflict ${date}).md`) return {};
          return null;
        }),
      },
    } as any;

    const result = conflictPath(app, 'notes/daily.md');
    expect(result).toBe(`notes/daily (conflict ${date} 2).md`);
  });

  it('keeps incrementing until a free path is found', () => {
    const date = new Date().toISOString().slice(0, 10);
    const app = {
      vault: {
        getAbstractFileByPath: vi.fn((path: string) => {
          if (path === `notes/daily (conflict ${date}).md`) return {};
          if (path === `notes/daily (conflict ${date} 2).md`) return {};
          return null;
        }),
      },
    } as any;

    const result = conflictPath(app, 'notes/daily.md');
    expect(result).toBe(`notes/daily (conflict ${date} 3).md`);
  });

  it('handles files without extensions', () => {
    const date = new Date().toISOString().slice(0, 10);
    const app = {
      vault: { getAbstractFileByPath: vi.fn().mockReturnValue(null) },
    } as any;

    const result = conflictPath(app, 'README');
    expect(result).toBe(`README (conflict ${date})`);
  });

  it('handles different extensions', () => {
    const date = new Date().toISOString().slice(0, 10);
    const app = {
      vault: { getAbstractFileByPath: vi.fn().mockReturnValue(null) },
    } as any;

    const result = conflictPath(app, 'doc.txt');
    expect(result).toBe(`doc (conflict ${date}).txt`);
  });
});
