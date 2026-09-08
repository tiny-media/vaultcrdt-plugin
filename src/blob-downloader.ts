import type { App, TFile } from 'obsidian';
import { blake3_hex, blob_path_key, sanitize_svg } from '../wasm/vaultcrdt_wasm';
import { conflictPath } from './conflict-utils';
import { log, error } from './logger';
import {
  AUDIO_CAP,
  isCategoryWriteAllowed,
  isSvgPath,
  obsidianSyncCategoryOf,
  pathCaseKey,
  type ObsidianSyncEnabled,
} from './path-policy';
import { blobRequest, headerValue } from './blob-uploader';
import type { BlobIndex, BlobIndexEntry } from './blob-index';

/** Download segments match the upload default (server Accept-Ranges: bytes). */
const SEGMENT_BYTES = 4 * 1024 * 1024;

export interface BlobDownloaderDeps {
  index: BlobIndex;
  serverUrl(): string;
  getJwt(): Promise<string>;
  blobsEnabled(): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  enqueueUpload(path: string): void;
  /** Current per-device .obsidian category toggles (read at effect time). */
  categoryEnabled(): ObsidianSyncEnabled;
  app: App;
  isMobile: boolean;
  getFileCache(file: TFile): { embeds?: { link: string }[]; links?: { link: string }[] } | null;
}

/**
 * Attachment download lane (design §3). GET /vault/blobs/{hash} in 4 MiB
 * Range segments, assemble in memory, blake3_hex, then one writeBinary.
 *
 * RAM: peak ≤ assembled file + one in-flight segment. The adapter has no
 * append; concatenating part-files is read-all + writeBinary (same peak),
 * and blake3_hex is not incremental, so a tmp file cannot lower memory.
 * The 25 MiB audio cap is the accepted worst case (requestUrl also buffers
 * each response wholly).
 *
 * Echo suppression relies on updating the index (hash, size, generation,
 * seq, lastRemoteHash) BEFORE writeBinary. `hydrated` flips only AFTER
 * writeBinary resolves — a failed write leaves hydrated:false (retryable)
 * so a concurrent sweep cannot tombstone a file that is not on disk yet.
 * The vault 'create' from that write routes to onFileChanged → upload() →
 * hash → `entry.lastRemoteHash === hash` returns early.
 */
export class BlobDownloader {
  private pass: Promise<void> | null = null;
  /**
   * Single-slot re-arm (latest wins, no queue): a hydrate request that
   * arrives WHILE a pass runs is remembered and started once that pass
   * settles. It does NOT rescue a permanently hung pass — a never-settling
   * GET never reaches the `finally`. Accepted: no watchdog/timeout is built
   * on purpose, because a timeout short enough to protect a fast device
   * would kill legitimate large downloads on slow devices.
   */
  private retriggerFile: TFile | null = null;
  private idleWaiters: Array<() => void> = [];
  private readonly inflight = new Set<string>();

  constructor(private deps: BlobDownloaderDeps) {}

  /**
   * Resolves when no hydration pass is running. If a pass is in flight,
   * registers a waiter that fires when that pass finishes. No polling.
   */
  whenIdle(): Promise<void> {
    if (!this.pass) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private beginPass(work: () => Promise<void>): Promise<void> {
    const run = work().finally(() => {
      if (this.pass === run) this.pass = null;
      const waiters = this.idleWaiters.splice(0);
      for (const w of waiters) w();
      const retrigger = this.retriggerFile;
      if (retrigger && !this.pass) {
        // Clear before starting: the follow-up pass only re-checks pending
        // links, so `hydrated`/`skipped` short-circuits make it a no-op when
        // nothing is new — no perpetual re-arm loop.
        this.retriggerFile = null;
        void this.hydrateForOpenFile(retrigger);
      }
    });
    this.pass = run;
    return run;
  }

  /**
   * Eager pass: every live `hydrated: false` entry, smallest first,
   * concurrency 2. Desktop hydrates all attachments; mobile hydrates
   * only .obsidian category files (attachments stay lazy via file-open).
   * A pass already in flight is not restarted.
   */
  async hydratePending(): Promise<void> {
    if (this.pass) return;
    if (!(await this.deps.blobsEnabled())) return;
    if (this.pass) return;
    return this.beginPass(() => this.runHydratePending());
  }

  /**
   * Mobile lazy: hydrate only attachments linked from the opened note.
   * Concurrency 1. A pass in flight is not restarted.
   */
  async hydrateForOpenFile(file: TFile): Promise<void> {
    if (!this.deps.isMobile) return;
    if (this.pass) { this.retriggerFile = file; return; }
    if (!(await this.deps.blobsEnabled())) return;
    if (this.pass) { this.retriggerFile = file; return; }
    return this.beginPass(() => this.runHydrateForOpenFile(file));
  }

  private async runHydratePending(): Promise<void> {
    const pending = this.deps.index.entries()
      .filter(([path, e]) => {
        if (e.hydrated || e.skipped) return false;
        // Category files hydrate eagerly on every device class (S1).
        if (this.deps.isMobile) return obsidianSyncCategoryOf(path) !== null;
        return true;
      })
      .sort((a, b) => a[1].size - b[1].size);
    await pool(pending, 2, ([path]) => this.hydrateOne(path));
  }

  private async runHydrateForOpenFile(file: TFile): Promise<void> {
    const cache = this.deps.getFileCache(file);
    const links = [
      ...(cache?.embeds ?? []).map((e) => e.link),
      ...(cache?.links ?? []).map((l) => l.link),
    ];
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const raw of links) {
      const path = this.matchLink(raw);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
    await pool(paths, 1, (path) => this.hydrateOne(path));
  }

  /**
   * Strip `#subpath`, then match `blob_path_key(link)` against `entry.key`
   * (not the raw index map key). Else unique casefolded basename; ambiguous
   * basename is skipped.
   */
  matchLink(raw: string): string | null {
    const hashAt = raw.indexOf('#');
    const link = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    if (!link) return null;
    const key = blob_path_key(link);
    if (key) {
      for (const [path, entry] of this.deps.index.entries()) {
        if (entry.key === key) return path;
      }
    }
    const want = pathCaseKey(basename(link));
    const matches: string[] = [];
    for (const [path] of this.deps.index.entries()) {
      if (pathCaseKey(basename(path)) === want) matches.push(path);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      log('blob.hydrate.ambiguous-basename', link, matches);
    }
    return null;
  }

  async hydrateOne(path: string): Promise<void> {
    if (this.inflight.has(path)) return;
    const entry = this.deps.index.get(path);
    if (!entry || entry.hydrated || entry.skipped || !entry.hash) return;
    this.inflight.add(path);
    try {
      const bytes = await this.download(entry.hash, path, entry.size);
      if (!bytes) return;
      const remoteHash = blake3_hex(bytes);
      if (remoteHash !== entry.hash) {
        // Mismatch: nothing was written (in-memory assembly only). Leave
        // hydrated: false so the next catch-up retries.
        log('blob.hydrate.hash-mismatch', path);
        return;
      }
      // Receiver-side SVG sanitize: runs AFTER the transport hash check and
      // BEFORE any write effect (conflict copy, mkdir, writeBinary), so a
      // throw leaves zero side effects (handled by the catch below).
      // Non-SVG paths bypass it entirely.
      const local = isSvgPath(path) ? sanitize_svg(bytes) : bytes;
      // The index/echo baseline is the LOCAL truth (sanitized bytes); the
      // remote comparison above already happened against transport bytes.
      const hash = isSvgPath(path) ? blake3_hex(local) : remoteHash;

      // N15 gate: the category toggle may have flipped OFF while this download
      // ran. Checked right before the first write effect, against the CURRENT
      // toggle state. Non-categorizable paths are never gated here.
      if (!isCategoryWriteAllowed(path, this.deps.categoryEnabled())) {
        log('blob.hydrate.category-off', path);
        this.deps.index.update(path, { skipped: true, hydrated: false });
        return;
      }

      await this.maybeConflictCopy(path, entry, hash);
      await this.mkdirParents(path);
      const prevLastRemoteHash = entry.lastRemoteHash;
      // lastRemoteHash must be set BEFORE writeBinary (echo suppression).
      // hydrated stays false until the write resolves — a failed write
      // leaves hydrated:false so the next pass retries.
      this.deps.index.update(path, {
        hash,
        size: local.byteLength,
        generation: entry.generation,
        seq: entry.seq,
        lastRemoteHash: hash,
      });
      try {
        await this.deps.writeBinary(path, bufferOf(local));
      } catch (e) {
        this.deps.index.update(path, {
          lastRemoteHash: prevLastRemoteHash,
        });
        throw e;
      }
      this.deps.index.update(path, { hydrated: true });
    } catch (e) {
      error('blob.hydrate failed:', path, e);
    } finally {
      this.inflight.delete(path);
    }
  }

  private async maybeConflictCopy(
    path: string, entry: BlobIndexEntry, remoteHash: string,
  ): Promise<void> {
    // Category files overwrite locally (whole-file LWW, no JSON-key merge).
    // A `.obsidian/app (conflict …).json` could never produce a valid key.
    if (obsidianSyncCategoryOf(path)) return;
    if (!(await this.deps.exists(path))) return;
    const localBytes = new Uint8Array(await this.deps.readBinary(path));
    const localHash = blake3_hex(localBytes);
    if (localHash === remoteHash) return;
    if (localHash === entry.lastRemoteHash) return;
    const dest = conflictPath(this.deps.app, path);
    await this.mkdirParents(dest);
    await this.deps.writeBinary(dest, bufferOf(localBytes));
    this.deps.enqueueUpload(dest);
  }

  /**
   * Resume probe is a 1-byte GET (Range bytes=0-0): 206 with
   * Content-Range bytes 0-0/total, or 416 with bytes star/total.
   * Segment restart from offset 0 after abort is acceptable.
   */
  private async download(
    hash: string, path: string, expectedSize: number,
  ): Promise<Uint8Array | null> {
    const probe = await this.getRange(hash, 0, 0);
    if (probe.status === 200) {
      // Full body on a Range request: bound it before copying.
      if (!this.sizeAllowed(path, probe.arrayBuffer.byteLength, expectedSize)) return null;
      return new Uint8Array(copyBuffer(probe.arrayBuffer));
    }
    const total = parseContentRangeTotal(headerValue(probe.headers, 'Content-Range'));
    if (total === null || (probe.status !== 206 && probe.status !== 416)) {
      if (probe.status === 206 && probe.arrayBuffer.byteLength > 0) {
        if (!this.sizeAllowed(path, probe.arrayBuffer.byteLength, expectedSize)) return null;
        return new Uint8Array(copyBuffer(probe.arrayBuffer));
      }
      return null;
    }
    if (total === 0) return new Uint8Array(0);
    // Reject a bogus/oversized claim BEFORE allocating the assembly buffer or
    // issuing any range follow-up.
    if (!this.sizeAllowed(path, total, expectedSize)) return null;

    const out = new Uint8Array(total);
    let received = 0;
    for (let offset = 0; offset < total; offset += SEGMENT_BYTES) {
      const end = Math.min(offset + SEGMENT_BYTES - 1, total - 1);
      const part = await this.getRange(hash, offset, end);
      if (part.status !== 206 && part.status !== 200) return null;
      const chunk = new Uint8Array(part.arrayBuffer);
      out.set(chunk, offset);
      received += chunk.byteLength;
    }
    if (received !== total) return null;
    return out;
  }

  /**
   * Receive-side bound: a claimed/actual body must stay within AUDIO_CAP (the
   * largest attachment class cap) and match the index entry's size.
   *
   * Known residual: requestUrl/blobRequest buffers a whole response before we
   * can inspect it, so the cap prevents copies, writes and OOM-by-assembly,
   * but not the transport buffering of one oversized body.
   */
  private sizeAllowed(path: string, claimed: number, expected: number): boolean {
    if (claimed > AUDIO_CAP || claimed !== expected) {
      log('blob.hydrate.size-rejected', path, claimed, expected);
      return false;
    }
    return true;
  }

  private async getRange(hash: string, from: number, to: number) {
    const jwt = await this.deps.getJwt();
    return blobRequest({
      serverUrl: this.deps.serverUrl(),
      jwt,
      method: 'GET',
      path: `/vault/blobs/${hash}`,
      headers: { Range: `bytes=${from}-${to}` },
    });
  }

  private async mkdirParents(path: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    if (slash < 0) return;
    const parts = path.slice(0, slash).split('/');
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!(await this.deps.exists(acc))) await this.deps.mkdir(acc);
    }
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer;
}

function copyBuffer(buf: ArrayBuffer): ArrayBuffer {
  return buf.slice(0);
}

/** Parse Content-Range total from a 206 or 416 response header. */
export function parseContentRangeTotal(value: string | undefined): number | null {
  if (!value) return null;
  const m = /bytes\s+(?:\d+-\d+|\*)\/(\d+)/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
