import { readFileSync } from 'node:fs';
import { decode, encode } from '@msgpack/msgpack';
import { TFile } from 'obsidian';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWatcher } from '../file-watcher';
import { isSyncablePath } from '../path-policy';
import { PROTOCOL_VERSION } from '../protocol';
import type { VaultCRDTSettings } from '../settings';
import { SyncEngine } from '../sync-engine';
import { fnv1aHash64 } from '../conflict-utils';
import { remoteDeleteKeptNoticeMessage } from '../user-facing-copy';
import initWasmModule, { WasmSyncDocument } from '../../wasm/vaultcrdt_wasm';

/**
 * Long-divergence integration tests at real-CRDT fidelity.
 *
 * Drive level: FULL ENGINE. Two (or three) real SyncEngine instances talk the
 * real protocol through a MiniServer of WasmSyncDocument instances. Broadcasts,
 * keep-guard, and initial-sync run on the production paths. Private methods
 * are not invoked directly.
 */

const PINNED_ISO = '2026-09-07T12:00:00.000Z';
const VAULT_ID = 'vault-div';
const FILE_COUNT = 50;
const PRE_OPS_PER_SIDE = 200;
const QUIET_CAP = 10_000;
const STATE_DIR = '.obsidian/plugins/vaultcrdt/state';
const MUTATING_TYPES = new Set(['sync_push', 'doc_create', 'doc_delete']);
type FsContent = string | Uint8Array;
type FsEntry = { content: FsContent; mtime: number };

type PlanOp =
  | { op: 'edit'; file: string; find: string; replace: string; via: 'engine' | 'fs'; class: string }
  | { op: 'append'; file: string; text: string; via: 'engine' | 'fs'; class: string }
  | { op: 'create'; file: string; content: string; via: 'engine' | 'fs'; class: string }
  | { op: 'delete'; file: string; via: 'engine' | 'fs'; class: string }
  | { op: 'rename'; from: string; to: string; via: 'engine' | 'fs'; class: string };

interface InboxCapture {
  kind: string;
  path: string;
  relatedPath?: string;
  note?: string;
}

interface ConnState {
  authed: boolean;
  peerId: string;
  outbound: Uint8Array[];
}

function notePath(i: number): string {
  return `notes/n${String(i).padStart(2, '0')}.md`;
}

function seedText(i: number): string {
  const id = String(i).padStart(2, '0');
  return [
    `# Note ${id}`,
    '',
    `SEED_${id}_HEAD`,
    'left-region',
    `SEED_${id}_MID`,
    'right-region',
    `SEED_${id}_TAIL`,
  ].join('\n');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function encodeFrame(msg: object): Uint8Array {
  return Uint8Array.from(encode(msg));
}

function fieldString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function rethrow(err: unknown): never {
  throw err instanceof Error ? err : new Error('unknown failure');
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}
function parseVV(json: string): Record<string, number> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

function vvBytes(doc: WasmSyncDocument): Uint8Array {
  return new TextEncoder().encode(doc.export_vv_json());
}

function isConflictCopyPath(path: string): boolean {
  return path.includes('(conflict');
}

function isLiveSyncPath(path: string): boolean {
  return isSyncablePath(path) && !isConflictCopyPath(path) && !path.includes('(deleted-remote');
}

function makeTFile(path: string, mtime: number, size: number): TFile {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    basename: dot >= 0 ? base.slice(0, dot) : base,
    extension: dot >= 0 ? base.slice(dot + 1) : '',
    stat: { mtime, size, ctime: mtime },
  });
}

function makeSettings(peerId: string): VaultCRDTSettings {
  return {
    serverUrl: 'http://localhost:3737',
    vaultSecret: 'test-secret',
    deviceKey: '',
    peerId,
    vaultId: VAULT_ID,
    deviceName: `device-${peerId}`,
    showSyncStatus: false,
    onboardingComplete: true,
  };
}

function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(window, 'localStorage', { value: localStorage, configurable: true });
  return map;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
class MemoryFS {
  readonly store = new Map<string, FsEntry>();
  readonly folders = new Set<string>();
  private clock = 1_000_000;

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  ensureParents(path: string): void {
    const parts = path.split('/');
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      this.folders.add(acc);
    }
  }

  writeText(path: string, content: string): void {
    this.ensureParents(path);
    this.store.set(path, { content, mtime: this.tick() });
  }

  writeBinary(path: string, content: Uint8Array): void {
    this.ensureParents(path);
    this.store.set(path, { content: copyBytes(content), mtime: this.tick() });
  }

  readText(path: string): string {
    const entry = this.store.get(path);
    if (!entry) throw new Error(`readText missing: ${path}`);
    if (typeof entry.content !== 'string') return new TextDecoder().decode(entry.content);
    return entry.content;
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  remove(path: string): void {
    this.store.delete(path);
  }

  rename(from: string, to: string): void {
    const entry = this.store.get(from);
    if (!entry) throw new Error(`rename missing: ${from}`);
    this.store.delete(from);
    this.ensureParents(to);
    this.store.set(to, { content: entry.content, mtime: this.tick() });
  }

  mdPaths(): string[] {
    return [...this.store.keys()].filter((p) => p.endsWith('.md') && isSyncablePath(p)).sort();
  }

  scrambleMtimes(rng: () => number): void {
    for (const [path, entry] of this.store) {
      if (!path.endsWith('.md')) continue;
      entry.mtime = Math.floor(rng() * 2_000_000_000);
    }
  }

  tfile(path: string): TFile | null {
    const entry = this.store.get(path);
    if (!entry || !path.endsWith('.md')) return null;
    const size = typeof entry.content === 'string' ? entry.content.length : entry.content.byteLength;
    return makeTFile(path, entry.mtime, size);
  }
  makeApp(): any {
    const adapter = {
      exists: async (path: string) => this.store.has(path) || this.folders.has(path) || path === STATE_DIR,
      read: async (path: string) => {
        const entry = this.store.get(path);
        if (!entry) throw new Error(`adapter.read missing: ${path}`);
        return typeof entry.content === 'string' ? entry.content : new TextDecoder().decode(entry.content);
      },
      readBinary: async (path: string) => {
        const entry = this.store.get(path);
        if (!entry) throw new Error(`adapter.readBinary missing: ${path}`);
        if (entry.content instanceof Uint8Array) {
          return entry.content.buffer.slice(
            entry.content.byteOffset,
            entry.content.byteOffset + entry.content.byteLength,
          );
        }
        return new TextEncoder().encode(entry.content).buffer;
      },
      write: async (path: string, content: string) => { this.writeText(path, content); },
      writeBinary: async (path: string, content: ArrayBuffer) => {
        this.writeBinary(path, new Uint8Array(content));
      },
      mkdir: async (path: string) => { this.folders.add(path); },
      remove: async (path: string) => { this.store.delete(path); },
      list: async (dir: string) => {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const files = [...this.store.keys()].filter((p) => p.startsWith(prefix));
        const folders = [...this.folders].filter((p) => p.startsWith(prefix));
        return { files, folders };
      },
      stat: async (path: string) => {
        const entry = this.store.get(path);
        if (!entry) return null;
        const size = typeof entry.content === 'string' ? entry.content.length : entry.content.byteLength;
        return { mtime: entry.mtime, size, ctime: entry.mtime };
      },
    };

    const vault = {
      adapter,
      getMarkdownFiles: () => this.mdPaths().map((p) => this.tfile(p)!),
      read: async (file: TFile | string) => this.readText(typeof file === 'string' ? file : file.path),
      cachedRead: async (file: TFile) => this.readText(file.path),
      modify: async (file: TFile, content: string) => { this.writeText(file.path, content); },
      create: async (path: string, content: string) => {
        if (this.store.has(path)) throw new Error(`already exists: ${path}`);
        this.writeText(path, content);
        return this.tfile(path)!;
      },
      createFolder: async (dir: string) => { this.folders.add(dir); },
      getAbstractFileByPath: (path: string) => {
        if (this.folders.has(path)) return { path };
        return this.tfile(path);
      },
      trash: async (file: TFile) => { this.remove(file.path); },
      on: () => {},
    };

    const fileManager = {
      trashFile: async (file: TFile) => { this.remove(file.path); },
      renameFile: async (file: TFile, newPath: string) => {
        this.rename(file.path, newPath);
        file.path = newPath;
      },
    };

    return {
      vault,
      fileManager,
      workspace: {
        on: () => {},
        getActiveViewOfType: () => null,
        iterateAllLeaves: (_cb: (leaf: unknown) => void) => {},
      },
    };
  }
}
let activeServer: MiniServer | null = null;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  binaryType = 'arraybuffer';
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private _onopen: ((ev: Event) => void) | null = null;
  private opened = false;

  constructor(url: string) {
    this.url = url;
    if (!activeServer) throw new Error('MockWebSocket: no active MiniServer');
    activeServer.attach(this);
  }

  get onopen(): ((ev: Event) => void) | null {
    return this._onopen;
  }

  set onopen(fn: ((ev: Event) => void) | null) {
    this._onopen = fn;
    if (fn && !this.opened && this.readyState === MockWebSocket.OPEN) {
      this.opened = true;
      queueMicrotask(() => {
        fn.call(this, {} as Event);
      });
    }
  }

  send(data: Uint8Array | ArrayBuffer): void {
    if (!activeServer) throw new Error('MockWebSocket.send: no server');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    activeServer.handle(this, bytes);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    activeServer?.detach(this);
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  }
}
class MiniServer {
  readonly docs = new Map<string, WasmSyncDocument>();
  readonly tombstones = new Set<string>();
  readonly tombstoneHashes = new Map<string, string>();
  readonly omitTombstoneHashUuids = new Set<string>();
  /**
   * Pre-fix server regime: refuse any push/create for a tombstoned path even
   * when a live documents row exists. Default false = post-fix server (the
   * live row wins).
   */
  refuseOnAnyTombstone = false;
  /** Test hook: record inbound `doc_delete` then discard it (no tombstone/ack). */
  readonly dropDocDeletes = new Set<string>();
  readonly conns = new Map<MockWebSocket, ConnState>();
  readonly inbound: Array<{ peerId: string; type: string; docUuid?: string }> = [];
  inboundOffset = 0;

  attach(ws: MockWebSocket): void {
    const url = new URL(ws.url);
    const peerId = url.searchParams.get('peer_id') ?? '';
    this.conns.set(ws, { authed: false, peerId, outbound: [] });
  }

  detach(ws: MockWebSocket): void {
    this.conns.delete(ws);
  }

  queuedCount(): number {
    let n = 0;
    for (const conn of this.conns.values()) n += conn.outbound.length;
    return n;
  }

  deliverAll(): number {
    let delivered = 0;
    for (const [ws, conn] of this.conns) {
      const batch = conn.outbound.splice(0);
      for (const bytes of batch) {
        const copy = copyBytes(bytes);
        ws.onmessage?.({ data: copy.buffer } as MessageEvent);
        delivered++;
      }
    }
    return delivered;
  }

  mutatingSinceCheckpoint(): Array<{ peerId: string; type: string; docUuid?: string }> {
    return this.inbound.slice(this.inboundOffset).filter((m) => MUTATING_TYPES.has(m.type));
  }

  checkpoint(): void {
    this.inboundOffset = this.inbound.length;
  }

  getText(uuid: string): string | null {
    const doc = this.docs.get(uuid);
    return doc ? doc.get_text() : null;
  }

  private reply(ws: MockWebSocket, msg: object): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.outbound.push(encodeFrame(msg));
  }

  private broadcast(origin: MockWebSocket, msg: object): void {
    const encoded = encodeFrame(msg);
    for (const [ws, conn] of this.conns) {
      if (ws === origin) continue;
      conn.outbound.push(copyBytes(encoded));
    }
  }

  private isDisjoint(existing: WasmSyncDocument, payload: Uint8Array): boolean {
    const probe = new WasmSyncDocument('__probe__', '__probe__');
    try {
      probe.import_snapshot(payload);
    } catch {
      return false;
    }
    const probeVV = parseVV(probe.export_vv_json());
    const serverVV = parseVV(existing.export_vv_json());
    const keys = Object.keys(probeVV);
    if (keys.length === 0) return false;
    return !keys.some((k) => k in serverVV);
  }
  handle(ws: MockWebSocket, bytes: Uint8Array): void {
    const conn = this.conns.get(ws);
    if (!conn) throw new Error('handle: unknown connection');
    const msg = decode(bytes) as Record<string, unknown>;
    const type = fieldString(msg.type);
    const docUuid = typeof msg.doc_uuid === 'string' ? msg.doc_uuid : undefined;
    this.inbound.push({ peerId: conn.peerId, type, docUuid });

    if (!conn.authed) {
      if (type !== 'auth') throw new Error(`test: first frame must be auth, got ${type}`);
      conn.authed = true;
      this.reply(ws, { type: 'auth_ok', protocol_version: PROTOCOL_VERSION });
      return;
    }

    switch (type) {
      case 'ping':
        this.reply(ws, { type: 'pong' });
        return;
      case 'request_doc_list': {
        const docs = [...this.docs.entries()].map(([uuid, doc]) => ({
          doc_uuid: uuid,
          updated_at: new Date().toISOString(),
          server_vv: vvBytes(doc),
        }));
        const tombstone_hashes: Array<{ doc_uuid: string; content_hash: string | null }> = [];
        for (const uuid of this.tombstones) {
          if (this.omitTombstoneHashUuids.has(uuid)) continue;
          tombstone_hashes.push({
            doc_uuid: uuid,
            content_hash: this.tombstoneHashes.get(uuid) ?? null,
          });
        }
        this.reply(ws, { type: 'doc_list', docs, tombstones: [...this.tombstones], tombstone_hashes });
        return;
      }
      case 'sync_start': {
        const uuid = fieldString(msg.doc_uuid);
        const doc = this.docs.get(uuid);
        if (!doc) {
          this.reply(ws, { type: 'doc_unknown', doc_uuid: uuid });
          return;
        }
        const clientVV = asBytes(msg.client_vv);
        const delta = clientVV && clientVV.length > 0
          ? doc.export_delta_since_vv_json(new TextDecoder().decode(clientVV))
          : doc.export_snapshot();
        this.reply(ws, {
          type: 'sync_delta',
          doc_uuid: uuid,
          delta: copyBytes(delta),
          server_vv: vvBytes(doc),
        });
        return;
      }
      case 'sync_push': {
        const uuid = fieldString(msg.doc_uuid);
        const delta = asBytes(msg.delta);
        const peerId = fieldString(msg.peer_id, conn.peerId);
        if (!delta) { this.reply(ws, { type: 'ack' }); return; }
        if (this.tombstones.has(uuid) && (this.refuseOnAnyTombstone || !this.docs.has(uuid))) {
          this.reply(ws, { type: 'doc_tombstoned', doc_uuid: uuid });
          return;
        }
        let doc = this.docs.get(uuid);
        if (doc && this.isDisjoint(doc, delta)) {
          this.reply(ws, { type: 'create_conflict', doc_uuid: uuid });
          return;
        }
        if (!doc) {
          doc = new WasmSyncDocument(uuid, 'mini-server');
          this.docs.set(uuid, doc);
        }
        doc.import_snapshot(delta);
        this.tombstones.delete(uuid);
        this.tombstoneHashes.delete(uuid);
        this.reply(ws, { type: 'ack' });
        this.broadcast(ws, {
          type: 'delta_broadcast',
          doc_uuid: uuid,
          delta: copyBytes(delta),
          peer_id: peerId,
          server_vv: vvBytes(doc),
        });
        return;
      }
      case 'doc_create': {
        const uuid = fieldString(msg.doc_uuid);
        const snapshot = asBytes(msg.snapshot);
        const peerId = fieldString(msg.peer_id, conn.peerId);
        const replaceTombstone = msg.replace_tombstone === true;
        if (!snapshot) { this.reply(ws, { type: 'ack' }); return; }
        if (this.tombstones.has(uuid) && (this.refuseOnAnyTombstone || !this.docs.has(uuid)) && !replaceTombstone) {
          this.reply(ws, { type: 'doc_tombstoned', doc_uuid: uuid });
          return;
        }
        const existing = this.docs.get(uuid);
        if (existing && this.isDisjoint(existing, snapshot)) {
          this.reply(ws, { type: 'create_conflict', doc_uuid: uuid });
          return;
        }
        const target = existing ?? new WasmSyncDocument(uuid, 'mini-server');
        if (!existing) this.docs.set(uuid, target);
        target.import_snapshot(snapshot);
        this.tombstones.delete(uuid);
        this.tombstoneHashes.delete(uuid);
        this.reply(ws, { type: 'ack' });
        this.broadcast(ws, {
          type: 'delta_broadcast',
          doc_uuid: uuid,
          delta: copyBytes(snapshot),
          peer_id: peerId,
          server_vv: vvBytes(target),
        });
        return;
      }
      case 'doc_delete': {
        const uuid = fieldString(msg.doc_uuid);
        if (this.dropDocDeletes.delete(uuid)) return;
        const doc = this.docs.get(uuid);
        if (doc) {
          // Hash BEFORE free — doc.get_text() after free is UB.
          this.tombstoneHashes.set(uuid, fnv1aHash64(doc.get_text()));
          doc.free();
          this.docs.delete(uuid);
        }
        this.tombstones.add(uuid);
        this.reply(ws, { type: 'ack' });
        this.broadcast(ws, { type: 'doc_deleted', doc_uuid: uuid });
        return;
      }
      default:
        this.reply(ws, { type: 'ack' });
    }
  }
}
interface Harness {
  peerId: string;
  fs: MemoryFS;
  app: any;
  engine: SyncEngine;
  inbox: InboxCapture[];
  lastInitial: Promise<void> | null;
}

const liveEngines: SyncEngine[] = [];

function createHarness(peerId: string, fs = new MemoryFS()): Harness {
  const app = fs.makeApp();
  const inbox: InboxCapture[] = [];
  const harness: Harness = {
    peerId,
    fs,
    app,
    engine: null as unknown as SyncEngine,
    inbox,
    lastInitial: null,
  };
  const engine = new SyncEngine(app, makeSettings(peerId));
  engine.inbox = { add: (entry) => { inbox.push(entry); } };
  engine.onInitialSync = (e) => { harness.lastInitial = e.initialSync(); };
  harness.engine = engine;
  liveEngines.push(engine);
  return harness;
}

async function pumpUntilSettled(isDone: () => boolean): Promise<void> {
  if (!activeServer) throw new Error('pump: no server');
  for (let i = 0; i < QUIET_CAP; i++) {
    await flushMicrotasks();
    activeServer.deliverAll();
    await flushMicrotasks();
    if (isDone() && activeServer.queuedCount() === 0) {
      await flushMicrotasks();
      if (isDone() && activeServer.queuedCount() === 0) return;
    }
  }
  throw new Error(`pumpUntilSettled: exceeded ${QUIET_CAP} iterations`);
}

async function untilQuiet(): Promise<void> {
  if (!activeServer) throw new Error('untilQuiet: no server');
  let idle = 0;
  for (let i = 0; i < QUIET_CAP; i++) {
    await flushMicrotasks();
    const delivered = activeServer.deliverAll();
    await flushMicrotasks();
    if (delivered === 0 && activeServer.queuedCount() === 0) {
      idle++;
      if (idle >= 8) return;
    } else {
      idle = 0;
    }
  }
  throw new Error(`untilQuiet: exceeded ${QUIET_CAP} iterations`);
}

async function startEngine(h: Harness): Promise<void> {
  h.lastInitial = null;
  await h.engine.start();
  let finished = false;
  let fail: unknown;
  let attached = false;
  await pumpUntilSettled(() => {
    if (h.lastInitial && !attached) {
      attached = true;
      void h.lastInitial.then(
        () => { finished = true; },
        (err) => { finished = true; fail = err; },
      );
    }
    return finished;
  });
  if (fail) rethrow(fail);
}

async function runInitialSync(engine: SyncEngine): Promise<void> {
  let finished = false;
  let fail: unknown;
  const p = engine.initialSync();
  void p.then(
    () => { finished = true; },
    (err) => { finished = true; fail = err; },
  );
  await pumpUntilSettled(() => finished);
  if (fail) rethrow(fail);
}

function applyOp(h: Harness, op: PlanOp): void {
  switch (op.op) {
    case 'edit': {
      const cur = h.fs.readText(op.file);
      if (!cur.includes(op.find)) {
        throw new Error(`edit find missed (${op.class}): ${op.file} ${JSON.stringify(op.find)}`);
      }
      const next = cur.replace(op.find, op.replace);
      h.fs.writeText(op.file, next);
      if (op.via === 'engine') h.engine.onFileChangedImmediate(op.file, next);
      return;
    }
    case 'append': {
      const next = `${h.fs.readText(op.file)}${op.text}`;
      h.fs.writeText(op.file, next);
      if (op.via === 'engine') h.engine.onFileChangedImmediate(op.file, next);
      return;
    }
    case 'create': {
      h.fs.writeText(op.file, op.content);
      if (op.via === 'engine') h.engine.onFileChangedImmediate(op.file, op.content);
      return;
    }
    case 'delete': {
      h.fs.remove(op.file);
      if (op.via === 'engine') h.engine.onFileDeleted(op.file);
      return;
    }
    case 'rename': {
      const content = h.fs.readText(op.from);
      h.fs.rename(op.from, op.to);
      if (op.via === 'engine') h.engine.onFileRenamed(op.from, op.to, content);
      return;
    }
  }
}

async function diverge(h: Harness, plan: PlanOp[], drainEach = false): Promise<void> {
  for (const op of plan) {
    applyOp(h, op);
    await flushMicrotasks();
    if (drainEach) await untilQuiet();
  }
}

function collectTexts(fs: MemoryFS): string {
  return fs.mdPaths().map((p) => fs.readText(p)).join('\n');
}

function conflictCopies(fs: MemoryFS, originalPath: string): string[] {
  const dot = originalPath.lastIndexOf('.');
  const ext = dot >= 0 ? originalPath.slice(dot) : '';
  const base = originalPath.slice(0, originalPath.length - ext.length);
  const prefix = `${base} (conflict `;
  return fs.mdPaths().filter((p) => p.startsWith(prefix) && p.endsWith(ext));
}
describe('long-divergence (real CRDT)', () => {
  beforeAll(async () => {
    const bytes = readFileSync(new URL('../../wasm/vaultcrdt_wasm_bg.wasm', import.meta.url));
    await initWasmModule({ module_or_path: bytes });
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  beforeEach(() => {
    liveEngines.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PINNED_ISO));
    installLocalStorage();
    activeServer = new MiniServer();
  });

  afterEach(async () => {
    for (const engine of liveEngines.splice(0)) {
      await engine.stop();
    }
    activeServer = null;
    vi.useRealTimers();
  });

  async function establishCommonHistory(
    seed: number,
  ): Promise<{ a: Harness; b: Harness; rng: () => number; constants: string[] }> {
    const rng = mulberry32(seed);
    const a = createHarness('peer-A');
    const b = createHarness('peer-B');
    const constants: string[] = [];

    for (let i = 0; i < FILE_COUNT; i++) {
      a.fs.writeText(notePath(i), seedText(i));
      constants.push(`SEED_${String(i).padStart(2, '0')}_HEAD`);
      constants.push(`SEED_${String(i).padStart(2, '0')}_MID`);
      constants.push(`SEED_${String(i).padStart(2, '0')}_TAIL`);
    }

    await startEngine(a);
    await startEngine(b);

    const preA: PlanOp[] = [];
    const preB: PlanOp[] = [];
    // Files 20-33 are reserved for T1 deletes/renames; pre-ops stay on paths that remain live.
    const prePool = [...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 16 }, (_, i) => 34 + i)];
    for (let n = 0; n < PRE_OPS_PER_SIDE; n++) {
      const fileA = notePath(prePool[Math.floor(rng() * prePool.length)]);
      const fileB = notePath(prePool[Math.floor(rng() * prePool.length)]);
      const tokA = `A_PRE_${String(n).padStart(3, '0')}`;
      const tokB = `B_PRE_${String(n).padStart(3, '0')}`;
      constants.push(tokA, tokB);
      preA.push({ op: 'append', file: fileA, text: `\n${tokA}`, via: 'engine', class: 'pre-divergence A' });
      preB.push({ op: 'append', file: fileB, text: `\n${tokB}`, via: 'engine', class: 'pre-divergence B' });
    }
    await diverge(a, preA, true);
    await untilQuiet();
    await diverge(b, preB, true);
    await untilQuiet();
    return { a, b, rng, constants };
  }

  function assertConverged(left: Harness, right: Harness, server: MiniServer): void {
    const paths = new Set<string>([
      ...left.fs.mdPaths().filter(isLiveSyncPath),
      ...right.fs.mdPaths().filter(isLiveSyncPath),
      ...[...server.docs.keys()].filter(isLiveSyncPath),
    ]);
    for (const path of paths) {
      const onServer = server.docs.has(path);
      const onLeft = left.fs.has(path);
      const onRight = right.fs.has(path);
      if (!onServer) {
        expect(onLeft, `${path} deleted on server but present on left`).toBe(false);
        expect(onRight, `${path} deleted on server but present on right`).toBe(false);
        continue;
      }
      const serverText = server.getText(path);
      expect(onLeft, `${path} missing on left`).toBe(true);
      expect(onRight, `${path} missing on right`).toBe(true);
      expect(left.fs.readText(path), `${path} left != server`).toBe(serverText);
      expect(right.fs.readText(path), `${path} right != server`).toBe(serverText);
    }
  }
  it('T1 — weeks of divergence then resync (scenario A)', async () => {
    const { a, b, rng, constants } = await establishCommonHistory(1);

    const mergeFiles = Array.from({ length: 15 }, (_, i) => notePath(i));
    const fsOnlyFiles = Array.from({ length: 5 }, (_, i) => notePath(15 + i));
    const deleteFiles = Array.from({ length: 10 }, (_, i) => notePath(20 + i));
    const renameAFrom = notePath(30);
    const renameATo = 'notes/renamed-a.md';
    const renameBFrom = notePath(31);
    const renameBTo = 'notes/renamed-b.md';
    const collideAFrom = notePath(32);
    const collideBFrom = notePath(33);
    const collideTo = 'notes/collide.md';
    const keepPath = notePath(34);

    const aMergeTok = mergeFiles.map((_, i) => `A_MRG_${String(i).padStart(2, '0')}`);
    const bMergeTok = mergeFiles.map((_, i) => `B_MRG_${String(i).padStart(2, '0')}`);
    const aFsTok = fsOnlyFiles.map((_, i) => `A_FSO_${String(i).padStart(2, '0')}`);
    const bFsTok = fsOnlyFiles.map((_, i) => `B_FSO_${String(i).padStart(2, '0')}`);
    const aRenTok = 'A_REN_NONCOLLIDE';
    const bRenTok = 'B_REN_NONCOLLIDE';
    const aColTok = 'A_COL_COLLIDE';
    const bColTok = 'B_COL_COLLIDE';

    constants.push(...aMergeTok, ...bMergeTok, ...aFsTok, ...bFsTok, aRenTok, bRenTok, aColTok, bColTok);
    const deletedExempt = new Set<string>();
    for (const p of deleteFiles) {
      const i = Number(p.slice('notes/n'.length, 'notes/n'.length + 2));
      deletedExempt.add(`SEED_${String(i).padStart(2, '0')}_HEAD`);
      deletedExempt.add(`SEED_${String(i).padStart(2, '0')}_MID`);
      deletedExempt.add(`SEED_${String(i).padStart(2, '0')}_TAIL`);
    }

    await b.engine.stop();

    const aDiv: PlanOp[] = [];
    const bTracked: PlanOp[] = [];
    for (let i = 0; i < 15; i++) {
      const file = mergeFiles[i];
      if (i < 10) {
        aDiv.push({
          op: 'edit', file, find: 'left-region', replace: `left-region ${aMergeTok[i]}`,
          via: 'engine', class: 'engine-tracked mixed-region (A left)',
        });
        bTracked.push({
          op: 'edit', file, find: 'right-region', replace: `right-region ${bMergeTok[i]}`,
          via: 'engine', class: 'engine-tracked mixed-region (B right)',
        });
      } else {
        aDiv.push({
          op: 'edit', file, find: 'left-region', replace: `left-region ${aMergeTok[i]}`,
          via: 'engine', class: 'engine-tracked same-region (A interleave)',
        });
        bTracked.push({
          op: 'edit', file, find: 'left-region', replace: `left-region ${bMergeTok[i]}`,
          via: 'engine', class: 'engine-tracked same-region (B interleave)',
        });
      }
    }

    for (let i = 0; i < 5; i++) {
      aDiv.push({
        op: 'edit', file: fsOnlyFiles[i], find: 'left-region',
        replace: `left-region ${aFsTok[i]}`,
        via: 'engine', class: 'engine-tracked on A / FS-only counterpart on B',
      });
    }
    for (const file of deleteFiles) {
      aDiv.push({ op: 'delete', file, via: 'engine', class: 'deleted on A only' });
    }
    aDiv.push({
      op: 'edit', file: renameAFrom, find: 'left-region', replace: `left-region ${aRenTok}`,
      via: 'engine', class: 'rename source A (non-collide)',
    });
    aDiv.push({ op: 'rename', from: renameAFrom, to: renameATo, via: 'engine', class: 'rename A non-colliding target' });
    aDiv.push({
      op: 'edit', file: collideAFrom, find: 'left-region', replace: `left-region ${aColTok}`,
      via: 'engine', class: 'rename source A (collide)',
    });
    aDiv.push({ op: 'rename', from: collideAFrom, to: collideTo, via: 'engine', class: 'rename A colliding target notes/collide.md' });

    await diverge(a, aDiv, true);
    await untilQuiet();
    const bFs: PlanOp[] = [];
    for (let i = 0; i < 5; i++) {
      bFs.push({
        op: 'edit', file: fsOnlyFiles[i], find: 'right-region',
        replace: `right-region ${bFsTok[i]}`,
        via: 'fs', class: 'FS-only on B (stopped engine, no CRDT ingest)',
      });
    }
    bFs.push({
      op: 'edit', file: renameBFrom, find: 'left-region', replace: `left-region ${bRenTok}`,
      via: 'engine', class: 'rename source B (non-collide, engine-tracked offline)',
    });
    bFs.push({ op: 'rename', from: renameBFrom, to: renameBTo, via: 'engine', class: 'rename B non-colliding target' });
    bFs.push({
      op: 'edit', file: collideBFrom, find: 'left-region', replace: `left-region ${bColTok}`,
      via: 'engine', class: 'rename source B (collide, engine-tracked offline)',
    });
    bFs.push({ op: 'rename', from: collideBFrom, to: collideTo, via: 'engine', class: 'rename B colliding target notes/collide.md' });
    await diverge(b, bTracked.concat(bFs));

    a.fs.scrambleMtimes(rng);
    b.fs.scrambleMtimes(rng);
    await untilQuiet();

    await a.engine.stop();
    await startEngine(a);
    await startEngine(b);

    assertConverged(a, b, activeServer!);

    for (let i = 0; i < 15; i++) {
      const file = mergeFiles[i];
      const textA = a.fs.readText(file);
      const textB = b.fs.readText(file);
      expect(textA, `merge file ${file} A missing A token`).toContain(aMergeTok[i]);
      expect(textA, `merge file ${file} A missing B token`).toContain(bMergeTok[i]);
      expect(textB).toBe(textA);
      expect(
        a.fs.mdPaths().some((p) => isConflictCopyPath(p) && p.startsWith(file.slice(0, -3))),
        `engine-tracked ${file} must not produce a conflict copy`,
      ).toBe(false);
    }

    for (let i = 0; i < 5; i++) {
      const file = fsOnlyFiles[i];
      const copies = [...new Set([...conflictCopies(a.fs, file), ...conflictCopies(b.fs, file)])];
      expect(copies.length, `FS-only ${file} missing conflict copy`).toBeGreaterThan(0);
      const copyText = copies.map((p) => (b.fs.has(p) ? b.fs.readText(p) : a.fs.readText(p))).join('\n');
      expect(copyText, `conflict copy for ${file} should hold B FS-only text`).toContain(bFsTok[i]);
      expect(b.fs.readText(file), `live ${file} should hold server/A text`).toContain(aFsTok[i]);
      expect(b.inbox.filter((e) => copies.includes(e.path) || e.relatedPath === file).length).toBeGreaterThanOrEqual(1);
    }

    for (const file of deleteFiles) {
      expect(a.fs.has(file), `deleted-on-A ${file} still on A`).toBe(false);
      expect(b.fs.has(file), `deleted-on-A ${file} still on B`).toBe(false);
      expect(activeServer!.docs.has(file), `deleted-on-A ${file} still on server`).toBe(false);
    }

    const combined = `${collectTexts(a.fs)}\n${collectTexts(b.fs)}`;
    for (const token of constants) {
      if (deletedExempt.has(token)) continue;
      expect(combined, `token lost: ${token}`).toContain(token);
    }

    expect(a.fs.has(renameATo)).toBe(true);
    expect(b.fs.has(renameATo)).toBe(true);
    expect(a.fs.has(renameBTo)).toBe(true);
    expect(b.fs.has(renameBTo)).toBe(true);
    expect(a.fs.has(collideTo)).toBe(true);
    expect(b.fs.has(collideTo)).toBe(true);
    const collideConflict = a.fs.mdPaths().filter((p) => isConflictCopyPath(p) && p.includes('collide'))
      .concat(b.fs.mdPaths().filter((p) => isConflictCopyPath(p) && p.includes('collide')));
    expect(collideConflict.length, 'colliding rename should produce a conflict copy').toBeGreaterThan(0);
    const collideCorpus = collideConflict.map((p) => (a.fs.has(p) ? a.fs.readText(p) : b.fs.readText(p))).join('\n')
      + a.fs.readText(collideTo) + b.fs.readText(collideTo);
    expect(collideCorpus).toContain(aColTok);
    expect(collideCorpus).toContain(bColTok);

    const keepTok = 'B_KEEP_GUARD';
    const keepNext = `${b.fs.readText(keepPath)}\n${keepTok}`;
    b.fs.writeText(keepPath, keepNext);
    b.engine.onFileChangedImmediate(keepPath, keepNext);
    await untilQuiet();
    expect(b.engine.getDiagnosticsCounts().sentUnacked).toBeGreaterThan(0);
    a.fs.remove(keepPath);
    a.engine.onFileDeleted(keepPath);
    await untilQuiet();
    expect(b.fs.has(keepPath), 'keep-guard must leave B file in place').toBe(true);
    b.engine.onFileChangedImmediate(keepPath, b.fs.readText(keepPath));
    await untilQuiet();
    await runInitialSync(a.engine);
    await untilQuiet();
    expect(b.fs.has(keepPath)).toBe(true);
    expect(activeServer!.docs.has(keepPath) || a.fs.has(keepPath)).toBe(true);
  }, 120_000);
  it('T2 — fresh setup over a similar-but-different folder (scenario B)', async () => {
    const a = createHarness('peer-A');
    for (let i = 0; i < FILE_COUNT; i++) a.fs.writeText(notePath(i), seedText(i));
    await startEngine(a);

    const identical = Array.from({ length: 30 }, (_, i) => notePath(i));
    const differing = Array.from({ length: 10 }, (_, i) => notePath(30 + i));
    const tombUnmod = [notePath(40), notePath(41), notePath(42)];
    const tombMod = [notePath(43), notePath(44)];
    const tombAll = [...tombUnmod, ...tombMod];
    const serverOnly = Array.from({ length: 5 }, (_, i) => notePath(45 + i));
    const localOnly = Array.from({ length: 5 }, (_, i) => `notes/local-${i}.md`);

    const cLocal = new MemoryFS();
    for (const p of identical) cLocal.writeText(p, a.fs.readText(p));
    const cDiffTok = differing.map((_, i) => `C_DIFF_${String(i).padStart(2, '0')}`);
    for (let i = 0; i < differing.length; i++) {
      cLocal.writeText(differing[i], `${seedText(30 + i)}\n${cDiffTok[i]}`);
    }
    for (const p of tombUnmod) cLocal.writeText(p, a.fs.readText(p));
    for (let i = 0; i < tombMod.length; i++) {
      cLocal.writeText(tombMod[i], `${a.fs.readText(tombMod[i])}\nC_TOMB_MOD_${i}`);
    }
    for (let i = 0; i < localOnly.length; i++) {
      cLocal.writeText(localOnly[i], `# local\nC_LOCAL_${i}`);
    }

    for (const p of tombAll) {
      a.fs.remove(p);
      a.engine.onFileDeleted(p);
    }
    await untilQuiet();

    const c = createHarness('peer-C', cLocal);
    activeServer!.checkpoint();
    await startEngine(c);

    const creates = activeServer!.inbound
      .slice(activeServer!.inboundOffset)
      .filter((m) => m.type === 'doc_create' && m.peerId === 'peer-C');
    for (const p of identical) {
      expect(creates.some((m) => m.docUuid === p), `identical ${p} must not doc_create`).toBe(false);
      expect(c.fs.readText(p)).toBe(activeServer!.getText(p));
    }

    for (let i = 0; i < differing.length; i++) {
      const file = differing[i];
      const copies = conflictCopies(c.fs, file);
      expect(copies.length, `differing ${file} missing conflict copy`).toBeGreaterThan(0);
      const copyText = copies.map((p) => c.fs.readText(p)).join('\n');
      expect(copyText).toContain(cDiffTok[i]);
      expect(c.fs.readText(file)).toBe(activeServer!.getText(file));
      expect(c.inbox.filter((e) => copies.includes(e.path) || e.relatedPath === file).length).toBeGreaterThanOrEqual(1);
    }
    expect(c.fs.mdPaths().filter(isConflictCopyPath).length, 'exactly 10 conflict copies').toBe(10);
    expect(c.inbox.filter((e) => e.kind === 'conflict').length).toBe(10);

    // T2 hash-equal unmodified tombstones: stateless peer C must TRASH
    // (regression guard for over-keeping). Named here instead of duplicating.
    for (const p of tombUnmod) {
      expect(c.fs.has(p), `unmodified tombstone ${p} should be trashed`).toBe(false);
    }
    for (const p of localOnly) {
      expect(activeServer!.docs.has(p), `local-only ${p} should be uploaded`).toBe(true);
    }
    for (const p of serverOnly) {
      expect(c.fs.has(p), `server-only ${p} should be downloaded`).toBe(true);
      expect(c.fs.readText(p)).toBe(activeServer!.getText(p));
    }

    await runInitialSync(a.engine);
    await untilQuiet();
    assertConverged(a, c, activeServer!);
  }, 120_000);

  it('T2 product: tombstoned file C modified before connect is kept (case 1)', async () => {
    const a = createHarness('peer-A');
    a.fs.writeText(notePath(43), seedText(43));
    await startEngine(a);
    const cLocal = new MemoryFS();
    cLocal.writeText(notePath(43), `${seedText(43)}\nC_TOMB_MOD_0`);
    a.fs.remove(notePath(43));
    a.engine.onFileDeleted(notePath(43));
    await untilQuiet();
    const c = createHarness('peer-C', cLocal);
    await startEngine(c);
    expect(c.fs.has(notePath(43)), 'modified tombstone should be kept').toBe(true);
  }, 60_000);

  it('T2 product: tombstoned file C modified before connect is kept (case 2)', async () => {
    const a = createHarness('peer-A');
    a.fs.writeText(notePath(44), seedText(44));
    await startEngine(a);
    const cLocal = new MemoryFS();
    cLocal.writeText(notePath(44), `${seedText(44)}\nC_TOMB_MOD_1`);
    a.fs.remove(notePath(44));
    a.engine.onFileDeleted(notePath(44));
    await untilQuiet();
    const c = createHarness('peer-C', cLocal);
    await startEngine(c);
    expect(c.fs.has(notePath(44)), 'modified tombstone should be kept').toBe(true);
  }, 60_000);

  it('T2: stateless peer keeps a tombstoned file when the tombstone hash is absent (old server)', async () => {
    const path = notePath(10);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(10));
    await startEngine(a);
    const cLocal = new MemoryFS();
    cLocal.writeText(path, seedText(10));
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    activeServer!.omitTombstoneHashUuids.add(path);
    const c = createHarness('peer-C', cLocal);
    await startEngine(c);
    expect(c.fs.has(path), 'hash-absent tombstone must be kept (fail-safe)').toBe(true);
    expect(c.inbox.some((e) =>
      e.kind === 'deleted-remote' && e.path === path && e.note === remoteDeleteKeptNoticeMessage(path),
    )).toBe(true);
  }, 60_000);

  it('T2: pull mode keeps a modified tombstoned file without pushing doc_create', async () => {
    const path = notePath(11);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(11));
    await startEngine(a);
    const cLocal = new MemoryFS();
    cLocal.writeText(path, `${seedText(11)}\nC_PULL_KEEP`);
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    activeServer!.checkpoint();
    const c = createHarness('peer-C', cLocal);
    c.engine.onInitialSync = (e) => { c.lastInitial = e.initialSync(undefined, 'pull'); };
    await startEngine(c);
    expect(c.fs.has(path), 'pull mode must keep the modified tombstoned file').toBe(true);
    const creates = activeServer!.inbound
      .slice(activeServer!.inboundOffset)
      .filter((m) => m.type === 'doc_create' && m.peerId === 'peer-C');
    expect(creates, 'pull mode must not push doc_create').toEqual([]);
    expect(c.inbox.some((e) =>
      e.kind === 'deleted-remote' && e.path === path && e.note === remoteDeleteKeptNoticeMessage(path),
    )).toBe(true);
  }, 60_000);

  it('T3 — mtime chaos alone changes nothing', async () => {
    const { a, b, rng } = await establishCommonHistory(3);
    a.fs.scrambleMtimes(rng);
    b.fs.scrambleMtimes(rng);

    const watchA = new FileWatcher(a.app, a.engine);
    const watchB = new FileWatcher(b.app, b.engine);
    await watchA.scanForExternalChanges();
    await watchB.scanForExternalChanges();
    await untilQuiet();

    activeServer!.checkpoint();
    await a.engine.stop();
    await b.engine.stop();
    await startEngine(a);
    await startEngine(b);

    const mutating = activeServer!.mutatingSinceCheckpoint();
    expect(mutating, `unexpected mutating frames: ${JSON.stringify(mutating)}`).toEqual([]);
  }, 120_000);

  it('concurrent excalidraw: main line is one intact payload, other side is a conflict copy', async () => {
    const path = 'drawings/sketch.excalidraw.md';
    const payload0 = 'excalidrawjson:AAAA_BASE';
    const payloadA = 'excalidrawjson:AAAA_SIDE_A';
    const payloadB = 'excalidrawjson:AAAA_SIDE_B';

    const a = createHarness('peer-A');
    a.fs.writeText(path, payload0);
    await startEngine(a);
    const b = createHarness('peer-B');
    await startEngine(b);
    await untilQuiet();
    expect(b.fs.readText(path)).toBe(payload0);

    await b.engine.stop();
    a.fs.writeText(path, payloadA);
    a.engine.onFileChangedImmediate(path, payloadA);
    await untilQuiet();
    b.fs.writeText(path, payloadB);
    b.engine.onFileChangedImmediate(path, payloadB);

    await startEngine(b);
    await untilQuiet();

    const mainA = a.fs.readText(path);
    const mainB = b.fs.readText(path);
    expect(mainA, 'both devices must share one intact main line').toBe(mainB);
    expect([payloadA, payloadB], 'main line must equal one original payload (no interleaving)').toContain(mainA);

    const copies = [...new Set([...conflictCopies(a.fs, path), ...conflictCopies(b.fs, path)])];
    expect(copies.length, 'other side must survive as a conflict copy').toBeGreaterThan(0);
    const other = mainA === payloadA ? payloadB : payloadA;
    const copyText = copies.map((p) => (a.fs.has(p) ? a.fs.readText(p) : b.fs.readText(p))).join('\n');
    expect(copyText, 'conflict copy must hold the non-winning original payload').toContain(other);
    expect(
      [...a.inbox, ...b.inbox].some((e) => e.kind === 'conflict' && copies.includes(e.path)),
      'inbox must record the conflict copy',
    ).toBe(true);
  }, 60_000);

  it('sequential excalidraw edits on one device flow with no conflict copy', async () => {
    const path = 'drawings/seq.excalidraw.md';
    const first = 'excalidrawjson:AAAA_SEQ_1';
    const second = 'excalidrawjson:AAAA_SEQ_2';
    const a = createHarness('peer-A');
    a.fs.writeText(path, first);
    await startEngine(a);
    const b = createHarness('peer-B');
    await startEngine(b);
    await untilQuiet();

    a.fs.writeText(path, second);
    a.engine.onFileChangedImmediate(path, second);
    await untilQuiet();

    expect(a.fs.readText(path)).toBe(second);
    expect(b.fs.readText(path)).toBe(second);
    expect(conflictCopies(a.fs, path)).toEqual([]);
    expect(conflictCopies(b.fs, path)).toEqual([]);
    expect(a.inbox.filter((e) => e.kind === 'conflict')).toEqual([]);
    expect(b.inbox.filter((e) => e.kind === 'conflict')).toEqual([]);
  }, 60_000);

  it('concurrent non-excalidraw markdown still CRDT-merges with no conflict copy', async () => {
    const path = 'notes/plain.md';
    const a = createHarness('peer-A');
    a.fs.writeText(path, 'SEED\nleft-region\nright-region\n');
    await startEngine(a);
    const b = createHarness('peer-B');
    await startEngine(b);
    await untilQuiet();

    await b.engine.stop();
    const aNext = a.fs.readText(path).replace('left-region', 'left-region A_TOK');
    a.fs.writeText(path, aNext);
    a.engine.onFileChangedImmediate(path, aNext);
    await untilQuiet();
    const bNext = b.fs.readText(path).replace('right-region', 'right-region B_TOK');
    b.fs.writeText(path, bNext);
    b.engine.onFileChangedImmediate(path, bNext);

    await startEngine(b);
    await untilQuiet();

    const textA = a.fs.readText(path);
    const textB = b.fs.readText(path);
    expect(textA).toBe(textB);
    expect(textA).toContain('A_TOK');
    expect(textA).toContain('B_TOK');
    expect(conflictCopies(a.fs, path)).toEqual([]);
    expect(conflictCopies(b.fs, path)).toEqual([]);
  }, 60_000);

  it('initial-sync differing overlap covers excalidraw with a conflict copy', async () => {
    const path = 'drawings/fresh.excalidraw.md';
    const serverPayload = 'excalidrawjson:AAAA_SERVER';
    const localPayload = 'excalidrawjson:AAAA_LOCAL';
    const a = createHarness('peer-A');
    a.fs.writeText(path, serverPayload);
    await startEngine(a);
    await untilQuiet();

    const cLocal = new MemoryFS();
    cLocal.writeText(path, localPayload);
    const c = createHarness('peer-C', cLocal);
    await startEngine(c);
    await untilQuiet();

    const copies = conflictCopies(c.fs, path);
    expect(copies.length, 'differing excalidraw must produce a conflict copy').toBeGreaterThan(0);
    expect(copies.map((p) => c.fs.readText(p)).join('\n')).toContain(localPayload);
    expect(c.fs.readText(path)).toBe(serverPayload);
    expect(c.inbox.filter((e) => e.kind === 'conflict').length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('live keep-guard: unwatched disk divergence is kept when no editor is open', async () => {
    const path = notePath(7);
    const a = createHarness('peer-A');
    const b = createHarness('peer-B');
    a.fs.writeText(path, seedText(7));
    await startEngine(a);
    await startEngine(b);
    await untilQuiet();
    b.fs.writeText(path, `${seedText(7)}\nB_DISK_ONLY`);
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    expect(b.fs.has(path), 'disk-diverged file must be kept').toBe(true);
    expect(b.inbox.some((e) => e.kind === 'deleted-remote' && e.path === path)).toBe(true);
  }, 60_000);

  it('live keep-guard: disk equal to CRDT is trashed when no editor is open', async () => {
    const path = notePath(8);
    const a = createHarness('peer-A');
    const b = createHarness('peer-B');
    a.fs.writeText(path, seedText(8));
    await startEngine(a);
    await startEngine(b);
    await untilQuiet();
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    expect(b.fs.has(path), 'unmodified file must be trashed').toBe(false);
  }, 60_000);

  it('reconnect does not resend a delete whose tombstone is already on the server', async () => {
    const path = notePath(9);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(9));
    await startEngine(a);
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    expect(activeServer!.tombstones.has(path)).toBe(true);
    activeServer!.checkpoint();
    await a.engine.stop();
    await startEngine(a);
    const deletes = activeServer!.mutatingSinceCheckpoint().filter(
      (m) => m.type === 'doc_delete' && m.docUuid === path,
    );
    expect(deletes, `unexpected doc_delete frames: ${JSON.stringify(deletes)}`).toEqual([]);
  }, 60_000);

  it('reconnect does not replay delete after a peer replaceTombstone resurrection', async () => {
    const path = notePath(6);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(6));
    await startEngine(a);
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    await a.engine.stop();

    const bLocal = new MemoryFS();
    bLocal.writeText(path, `${seedText(6)}\nB_RESURRECT`);
    const b = createHarness('peer-B', bLocal);
    await startEngine(b);
    await untilQuiet();
    expect(activeServer!.docs.has(path), 'B should have resurrected the doc').toBe(true);

    activeServer!.checkpoint();
    await startEngine(a);
    const deletes = activeServer!.mutatingSinceCheckpoint().filter(
      (m) => m.type === 'doc_delete' && m.docUuid === path,
    );
    expect(deletes, `unexpected doc_delete frames: ${JSON.stringify(deletes)}`).toEqual([]);
    expect(activeServer!.docs.has(path)).toBe(true);
  }, 60_000);

  it('lost in-flight delete is not replayed; file returns via server-only download', async () => {
    const path = notePath(12);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(12));
    await startEngine(a);
    await untilQuiet();
    expect(activeServer!.docs.has(path)).toBe(true);

    // Offline delete -> unacked journal (socket closed, no doc_delete emitted).
    await a.engine.stop();
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await flushMicrotasks();
    expect(a.engine.getDiagnosticsCounts().pendingDeletes).toBe(1);
    expect(activeServer!.docs.has(path), 'offline delete must not reach the server').toBe(true);

    // Reconnect 1: resendPendingDeletes emits doc_delete (client marks acked); drop the frame.
    activeServer!.dropDocDeletes.add(path);
    await startEngine(a);
    await untilQuiet();
    const resent = activeServer!.inbound.filter(
      (m) => m.type === 'doc_delete' && m.docUuid === path,
    );
    expect(resent.length, 'resendPendingDeletes must emit one doc_delete').toBe(1);
    expect(activeServer!.docs.has(path), 'dropped delete must leave the doc live').toBe(true);
    expect(activeServer!.tombstones.has(path)).toBe(false);
    expect(a.fs.has(path), 'pending delete still blocks server-only download').toBe(false);
    expect(a.engine.getDiagnosticsCounts().pendingDeletes).toBe(1);

    // Reconnect 2: request_doc_list shows LIVE; acked+live = resurrected; journal drops; file returns.
    await a.engine.stop();
    activeServer!.checkpoint();
    await startEngine(a);
    const deletes = activeServer!.mutatingSinceCheckpoint().filter(
      (m) => m.type === 'doc_delete' && m.docUuid === path,
    );
    expect(deletes, `unexpected doc_delete frames: ${JSON.stringify(deletes)}`).toEqual([]);
    expect(a.fs.has(path), 'server-only pass must restore the file').toBe(true);
    expect(a.fs.readText(path)).toBe(seedText(12));
    expect(a.engine.getDiagnosticsCounts().pendingDeletes).toBe(0);
  }, 60_000);

  /** Both rows for one path (tombstone + live doc) — the state an old server left behind. */
  function addStaleTombstone(path: string): void {
    expect(activeServer!.docs.has(path), 'live row expected before staging tombstone').toBe(true);
    activeServer!.tombstones.add(path);
  }

  it('both-rows startup: a tombstoned path with a live doc row materialises as a plain note', async () => {
    const path = notePath(13);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(13));
    await startEngine(a);
    await untilQuiet();
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    a.fs.writeText(path, seedText(13));
    a.engine.onFileChangedImmediate(path, seedText(13));
    await untilQuiet();
    addStaleTombstone(path);

    const b = createHarness('peer-B');
    await startEngine(b);
    await untilQuiet();

    expect(b.fs.has(path), 'live server row must materialise').toBe(true);
    expect(b.fs.mdPaths().filter((p) => p.includes('(deleted-remote'))).toEqual([]);
    expect(b.inbox.filter((e) => e.kind === 'tombstone-rename')).toEqual([]);

    const edited = `${seedText(13)}\nB_EDIT`;
    b.fs.writeText(path, edited);
    b.engine.onFileChangedImmediate(path, edited);
    await untilQuiet();
    expect(activeServer!.getText(path)).toContain('B_EDIT');
    expect(a.fs.readText(path)).toContain('B_EDIT');
    expect(a.fs.has(path)).toBe(true);
  }, 60_000);

  it('old-server regime: a stale doc_tombstoned refusal keeps the re-created file (liveness guard)', async () => {
    const path = notePath(14);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(14));
    await startEngine(a);
    await untilQuiet();
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    a.fs.writeText(path, seedText(14));
    a.engine.onFileChangedImmediate(path, seedText(14));
    await untilQuiet();
    addStaleTombstone(path);
    activeServer!.refuseOnAnyTombstone = true;

    const edited = `${seedText(14)}\nA_EDIT_AFTER_RECREATE`;
    a.fs.writeText(path, edited);
    a.engine.onFileChangedImmediate(path, edited);
    await untilQuiet();

    expect(a.fs.has(path), 'liveness guard must keep the re-created file').toBe(true);
    expect(a.fs.mdPaths().filter((p) => p.includes('(deleted-remote'))).toEqual([]);
    expect(a.inbox.filter((e) => e.kind === 'tombstone-rename')).toEqual([]);
    expect(activeServer!.getText(path)).toContain('A_EDIT_AFTER_RECREATE');
  }, 60_000);

  it('journal gap: a re-create after reconnect-reconcile goes out as doc_create(replace)', async () => {
    const path = notePath(15);
    const a = createHarness('peer-A');
    a.fs.writeText(path, seedText(15));
    await startEngine(a);
    await untilQuiet();
    a.fs.remove(path);
    a.engine.onFileDeleted(path);
    await untilQuiet();
    expect(activeServer!.tombstones.has(path)).toBe(true);

    // Reconnect: reconcilePendingDeletes drops the confirmed journal entry.
    await a.engine.stop();
    await startEngine(a);
    await untilQuiet();
    expect(a.engine.getDiagnosticsCounts().pendingDeletes).toBe(0);

    activeServer!.checkpoint();
    const recreated = `${seedText(15)}\nA_RECREATE`;
    a.fs.writeText(path, recreated);
    a.engine.onFileChangedImmediate(path, recreated);
    await untilQuiet();

    const frames = activeServer!.mutatingSinceCheckpoint().filter((m) => m.docUuid === path);
    expect(frames.map((m) => m.type), JSON.stringify(frames)).toContain('doc_create');
    expect(frames.map((m) => m.type)).not.toContain('sync_push');
    expect(a.fs.has(path), 're-created file keeps its name').toBe(true);
    expect(a.fs.mdPaths().filter((p) => p.includes('(deleted-remote'))).toEqual([]);
    expect(activeServer!.getText(path)).toContain('A_RECREATE');
  }, 60_000);
});
