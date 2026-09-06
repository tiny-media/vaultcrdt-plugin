import { describe, expect, it } from 'vitest';
import { assertNoSecret, buildDiagnosticsReport, type DiagnosticsInput } from '../diagnostics';

const input: DiagnosticsInput = {
  pluginVersion: '0.4.3', obsidianVersion: '1.12.0', serverUrl: 'https://example.com',
  health: { reachable: true, latencyMs: 42, version: '0.2.12', protocolVersion: 1 },
  clientProtocolVersion: 1,
  settings: { vaultSecret: 'sekret-123', deviceKey: 'devkey-456', serverUrl: 'https://example.com', token: 'excluded-token', deviceName: { token: 'nested-token' } },
  deviceName: 'test-device', peerId: 'test-peer',
  counts: { vvCacheEntries: 3, pendingDeletes: 2, sentUnacked: 1, stateFiles: 4, stateBytes: 100 },
  recentIssues: [{ ts: '2026-09-05T00:00:00.000Z', level: 'warn', text: 'ring-text' }],
  newestTracePath: 'VaultCRDT Debug/startup-trace-2026-09-05.md',
  inboxCount: 2, lastInitialSyncAt: Date.parse('2026-09-05T10:00:00.000Z'),
};

describe('diagnostics', () => {
  it('reports health, counts, issues and trace path without secrets or token fields', () => {
    const out = buildDiagnosticsReport(input);
    for (const text of ['(redacted)', 'protocol OK', '42 ms', 'ring-text', input.newestTracePath!,
      'Inbox items: 2', 'Last full sync: 2026-09-05T10:00:00.000Z']) expect(out).toContain(text);
    for (const text of ['sekret-123', 'devkey-456', 'excluded-token', 'nested-token']) expect(out).not.toContain(text);
    expect(() => assertNoSecret(out, 'sekret-123', 'devkey-456')).not.toThrow();
    expect(() => assertNoSecret('x sekret-123 x', 'sekret-123')).toThrow('diagnostics contain the vault secret');
    // deviceKey is treated exactly like the vault secret by the export gate.
    expect(() => assertNoSecret('x devkey-456 x', 'sekret-123', 'devkey-456')).toThrow('diagnostics contain the vault secret');
    expect(() => assertNoSecret('anything', '')).not.toThrow();
  });

  it('redacts every report surface and marks an uninitialised engine', () => {
    const out = buildDiagnosticsReport({ ...input, deviceName: 'sekret-123',
      recentIssues: [{ ...input.recentIssues[0], text: 'sekret-123' }],
      counts: { vvCacheEntries: -1, pendingDeletes: -1, sentUnacked: -1, stateFiles: -1, stateBytes: -1 },
      health: { reachable: false, latencyMs: 0 }, newestTracePath: null,
    });
    expect(out).not.toContain('sekret-123');
    expect(out).toContain('sync engine not initialised');
    expect(out).toContain('SERVER NEEDS UPDATE');
  });
});
