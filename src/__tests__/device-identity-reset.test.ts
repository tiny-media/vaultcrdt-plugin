import { describe, it, expect, vi } from 'vitest';
import { regeneratePeerId, DEFAULT_SETTINGS, type VaultCRDTSettings } from '../settings';
import { StartupDirtyTracker } from '../startup-dirty-tracker';

// Pure-helper + peer-bound-state tests for the device-identity reset (A2.6).
// No Obsidian runtime is exercised — regeneratePeerId is pure and the tracker
// takes an injected storage stub.

const makeSettings = (overrides: Partial<VaultCRDTSettings> = {}): VaultCRDTSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

const makeStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
};

describe('regeneratePeerId', () => {
  it('assigns a new, non-empty peerId that differs from the old one', () => {
    const settings = makeSettings({ peerId: 'old-peer' });
    const { oldPeerId, newPeerId } = regeneratePeerId(settings);
    expect(oldPeerId).toBe('old-peer');
    expect(newPeerId).not.toBe('');
    expect(newPeerId).not.toBe('old-peer');
    expect(settings.peerId).toBe(newPeerId);
  });

  it('uses the injected generator', () => {
    const settings = makeSettings({ peerId: 'old-peer' });
    const gen = vi.fn(() => 'fresh-peer');
    const { newPeerId } = regeneratePeerId(settings, gen);
    expect(newPeerId).toBe('fresh-peer');
    expect(settings.peerId).toBe('fresh-peer');
    expect(gen).toHaveBeenCalled();
  });

  it('regenerates when the generator collides with the current id', () => {
    const settings = makeSettings({ peerId: 'dup' });
    const gen = vi.fn<() => string>()
      .mockReturnValueOnce('dup')
      .mockReturnValueOnce('unique');
    const { newPeerId } = regeneratePeerId(settings, gen);
    expect(newPeerId).toBe('unique');
    expect(gen).toHaveBeenCalledTimes(2);
  });
});

describe('device-identity reset — peer-bound local state', () => {
  it('the new peerId maps to a different, empty startup-dirty key', () => {
    const storage = makeStorage();
    const vaultId = 'vault-x';

    const oldTracker = new StartupDirtyTracker(vaultId, 'old-peer', storage);
    oldTracker.markDirty('note.md');
    expect(oldTracker.snapshot().size).toBe(1);

    // A fresh identity means a fresh (empty) device-local dirty set — the
    // peer-bound state is invalidated by construction, not carried over.
    const newTracker = new StartupDirtyTracker(vaultId, 'new-peer', storage);
    expect(newTracker.snapshot().size).toBe(0);
  });

  it('clearing the old peer key before reset removes its localStorage litter', () => {
    const storage = makeStorage();
    const vaultId = 'vault-x';

    const oldTracker = new StartupDirtyTracker(vaultId, 'old-peer', storage);
    oldTracker.markDirty('note.md');
    expect(storage.map.size).toBe(1);

    // What SyncEngine.clearStartupDirtyForIdentityReset() does on the old engine.
    oldTracker.clearAll();
    expect(storage.map.size).toBe(0);
  });
});
