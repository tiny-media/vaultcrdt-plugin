import { describe, it, expect, vi } from 'vitest';
import { ensureDeviceIdentity, DEFAULT_SETTINGS, type VaultCRDTSettings } from '../settings';

// Pure helper test — no Obsidian runtime dependencies. defaultDeviceName is
// stubbed via the third parameter so Platform.isDesktopApp never runs.

const makeSettings = (overrides: Partial<VaultCRDTSettings> = {}): VaultCRDTSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

describe('ensureDeviceIdentity', () => {
  it('fills missing peerId and deviceName', () => {
    const settings = makeSettings({ peerId: '', deviceName: '' });
    const genPeerId = vi.fn(() => 'generated-peer');
    const genDeviceName = vi.fn(() => 'generated-device');

    const changed = ensureDeviceIdentity(settings, genPeerId, genDeviceName);

    expect(changed).toBe(true);
    expect(settings.peerId).toBe('generated-peer');
    expect(settings.deviceName).toBe('generated-device');
    expect(genPeerId).toHaveBeenCalledTimes(1);
    expect(genDeviceName).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite existing values', () => {
    const settings = makeSettings({ peerId: 'existing-peer', deviceName: 'existing-device' });
    const genPeerId = vi.fn(() => 'should-not-be-used');
    const genDeviceName = vi.fn(() => 'should-not-be-used');

    const changed = ensureDeviceIdentity(settings, genPeerId, genDeviceName);

    expect(changed).toBe(false);
    expect(settings.peerId).toBe('existing-peer');
    expect(settings.deviceName).toBe('existing-device');
    expect(genPeerId).not.toHaveBeenCalled();
    expect(genDeviceName).not.toHaveBeenCalled();
  });

  it('returns false when nothing was missing', () => {
    const settings = makeSettings({ peerId: 'p', deviceName: 'd' });
    expect(ensureDeviceIdentity(settings, () => 'x', () => 'y')).toBe(false);
  });

  it('returns true when only peerId was missing', () => {
    const settings = makeSettings({ peerId: '', deviceName: 'existing' });
    const changed = ensureDeviceIdentity(settings, () => 'new-peer', () => 'unused');
    expect(changed).toBe(true);
    expect(settings.peerId).toBe('new-peer');
    expect(settings.deviceName).toBe('existing');
  });

  it('returns true when only deviceName was missing', () => {
    const settings = makeSettings({ peerId: 'existing', deviceName: '' });
    const changed = ensureDeviceIdentity(settings, () => 'unused', () => 'new-device');
    expect(changed).toBe(true);
    expect(settings.peerId).toBe('existing');
    expect(settings.deviceName).toBe('new-device');
  });
});
