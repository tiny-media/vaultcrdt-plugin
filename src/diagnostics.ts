import { redact, type RingEntry } from './logger';
import { PROTOCOL_VERSION } from './protocol';
import { protocolHealthText } from './user-facing-copy';

export interface DiagnosticsInput {
  pluginVersion: string;
  obsidianVersion: string;
  serverUrl: string;
  health: { reachable: boolean; latencyMs: number; version?: string; protocolVersion?: number };
  clientProtocolVersion: number;
  settings: Record<string, unknown>;
  deviceName: string;
  peerId: string;
  counts: { vvCacheEntries: number; pendingDeletes: number; sentUnacked: number; stateFiles: number; stateBytes: number };
  recentIssues: RingEntry[];
  newestTracePath: string | null;
  /** Quiet-mode inbox size (paths are never included — only the count). */
  inboxCount: number;
  /** Wall-clock ms of the last completed full sync (0 = none this session). */
  lastInitialSyncAt: number;
}

export function buildDiagnosticsReport(i: DiagnosticsInput): string {
  const settings: Record<string, string | number | boolean> = {
    vaultSecret: '(redacted)', deviceKey: '(redacted)',
  };
  for (const key of ['serverUrl', 'vaultId', 'peerId', 'deviceName', 'debounceMs', 'showSyncStatus', 'onboardingComplete']) {
    const value = i.settings[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') settings[key] = value;
  }
  const lines = [
    '# VaultCRDT diagnostics', '',
    `Plugin: ${i.pluginVersion}`, `Obsidian: ${i.obsidianVersion}`, `Server URL: ${i.serverUrl}`,
    `Device: ${i.deviceName}`, `Peer ID: ${i.peerId}`,
    `Client protocol: ${i.clientProtocolVersion} (build: ${PROTOCOL_VERSION})`, '',
    '## Health',
    `Reachable: ${i.health.reachable}`, `Latency: ${i.health.latencyMs} ms`,
    `Server version: ${i.health.version ?? '?'}`,
    protocolHealthText(i.health.protocolVersion, i.clientProtocolVersion), '',
    '## Local state',
    `VV cache entries: ${i.counts.vvCacheEntries}`, `Pending deletes: ${i.counts.pendingDeletes}`,
    `Sent-but-unacked pushes: ${i.counts.sentUnacked}`,
    `State files: ${i.counts.stateFiles}`, `State bytes: ${i.counts.stateBytes}`,
    `Inbox items: ${i.inboxCount}`,
    `Last full sync: ${i.lastInitialSyncAt ? new Date(i.lastInitialSyncAt).toISOString() : '(none)'}`,
    ...(i.counts.vvCacheEntries === -1 ? ['sync engine not initialised'] : []), '',
    '## Settings', '```json', JSON.stringify(settings, null, 2), '```', '',
    '## Recent issues',
    ...i.recentIssues.map(e => `${e.ts} [${e.level}] ${e.text}`), '',
    `Newest startup trace: ${i.newestTracePath ?? '(none)'}`, '',
    'Delete this note after diagnosis.',
  ];
  const secrets = ['vaultSecret', 'deviceKey']
    .map(k => (typeof i.settings[k] === 'string' ? i.settings[k] : ''))
    .filter(Boolean);
  return secrets.reduce((text, secret) => redact(text, secret), lines.join('\n'));
}

/**
 * Gate before writing any diagnostics surface: neither the vault secret nor
 * the per-device key (S1b invite redemption) may ever reach disk.
 */
export function assertNoSecret(text: string, ...secrets: string[]): void {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new Error('diagnostics contain the vault secret');
  }
}
