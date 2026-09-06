import { describe, it, expect } from 'vitest';
import { StartupDirtyTracker } from '../startup-dirty-tracker';

const makeStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
};

describe('StartupDirtyTracker', () => {
  it('persists dirty paths in device-local storage', () => {
    const storage = makeStorage();
    const trackerA = new StartupDirtyTracker('vault-a', 'peer-a', storage);
    trackerA.markDirty('note.md');
    trackerA.markDirty('other.md');

    const trackerB = new StartupDirtyTracker('vault-a', 'peer-a', storage);
    expect([...trackerB.snapshot()].sort()).toEqual(['note.md', 'other.md']);
  });

  it('keeps vaults isolated by storage key', () => {
    const storage = makeStorage();
    const trackerA = new StartupDirtyTracker('vault-a', 'peer-a', storage);
    const trackerB = new StartupDirtyTracker('vault-b', 'peer-a', storage);

    trackerA.markDirty('note.md');
    expect(trackerB.snapshot().size).toBe(0);
  });

  it('clearAll removes the local record', () => {
    const storage = makeStorage();
    const trackerA = new StartupDirtyTracker('vault-a', 'peer-a', storage);
    trackerA.markDirty('note.md');
    trackerA.clearAll();

    const trackerB = new StartupDirtyTracker('vault-a', 'peer-a', storage);
    expect(trackerB.snapshot().size).toBe(0);
  });
});
