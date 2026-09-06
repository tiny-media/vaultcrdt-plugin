import { redact } from './logger';

export const TRUST_NOTICE_TEXT =
  'VaultCRDT does not currently use end-to-end encryption. The server operator can technically read the paths and contents of synced Markdown notes. Use only a server operator you trust.';

export function conflictNoticeMessage(conflictPath: string): string {
  return `VaultCRDT: created conflict copy ${redact(conflictPath)}. Open both files, merge the text you want to keep, and delete the conflict copy only after checking it.`;
}

export function remoteDeleteKeptNoticeMessage(docUuid: string): string {
  return `VaultCRDT: "${redact(docUuid)}" was deleted on another device, but this device has unsynced edits in it. The file was kept and will be re-created on the server from this local version at the next sync. If you meant to delete it, delete it again here.`;
}

export function tombstoneRenamedNoticeMessage(docUuid: string, keptPath: string): string {
  return `VaultCRDT: "${redact(docUuid)}" was deleted on another device. Your local copy was renamed to "${redact(keptPath)}" and syncs under that name; the original name stays deleted.`;
}

export function authRejectedNoticeMessage(): string {
  return 'VaultCRDT: the server rejected this device\'s credentials. Check the vault name and vault secret in Settings, then retry.';
}

export function protocolMismatchNoticeMessage(server: number, client: number): string {
  return server < client
    ? `VaultCRDT: the server is older than this plugin (protocol server=${server}, plugin=${client}). SERVER NEEDS UPDATE — sync is paused until then.`
    : `VaultCRDT: this plugin is too old for the server (protocol server=${server}, plugin=${client}). CLIENT TOO OLD — update the plugin.`;
}

export function protocolHealthText(server: number | undefined, client: number): string {
  if (server === client) return 'protocol OK';
  return `${server === undefined || server < client ? 'SERVER NEEDS UPDATE' : 'CLIENT TOO OLD'} (protocol server=${server ?? 0}, plugin=${client})`;
}

export function tombstoneNoticeMessage(docUuid: string): string {
  return `VaultCRDT: "${redact(docUuid)}" was deleted on another device, so this edit will not sync. Save important text under a new filename, then check Trash and your other synced device.`;
}

/** Cap-skip notice (design §3): the only UI the attachment upload lane has. */
export function attachmentTooLargeMessage(path: string, capBytes: number): string {
  return `VaultCRDT: "${redact(path)}" is larger than the ${Math.round(capBytes / (1024 * 1024))} MB attachment limit and will not sync.`;
}

export const INBOX_COPY = {
  discovery: 'VaultCRDT: 1 new item in inbox',
  title: 'VaultCRDT inbox',
  empty: 'Nothing to review.',
  dismiss: 'Dismiss',
  openBoth: 'Open both files',
  scanNote: 'Found during startup scan.',
  kind: {
    'conflict': 'Conflict copy created',
    'disjoint-conflict': 'Conflict copy created (separate edit histories)',
    'deleted-remote': 'Deleted on another device, kept here',
    'tombstone-edit': 'Edit will not sync (deleted on another device)',
    'tombstone-rename': 'Renamed because it was deleted on another device',
    'failed-docs': 'Documents failed to sync',
  },
};

export const PANEL_COPY = {
  title: 'VaultCRDT',
  ribbon: 'VaultCRDT status',
  // Phones render no ribbon and no status bar — these commands are the only
  // way to reach the panel and the inbox there (command palette / toolbar).
  command: 'Open status panel', inboxCommand: 'Open conflict inbox',
  connected: 'Connected', offline: 'Not connected',
  lastActivity: 'Last server activity', lastSync: 'Last full sync',
  unconfirmed: 'Unconfirmed pushes (since last full sync)',
  inbox: 'Inbox', openInbox: 'Open inbox', never: 'never',
  syncNow: 'Sync now', invite: 'Invite a device',
  diagnostics: 'Export diagnostics', settings: 'Settings',
};

export function failedDocsNoticeMessage(count: number): string {
  return `VaultCRDT: ${count} document(s) failed to sync — see the inbox`;
}

export function relativeTimeText(at: number, now: number): string {
  if (!at) return PANEL_COPY.never;
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** The wasm ships as a sibling file next to main.js; a missing copy is a broken install. */
export const WASM_MISSING_NOTICE =
  'VaultCRDT: installation incomplete — vaultcrdt_wasm_bg.wasm is missing next to main.js. Reinstall the plugin.';

export const PLUGIN_REPO = 'tiny-media/vaultcrdt-plugin';
export const SETUP_COPY = {
  title: 'Setup link', command: 'Invite a device', change: 'change',
  server: 'Server', vault: 'Vault Name',
  join: 'I trust this server - Join', secret: "Vault secret — paste it, don't type it",
  required: 'Vault secret is required', device: 'Device name', paste: 'Paste',
  pasteFailed: 'Clipboard unavailable — paste into the field.',
  update: 'This link needs a newer VaultCRDT plugin',
  invite: 'Invite token detected - it will be used automatically once your server supports it.',
  inviteHintExpired: 'This invite has expired. Ask for the vault secret instead and paste it below.',
  inviteHintUsed: 'This invite was already used. Ask for the vault secret instead and paste it below.',
  inviteHintInvalid: 'This invite is not valid. Ask for the vault secret instead and paste it below.',
  invalid: 'Invalid setup link. Check the version, HTTPS server, vaultId and invite token.',
  https: 'Setup links require an HTTPS server. Enter local server details manually in Settings.',
  cancel: 'Cancel', replace: 'Replace connection', copy: 'Copy', copied: 'Copied',
  copyFailed: 'Could not copy. Please copy manually.', copySecret: 'Copy vault secret',
  bratLabel: 'Plugin install link', uriLabel: 'Setup link', secretLabel: 'Vault secret',
  secretQr: 'Show secret as QR', secretAdvice: 'Send the secret as a disappearing message / delete after joining.',
  help: 'Install help',
  step1: '1. Install Obsidian, then install BRAT from Community plugins.',
  step2: '2. Tap this link on the phone to install VaultCRDT:',
  step3: '3. Then scan the setup QR below.',
  configure: 'VaultCRDT: open Settings to configure sync',
  failed: 'VaultCRDT: setup failed — check Settings',
  qrFailed: 'This link is too long for a QR. Copy the link instead.',
  inviteActive: 'One-use invite active for about {minutes} min — the other device only needs to scan it. No secret required.',
  setupLinkOnly: 'This server does not support invites yet: the link prefills the form, but the vault secret must still be sent separately.',
};
export const joinTitle = (vault: string): string => `Join vault ${vault}`;
export const invitedHost = (host: string): string => `Invited to ${host}`;
export const replaceConnectionText = (vault: string): string =>
  `Replace current connection to ${vault}? Local sync state will be wiped.`;
