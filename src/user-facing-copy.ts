import { redact } from './logger';

export const TRUST_NOTICE_TEXT =
  'VaultCRDT does not currently use end-to-end encryption. The server operator can technically read the paths and contents of synced Markdown notes. Use only a server operator you trust.';

export function conflictNoticeMessage(conflictPath: string): string {
  return `VaultCRDT: created conflict copy ${redact(conflictPath)}. Open both files, merge the text you want to keep, and delete the conflict copy only after checking it.`;
}

export function excalidrawConflictNoticeMessage(conflictPath: string): string {
  return `VaultCRDT: concurrent edits to this drawing were not merged. Your version was saved as ${redact(conflictPath)}. The synced file kept the other device's version. Open both files, keep the drawing you want, and delete the conflict copy only after checking it.`;
}

export function remoteDeleteKeptNoticeMessage(docUuid: string): string {
  return `VaultCRDT: "${redact(docUuid)}" was deleted on another device, but this device has unsynced edits in it. The file was kept and will be re-created on the server from this local version at the next sync. If you meant to delete it, delete it again here.`;
}

export const remoteDeleteTrashedNoticeMessage = (path: string): string =>
  `VaultCRDT: "${redact(path)}" was deleted on another device and moved to trash.`;

export const remoteDeleteRemovedNoticeMessage = (path: string): string =>
  `VaultCRDT: "${redact(path)}" was deleted on another device and removed.`;

export function tombstoneRenamedNoticeMessage(docUuid: string, keptPath: string): string {
  return `VaultCRDT: "${redact(docUuid)}" was deleted on another device. Your local copy was renamed to "${redact(keptPath)}" and syncs under that name; the original name stays deleted.`;
}

export function authRejectedNoticeMessage(): string {
  return 'VaultCRDT: the server rejected this device\'s credentials. Check the vault ID and vault secret in Settings, then retry.';
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

/** Vault-wide quota pause (design §3): same MB rounding as the per-file cap notice. */
export function quotaExceededMessage(quotaBytes: number): string {
  return `VaultCRDT: this vault is over the ${Math.round(quotaBytes / (1024 * 1024))} MB storage limit and attachments will not sync.`;
}

export function svgRejectedMessage(path: string, reason: string): string {
  return `VaultCRDT: "${redact(path)}" could not be synced as SVG (${reason}) and will not upload.`;
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

/** The wasm is embedded in main.js; a failure here means a damaged or partial install. */
export const WASM_INIT_FAILED_NOTICE =
  'VaultCRDT: the WebAssembly module failed to load — the installation looks damaged. Reinstall the plugin.';

export const PLUGIN_REPO = 'tiny-media/vaultcrdt-plugin';
export const SETUP_COPY = {
  title: 'Setup link', command: 'Invite a device', change: 'change',
  server: 'Server', vault: 'Vault ID',
  join: 'I trust this server - Join', secret: "Vault secret — paste it, don't type it",
  required: 'Vault secret is required', device: 'Device name', paste: 'Paste',
  vaultInvalid: 'Vault ID must be lowercase letters, numbers, or hyphens (e.g. my-notes)',
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
  scanFirst: 'Scan this code on the new device, or send the link.',
  pasteLinkLabel: 'Invite link',
  pasteLinkDesc: 'The easiest way: get an invite link or QR code from your admin or from an already-set-up device. Paste the link here.',
  pasteLinkPlaceholder: 'obsidian://vaultcrdt/setup?...',
  pasteLinkInvalid: 'That does not look like a VaultCRDT invite link.',
  manualSection: 'Enter server details by hand',
  configure: 'VaultCRDT: open Settings to configure sync',
  failed: 'VaultCRDT: setup failed — check Settings',
  qrFailed: 'This link is too long for a QR. Copy the link instead.',
  inviteActive: 'One-use invite active for about {minutes} min — the other device only needs to scan it. No secret required.',
  setupLinkOnly: 'This server does not support invites yet: the link prefills the form, but the vault secret must still be sent separately.',
};
/**
 * BRAT install walkthrough for the person guiding a new device. Self-contained
 * block: once the plugin is in the community directory, delete this constant
 * and its single use in InviteModal.
 */
export const NEW_DEVICE_HELP = {
  summary: 'Installing on the new device',
  steps: [
    '1. Install Obsidian, open your vault, and leave restricted mode: "Community plugins" → "Turn on community plugins".',
    '2. In "Community plugins" → "Browse", search for "brat", install it, and enable it.',
    '3. In the BRAT options: "Beta plugin list" → "+" → repository tiny-media/vaultcrdt-plugin → "Add Plugin".',
    '4. VaultCRDT appears — open it and scan or paste the invite link from above.',
  ],
};

export const joinTitle = (vault: string): string => `Join vault ${vault}`;
export const invitedHost = (host: string): string => `Invited to ${host}`;
export const replaceConnectionText = (vault: string): string =>
  `Replace current connection to ${vault}? Local sync state will be wiped.`;

export const OBSIDIAN_SYNC_COPY = {
  heading: '.obsidian sync',
  settingsName: 'Sync app and appearance settings',
  settingsDesc:
    'Whole-file last-write-wins: concurrent edits on two devices keep only the newer side. No JSON-key merge and no conflict copies. Always uses the folder name .obsidian — a custom configDir is not synced.',
  stylesName: 'Sync snippets and themes',
  stylesDesc:
    'Whole-file last-write-wins for each CSS/theme file: concurrent edits keep only the newer side; no conflict copies. workspace.json, workspace-mobile.json, and .obsidian/plugins/ never sync, regardless of these toggles.',
  neverSyncs:
    'Never synced: workspace.json, workspace-mobile.json, and plugin data/binaries — regardless of these toggles.',
  configDirNote:
    'Uses the hardcoded folder name .obsidian; a custom configDir is not synced.',
};

export const SETTINGS_COPY = {
  vaultSecret: 'Vault secret',
  vaultSecretPlaceholder: 'vault secret',
  vaultSecretDesc: 'Shared secret for this vault. Must be identical on every device that syncs this vault.',
  vaultSecretDeviceKey: 'Authenticated via device key',
  vaultSecretDeviceKeyDesc: 'This device joined via invite link. The vault secret is not used here.',
  serverUrlDesc: 'Address of your VaultCRDT server. WebSocket connection is derived automatically. Changing this resets the device key and connection state.',
  vaultIdSwitch: 'Switching vaults runs setup again',
  joinDifferentVault: 'Join a different vault',
  openSetup: 'Open setup…',
  connection: 'Connection',
  sync: 'Sync',
  about: 'About',
  developer: 'Developer',
  addDevice: 'Add another device',
  addDeviceDesc: 'Shows an invite link and a QR code for the new device.',
  addDeviceButton: 'Add device',
  statusName: 'Status',
  statusChecking: 'Checking…',
  keepSettings: 'Keep app settings the same on all devices',
  carryStyles: 'Carry themes & CSS snippets over',
  documentation: 'Documentation',
  documentationDesc: 'Setup, troubleshooting and server notes.',
  copyDiagnostics: 'Copy diagnostics report',
  copyDiagnosticsDesc: 'Copies a report without secrets to the clipboard.',
  limits: 'Limits',
  attachmentCaps: 'Attachment limits',
  attachmentCapsValue: 'images 10 MiB · PDF 10 MiB · audio 25 MiB · .obsidian files 2 MiB',
  fullSync: 'Full sync',
  fullSyncDesc: 'Pull all documents from the server and push all local files',
  runFullSync: 'Run full sync',
};

/** Settings B7: invite-joined devices authenticate with deviceKey, not the shared secret. */
export function vaultSecretSetting(deviceKey: string | undefined): {
  usesTextField: boolean;
  name: string;
  desc: string;
  placeholder: string;
  readonlyLine: string;
} {
  if (deviceKey) {
    return {
      usesTextField: false,
      name: SETTINGS_COPY.vaultSecret,
      desc: SETTINGS_COPY.vaultSecretDeviceKeyDesc,
      placeholder: '',
      readonlyLine: SETTINGS_COPY.vaultSecretDeviceKey,
    };
  }
  return {
    usesTextField: true,
    name: SETTINGS_COPY.vaultSecret,
    desc: SETTINGS_COPY.vaultSecretDesc,
    placeholder: SETTINGS_COPY.vaultSecretPlaceholder,
    readonlyLine: '',
  };
}

/** Ribbon variant (b): count badge, or an empty dot when offline with an empty inbox. */
export function ribbonBadgeState(count: number, connected: boolean): { text: string; offlineDot: boolean } {
  return {
    text: count > 0 ? String(count) : '',
    offlineDot: !connected && count === 0,
  };
}
