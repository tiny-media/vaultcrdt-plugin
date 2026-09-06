import { describe, it, expect, vi } from 'vitest';
import { vvCovers, hasSharedHistory, vvEquals, conflictPath, fnv1aHash64 } from '../conflict-utils';

// -- Tests --------------------------------------------------------------------

describe('fnv1aHash64', () => {
  it('matches known FNV-1a 64-bit test vectors', () => {
    // Canonical FNV-1a 64 vectors (offset basis for empty input).
    expect(fnv1aHash64('')).toBe('cbf29ce484222325');
    expect(fnv1aHash64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1aHash64('foobar')).toBe('85944171f73967e8');
  });

  it('always returns a 16-char lowercase hex string', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(1000)]) {
      const h = fnv1aHash64(s);
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('distinguishes inputs that collide under the old 32-bit hash width', () => {
    // Two distinct strings must not share a 64-bit hash here.
    expect(fnv1aHash64('content-a')).not.toBe(fnv1aHash64('content-b'));
  });
});

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

  it('returns false on invalid JSON (conservative unknown-VV default)', () => {
    expect(vvCovers('not json', '{"peer1":1}')).toBe(false);
    expect(vvCovers('{"peer1":1}', 'bad')).toBe(false);
  });

  it('returns false on malformed VV values', () => {
    expect(vvCovers('{"peer1":true}', '{"peer1":1}')).toBe(false);
    expect(vvCovers('{"peer1":1}', '{"peer1":"1"}')).toBe(false);
    expect(vvCovers('[]', '{"peer1":1}')).toBe(false);
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

  it('returns false on invalid JSON (conservative unknown-history default)', () => {
    expect(hasSharedHistory('not json', '{"peer1":1}')).toBe(false);
    expect(hasSharedHistory('{"peer1":1}', 'bad')).toBe(false);
  });

  it('returns false on malformed VV values', () => {
    expect(hasSharedHistory('{"peer1":true}', '{"peer1":1}')).toBe(false);
    expect(hasSharedHistory('{"peer1":1}', '{"peer1":"1"}')).toBe(false);
  });
});

// -- vvEquals ----------------------------------------------------------------

describe('vvEquals', () => {
  it('returns true for equal VVs', () => {
    expect(vvEquals('{"peer1":1,"peer2":2}', '{"peer2":2,"peer1":1}')).toBe(true);
  });

  it('returns false for invalid or malformed VV data', () => {
    expect(vvEquals('not json', '{"peer1":1}')).toBe(false);
    expect(vvEquals('{"peer1":1}', '{"peer1":true}')).toBe(false);
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
