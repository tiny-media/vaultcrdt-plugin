import { describe, expect, it } from 'vitest';
import { uuidV4Compat } from '../settings';

// Amazon WebView 84 (Chromium < 92, Fire tablets) has no crypto.randomUUID —
// the plugin must still generate peer ids there (device-tested 2026-09-06:
// without the fallback the plugin died at load and the toggle sprang back).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV4Compat', () => {
  it('generates valid v4 uuids when crypto.randomUUID is missing (WebView 84)', () => {
    const original = crypto.randomUUID;
    (crypto as any).randomUUID = undefined;
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const id = uuidV4Compat();
        expect(id).toMatch(UUID_RE);
        ids.add(id);
      }
      expect(ids.size).toBe(200);
    } finally {
      (crypto as any).randomUUID = original;
    }
  });

  it('uses the native crypto.randomUUID when present', () => {
    expect(uuidV4Compat()).toMatch(UUID_RE);
  });
});

import { normalizeServerUrl } from '../url-policy';

describe('normalizeServerUrl without URL.canParse (WebView 84)', () => {
  it('still normalises and rejects malformed URLs by exception', () => {
    const original = URL.canParse;
    (URL as any).canParse = undefined;
    try {
      expect(normalizeServerUrl('https://sync.example.com/')).toBe('https://sync.example.com');
      expect(() => normalizeServerUrl('https://u:p@sync.example.com')).toThrow(/credentials/);
    } finally {
      (URL as any).canParse = original;
    }
  });
});
