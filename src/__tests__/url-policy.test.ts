import { describe, it, expect } from 'vitest';
import {
  validateServerUrl,
  isLocalOrPrivateHost,
  normalizeServerUrl,
  toHttpBase,
  toWsBase,
} from '../url-policy';

describe('validateServerUrl', () => {
  // ── Accepts ────────────────────────────────────────────────────────────────
  it.each([
    'https://sync.example.com',
    'wss://sync.example.com:8443/base',
    'http://localhost:3737',
    'http://127.0.0.1',
    'ws://localhost/ws',
    'http://10.0.0.5',
    'http://192.168.1.20:8080',
    'http://172.16.4.4',
    'http://172.31.255.255',
  ])('accepts %s', (url) => {
    const r = validateServerUrl(url);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });

  // ── Rejects — substring-check bypass cases from the audit ──────────────────
  it.each([
    ['http://localhost.evil.com', /TLS|localhost/i],
    ['http://evil.com/?next=localhost', /TLS|localhost/i],
    ['http://127.0.0.1.evil.com', /TLS/],
    ['http://example.com', /TLS/],
    ['ws://public.example.com/ws', /TLS/],
  ])('rejects insecure non-local %s', (url, reMatch) => {
    const r = validateServerUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reMatch);
  });

  it('rejects empty input', () => {
    const r = validateServerUrl('   ');
    expect(r.ok).toBe(false);
  });

  it('rejects unknown scheme', () => {
    const r = validateServerUrl('ftp://example.com');
    expect(r.ok).toBe(false);
  });

  it('rejects malformed url', () => {
    const r = validateServerUrl('not a url at all');
    expect(r.ok).toBe(false);
  });

  it('rejects 172.15/172.32 (outside private range)', () => {
    expect(validateServerUrl('http://172.15.0.1').ok).toBe(false);
    expect(validateServerUrl('http://172.32.0.1').ok).toBe(false);
  });
});

describe('isLocalOrPrivateHost', () => {
  it('accepts loopback names and IPs', () => {
    expect(isLocalOrPrivateHost('localhost')).toBe(true);
    expect(isLocalOrPrivateHost('127.0.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('::1')).toBe(true);
  });
  it('rejects subdomain trickery', () => {
    expect(isLocalOrPrivateHost('localhost.evil.com')).toBe(false);
    expect(isLocalOrPrivateHost('127.0.0.1.evil.com')).toBe(false);
  });
});

describe('toHttpBase / toWsBase', () => {
  it('normalises schemes both ways', () => {
    expect(toHttpBase('wss://x.example.com')).toBe('https://x.example.com');
    expect(toHttpBase('ws://localhost')).toBe('http://localhost');
    expect(toWsBase('https://x.example.com')).toBe('wss://x.example.com');
    expect(toWsBase('http://localhost')).toBe('ws://localhost');
  });

  // Trailing slashes used to leak into `${base}/auth/verify` and `${base}/ws`,
  // producing `//auth/verify` and `//ws`. Callers MUST get a slash-free base.
  it('strips trailing slashes', () => {
    expect(toHttpBase('https://x.example.com/')).toBe('https://x.example.com');
    expect(toHttpBase('https://x.example.com///')).toBe('https://x.example.com');
    expect(toWsBase('https://x.example.com/')).toBe('wss://x.example.com');
    expect(toWsBase('wss://x.example.com//')).toBe('wss://x.example.com');
  });

  it('preserves explicit paths but strips their trailing slash', () => {
    expect(toHttpBase('https://x.example.com/api/')).toBe('https://x.example.com/api');
    expect(toWsBase('https://x.example.com/api/')).toBe('wss://x.example.com/api');
  });
});

describe('normalizeServerUrl', () => {
  it('trims whitespace', () => {
    expect(normalizeServerUrl('  https://sync.example.com  ')).toBe('https://sync.example.com');
  });

  it('strips a single trailing slash', () => {
    expect(normalizeServerUrl('https://sync.example.com/')).toBe('https://sync.example.com');
  });

  it('strips repeated trailing slashes', () => {
    expect(normalizeServerUrl('https://sync.example.com////')).toBe('https://sync.example.com');
  });

  it('keeps a path segment but removes its trailing slash', () => {
    expect(normalizeServerUrl('https://sync.example.com/path/')).toBe('https://sync.example.com/path');
  });

  it('is idempotent', () => {
    const once = normalizeServerUrl('https://sync.example.com/');
    expect(normalizeServerUrl(once)).toBe(once);
  });

  it('leaves an already-canonical URL unchanged', () => {
    expect(normalizeServerUrl('https://sync.example.com')).toBe('https://sync.example.com');
  });
});
