import { describe, it, expect, vi } from 'vitest';
import { Inbox, INBOX_FILE, DISCOVERY_THROTTLE_MS, type InboxFile } from '../inbox';
import { INBOX_COPY } from '../user-facing-copy';

function makeStorage() {
  const files = new Map<string, unknown>();
  return {
    files,
    async loadJson<T>(name: string): Promise<T | null> { return (files.get(name) as T) ?? null; },
    async saveJson(name: string, value: unknown): Promise<void> { files.set(name, value); },
  };
}

function makeInbox(opts: { existing?: string[]; now?: () => number } = {}) {
  const storage = makeStorage();
  const present = new Set(opts.existing ?? []);
  const notices: string[] = [];
  const inbox = new Inbox({
    storage,
    fileExists: (p) => present.has(p),
    notify: (t) => notices.push(t),
    now: opts.now,
  });
  return { inbox, storage, notices, present };
}

describe('inbox storage', () => {
  it('round-trips entries in the {v:1, items:[…]} shape', async () => {
    const { inbox, storage } = makeInbox({ existing: ['a (conflict 2026-09-06).md'] });
    await inbox.load();
    inbox.add({ kind: 'conflict', path: 'a (conflict 2026-09-06).md', relatedPath: 'a.md', note: 'n' });
    await inbox.flush();
    const raw = storage.files.get(INBOX_FILE) as InboxFile;
    expect(raw.v).toBe(1);
    expect(raw.items).toHaveLength(1);
    expect(raw.items[0]).toMatchObject({ kind: 'conflict', path: 'a (conflict 2026-09-06).md', relatedPath: 'a.md' });
    expect(typeof raw.items[0].id).toBe('string');
    expect(typeof raw.items[0].createdAt).toBe('number');

    const second = new Inbox({
      storage, fileExists: () => true, notify: () => {},
    });
    await second.load();
    expect(second.count()).toBe(1);
    expect(second.list()[0].note).toBe('n');
  });

  it('ignores a corrupt or unversioned file', async () => {
    const { inbox, storage } = makeInbox();
    storage.files.set(INBOX_FILE, { v: 99, items: [{ id: 'x', kind: 'conflict', path: 'p' }] });
    await inbox.load();
    expect(inbox.count()).toBe(0);
  });
});

describe('inbox reconcile', () => {
  it('clears a conflict entry when the conflict copy is deleted', async () => {
    const c = 'a (conflict 2026-09-06).md';
    const { inbox } = makeInbox({ existing: [c] });
    await inbox.load();
    inbox.add({ kind: 'conflict', path: c, relatedPath: 'a.md' });
    expect(inbox.count()).toBe(1);
    inbox.onFileDeleted(c);
    expect(inbox.count()).toBe(0);
  });

  it('clears on rename away from the conflict pattern and follows a conflict rename', async () => {
    const c = 'a (conflict 2026-09-06).md';
    const { inbox } = makeInbox({ existing: [c] });
    await inbox.load();
    inbox.add({ kind: 'conflict', path: c });
    inbox.onFileRenamed(c, 'sub/a (conflict 2026-09-06).md');
    expect(inbox.list()[0].path).toBe('sub/a (conflict 2026-09-06).md');
    inbox.onFileRenamed('sub/a (conflict 2026-09-06).md', 'merged.md');
    expect(inbox.count()).toBe(0);
  });

  it('clears a tombstone-rename entry on rename away from the (deleted-remote pattern and follows while it stays', async () => {
    const kept = 'a (deleted-remote).md';
    const { inbox } = makeInbox({ existing: [kept] });
    await inbox.load();
    inbox.add({ kind: 'tombstone-rename', path: kept, relatedPath: 'a.md' });
    inbox.onFileRenamed(kept, 'a (deleted-remote 2).md');
    expect(inbox.list()[0].path).toBe('a (deleted-remote 2).md');
    inbox.onFileRenamed('a (deleted-remote 2).md', 'kept-locally.md');
    expect(inbox.count()).toBe(0);
  });

  it('follows a deleted-remote rename (entry is about the file, not a pattern)', async () => {
    const { inbox } = makeInbox({ existing: ['a.md'] });
    await inbox.load();
    inbox.add({ kind: 'deleted-remote', path: 'a.md' });
    inbox.onFileRenamed('a.md', 'moved.md');
    expect(inbox.list()[0].path).toBe('moved.md');
  });

  it('drops file-kind entries whose file vanished while the plugin was off', async () => {
    const storage = makeStorage();
    storage.files.set(INBOX_FILE, {
      v: 1, items: [
        { id: '1', kind: 'conflict', path: 'gone (conflict 2026-09-06).md', createdAt: 1 },
        { id: '2', kind: 'failed-docs', path: '', createdAt: 1 },
      ],
    });
    const inbox = new Inbox({ storage, fileExists: () => false, notify: () => {} });
    await inbox.load();
    expect(inbox.count()).toBe(1);
    expect(inbox.list()[0].kind).toBe('failed-docs');
  });
});

describe('inbox startup scan', () => {
  it('adopts a pre-existing "(conflict" file with no entry', async () => {
    const c = 'notes/a (conflict 2026-09-05).md';
    const { inbox } = makeInbox({ existing: [c] });
    await inbox.load();
    inbox.scanExisting(['notes/a.md', c]);
    expect(inbox.count()).toBe(1);
    expect(inbox.list()[0]).toMatchObject({ kind: 'conflict', path: c, note: INBOX_COPY.scanNote });
    inbox.scanExisting(['notes/a.md', c]);
    expect(inbox.count()).toBe(1);
  });
});

describe('inbox discovery notice throttle', () => {
  it('fires at most once per 5 minutes', async () => {
    let t = 1_000_000;
    const { inbox, notices, present } = makeInbox({ now: () => t });
    await inbox.load();
    present.add('x (conflict 2026-09-06).md');
    inbox.add({ kind: 'conflict', path: 'x (conflict 2026-09-06).md' });
    inbox.add({ kind: 'tombstone-edit', path: 'y.md' });
    expect(notices).toEqual([INBOX_COPY.discovery]);
    t += DISCOVERY_THROTTLE_MS + 1;
    inbox.add({ kind: 'tombstone-edit', path: 'z.md' });
    expect(notices).toHaveLength(2);
  });

  it('does not duplicate an identical entry', async () => {
    const { inbox } = makeInbox();
    await inbox.load();
    const add = vi.fn(() => inbox.add({ kind: 'deleted-remote', path: 'a.md' }));
    add(); add();
    expect(inbox.count()).toBe(1);
  });
});
