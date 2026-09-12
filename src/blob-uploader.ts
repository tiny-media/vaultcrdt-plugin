import { requestUrl } from 'obsidian';
import { blake3_hex, sanitize_svg } from '../wasm/vaultcrdt_wasm';
import { attachmentCap, isAttachmentPath, isCategoryWriteAllowed, isSvgPath, obsidianSyncCategoryOf, pathCaseKey, type ObsidianSyncEnabled } from './path-policy';
import { toHttpBase } from './url-policy';
import { log, error, warn } from './logger';
import { attachmentTooLargeMessage, quotaExceededMessage, remoteDeleteKeptNoticeMessage, remoteDeleteRemovedNoticeMessage, remoteDeleteTrashedNoticeMessage, svgRejectedMessage } from './user-facing-copy';
import type { BlobIndex } from './blob-index';
import { PathEffects, type EffectAuthority } from './path-effects';

/** Debounce before hashing, so foreign writers (camera apps) can finish. */
export const UPLOAD_DEBOUNCE_MS = 2000;
/** One cap notice per path per 5 minutes, like the inbox discovery notice. */
export const CAP_NOTICE_THROTTLE_MS = 5 * 60_000;
/** After a 413 quota_exceeded, skip new POSTs for this long. */
const QUOTA_RETRY_MS = 60_000;
/** Sentinel key in capNoticeAt: one quota notice per vault per throttle window. */
const QUOTA_NOTICE_KEY = 'quota';
/** Fallback segment size when the server does not name one. */
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
/** How often a size may still change before we give up on this event. */
const STABILITY_ATTEMPTS = 5;

export interface BlobUploaderDeps {
  index: BlobIndex;
  /** Raw server URL from settings (normalised with toHttpBase). */
  serverUrl(): string;
  peerId(): string;
  /** Bearer JWT from the sync engine's existing auth. */
  getJwt(): Promise<string>;
  /** True when the cached /health features advertise FEATURE_BLOBS. */
  blobsEnabled(): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtime?: number } | null>;
  listFiles(): Promise<string[]>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  notify(text: string): void;
  /** Mobile uploads one file at a time (design §3). */
  isMobile: boolean;
  now?: () => number;
  /** Injected wait — tests resolve immediately. */
  sleep?: (ms: number) => Promise<void>;
  /** Desktop eager hydration after catch-up / wake-up. Mobile still hydrates .obsidian category files. */
  hydratePending?: () => Promise<void>;
  /** Trash a vault file if present (remote tombstone for TFile attachments). */
  trashIfPresent?: (path: string) => Promise<void>;
  /** Adapter remove — category files have no TFile / no trash. */
  removeFile?: (path: string) => Promise<void>;
  mkdir?: (dir: string) => Promise<void>;
  rename?: (a: string, b: string) => Promise<void>;
  /** Per-device .obsidian category toggles (defaults OFF). */
  obsidianSyncEnabled?: () => ObsidianSyncEnabled;
  /** Backstop adapter sweep for .obsidian category files. */
  sweepObsidian?: () => Promise<void>;
  /**
   * Mobile only: re-run lazy hydration for the currently active note after
   * catch-up learned new server blob states. Closes the ordering race where
   * the note text (and its metadata-cache event) arrives before the blob
   * index knows the hash. Wired to the debounced scheduler in main.ts.
   */
  hydrateActiveFile?: () => void;
}

export interface BlobHttpResult {
  status: number;
  json: Record<string, unknown>;
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
}

type HttpResult = BlobHttpResult;

interface RemoteState {
  path_key?: unknown;
  state?: unknown;
  content_hash?: unknown;
  seq?: unknown;
  display_path?: unknown;
  size?: unknown;
  generation?: unknown;
}

/**
 * Attachment upload lane (design §3/§4): upload-before-reference. Bytes reach
 * `/vault/blobs/uploads` first; only a fully uploaded (or deduplicated) hash is
 * ever referenced from `/vault/blob-paths`.
 *
 * Dormant unless the server advertises the `blobs` feature.
 */
export class BlobUploader {
  private queue: string[] = [];
  private active = 0;
  private queued = new Set<string>();
  private capNoticeAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = new Set<Promise<void>>();
  private lane: Promise<void> = Promise.resolve();
  // Admission promises coalesce callers even while their lane turn is queued.
  private reconcileRequest: Promise<void> | null = null;
  private catchUpRequest: Promise<void> | null = null;
  private reconcileWork: Promise<void> | null = null;
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.lane.then(fn);
    this.lane = work.then(() => undefined, () => undefined);
    return work;
  }
  private catchUpWork: Promise<void> | null = null;
  private deferredPaths = new Set<string>();
  private trailingPassNeeded = false;
  private settlementGeneration = 0;

  private uploadSettled(path: string): void {
    if (!this.deferredPaths.delete(path)) return;
    this.settlementGeneration += 1;
    this.trailingPassNeeded = true;
    if (!this.catchUpWork) {
      this.trailingPassNeeded = false;
      void this.catchUp().catch((e) => error('blob.catch-up failed:', e));
    }
  }
  /** Paths whose in-flight upload should not reference after a rename/delete. */
  private superseded = new Set<string>();
  /**
   * Paths whose upload was skipped *solely* because blobsEnabled() was false.
   * Without this the create event is consumed and the file only retries at the
   * next app restart (backfill). Bounded: same contents as the queue.
   */
  private gateBlocked = new Set<string>();
  /** Session pause after a 413 quota_exceeded; uploads skip until this timestamp. */
  quotaExceededUntil = 0;

  readonly pathEffects: PathEffects;

  constructor(private deps: BlobUploaderDeps) {
    this.pathEffects = new PathEffects(deps.index, async (path) => {
      if (obsidianSyncCategoryOf(path)) {
        if (!deps.mkdir || !deps.rename) throw new Error('Recovery move unavailable');
        for (const dir of ['.trash', '.trash/vaultcrdt']) {
          if (!await deps.stat(dir)) await deps.mkdir(dir);
        }
        const base = `.trash/vaultcrdt/${Date.now()}-seq${deps.index.get(path)?.seq ?? 0}-${path.replace(/\//g, '~')}`;
        let destination = base;
        let suffix = 2;
        while (await deps.stat(destination)) destination = `${base}-${suffix++}`;
        await deps.rename(path, destination);
      } else {
        if (!deps.trashIfPresent) throw new Error('Trash unavailable');
        await deps.trashIfPresent(path);
      }
    }, (path) => this.superseded.has(path), (path) => this.uploadSettled(path));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { window.setTimeout(r, ms); }));
  }

  private get maxParallel(): number {
    return this.deps.isMobile ? 1 : 2;
  }

  private enabled(): ObsidianSyncEnabled {
    return this.deps.obsidianSyncEnabled?.() ?? { settings: false, styles: false };
  }

  /**
   * N17 gate: may this path still cause a network/file effect right now?
   * Reads the CURRENT toggle state (never a snapshot) and only ever blocks
   * categorizable .obsidian paths — ordinary attachments pass unchanged.
   */
  private writeAllowed(path: string): boolean {
    return isCategoryWriteAllowed(path, this.enabled());
  }

  /** Vault create/modify for an attachment path. */
  onFileChanged(path: string): void {
    if (this.deps.index.get(path)?.pendingDecision) return;
    if (this.deps.index.poisoned()) { warn('blob.queue paused: index recovery required'); return; }
    const cat = obsidianSyncCategoryOf(path);
    if (cat && !this.enabled()[cat]) return;
    if (this.queued.has(path)) return;
    this.queued.add(path);
    this.queue.push(path);
    this.pump();
  }

  private sweepRun: Promise<void> | null = null;

  /** Best-effort recovery of missed attachment watcher events; no polling. */
  sweepAttachments(): Promise<void> {
    if (this.sweepRun) return this.sweepRun;
    const run = this.runAttachmentSweep().finally(() => {
      if (this.sweepRun === run) this.sweepRun = null;
    });
    this.sweepRun = run;
    return run;
  }

  private async runAttachmentSweep(): Promise<void> {
    const { index } = this.deps;
    if (index.poisoned()) return;
    const eligible = (path: string) => isAttachmentPath(path, this.enabled()) &&
      !pathCaseKey(path).startsWith('.obsidian/');
    const present = await this.deps.listFiles();
    for (const path of present) {
      if (index.poisoned()) return;
      if (!eligible(path)) continue;
      const entry = index.get(path);
      if (entry?.pendingDecision || entry?.skipped) continue;
      if (!entry) { this.onFileChanged(path); continue; }
      const valid = () => !index.poisoned() && index.get(path) === entry &&
        !index.get(path)?.pendingDecision;
      const st = await this.deps.stat(path);
      if (!valid() || !st) continue;
      let changed = entry.size !== st.size;
      if (!changed) {
        if (entry.mtime != null && st.mtime != null) {
          changed = entry.mtime !== st.mtime;
        } else if (st.size <= 2 * 1024 * 1024) {
          try {
            changed = blake3_hex(new Uint8Array(await this.deps.readBinary(path))) !== entry.hash;
          } catch {
            changed = true;
          }
        }
        // Accepted blind spot: same-size >2 MiB with missing mtime cannot
        // be detected within this bounded read budget. Mtime is only a heuristic.
      }
      if (valid() && changed) this.onFileChanged(path);
    }
    for (const [path, entry] of index.entries()) {
      if (index.poisoned()) return;
      if (!eligible(path) || !entry.hydrated || entry.skipped || entry.pendingDecision) continue;
      const st = await this.deps.stat(path);
      const current = index.get(path);
      // Decision admission or any entry replacement during stat owns the path.
      if (index.poisoned() || current !== entry || current?.pendingDecision) continue;
      if (!st) await this.onFileDeleted(path);
    }
  }

  /** Re-queue every upload that was skipped by a closed blobs gate. */
  retryGateBlocked(): void {
    if (this.gateBlocked.size === 0) return;
    const paths = [...this.gateBlocked];
    this.gateBlocked.clear();
    for (const path of paths) this.onFileChanged(path);
  }

  /** Paths currently parked on a closed blobs gate (tests / diagnostics). */
  gateBlockedPaths(): string[] {
    return [...this.gateBlocked];
  }

  isPending(path: string): boolean {
    return this.queued.has(path);
  }

  private dropQueued(path: string): void {
    this.queued.delete(path);
    this.queue = this.queue.filter((p) => p !== path);
    this.uploadSettled(path);
  }

  /**
   * Rename an attachment. Case-only (same blob path key): one live POST, new
   * display_path, generation+1. Different key: live POST at the new key then
   * tombstone at the old key. Never-synced entries are treated as a new path.
   */
  async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
    const wasPending = this.isPending(oldPath);
    this.dropQueued(oldPath);
    this.gateBlocked.delete(oldPath);
    this.superseded.add(oldPath);

    const old = this.deps.index.get(oldPath);
    if (!old || !old.hash) {
      if (old) this.deps.index.remove(oldPath);
      this.onFileChanged(newPath);
      return;
    }

    const newKey = this.deps.index.keyFor(newPath);
    if (!newKey) {
      await this.onFileDeleted(oldPath);
      return;
    }

    if (!(await this.deps.blobsEnabled())) {
      this.deps.index.move(oldPath, newPath);
      if (old.key !== newKey) this.deps.index.update(newPath, { pendingDecision: undefined, seq: 0 });
      return;
    }

    // Toggle may have flipped OFF during the awaits above.
    if (!this.writeAllowed(newPath) || !this.writeAllowed(oldPath)) {
      this.deps.index.move(oldPath, newPath);
      this.deps.index.update(newPath, {
        skipped: true,
        ...(old.key !== newKey ? { pendingDecision: undefined, seq: 0 } : {}),
      });
      return;
    }

    const generation = old.generation + 1;
    if (old.key === newKey) {
      const resp = await this.postPath({
        path: newPath, key: newKey, hash: old.hash, size: old.size, generation, state: 'live',
      });
      if (resp.json.accepted !== true) {
        error('blob.rename case-only not accepted:', oldPath, newPath, resp.status);
        return;
      }
      const seq = typeof resp.json.seq === 'number' ? resp.json.seq : old.seq;
      const current = this.deps.index.get(oldPath);
      if (!current || seq <= current.seq) return;
      this.deps.index.move(oldPath, newPath);
      this.deps.index.update(newPath, {
        generation, seq, hash: old.hash, size: old.size,
        ...(current.pendingDecision && seq > current.pendingDecision.seq ? { pendingDecision: undefined } : {}),
      });
    } else {
      const live = await this.postPath({
        path: newPath, key: newKey, hash: old.hash, size: old.size, generation, state: 'live',
      });
      if (live.json.accepted !== true) {
        error('blob.rename live not accepted:', newPath, live.status);
        return;
      }
      const tomb = await this.postPath({
        path: oldPath, key: old.key, hash: old.hash, size: old.size, generation, state: 'deleted',
      });
      if (tomb.json.accepted !== true) {
        error('blob.rename tombstone not accepted:', oldPath, tomb.status);
      }
      const seq = typeof live.json.seq === 'number' ? live.json.seq : old.seq;
      const current = this.deps.index.get(oldPath);
      const destination = this.deps.index.get(newPath);
      if (!current || seq <= current.seq || (destination && seq <= destination.seq)) return;
      this.deps.index.move(oldPath, newPath);
      this.deps.index.update(newPath, {
        key: newKey, generation, seq, hash: old.hash, size: old.size,
        ...(current.pendingDecision && seq > current.pendingDecision.seq ? { pendingDecision: undefined } : {}),
      });
    }

    if (wasPending) this.onFileChanged(newPath);
  }

  /**
   * Local delete of an attachment. Never-synced: index.remove only. Else POST
   * a tombstone then remove only the captured authority. A delete decision
   * identifies a remote-delete echo and suppresses the POST.
   */
  async onFileDeleted(path: string): Promise<void> {
    if (this.pathEffects.consumeSelfDelete(path)) return;
    this.pathEffects.cancelByPath(path);
    this.dropQueued(path);
    this.gateBlocked.delete(path);
    this.superseded.add(path);
    const entry = this.deps.index.get(path);
    if (!entry || !entry.hash) {
      this.deps.index.remove(path);
      return;
    }
    const capturedSeq = entry.seq;
    const decision = entry.pendingDecision;
    if (decision?.kind === 'delete') {
      this.deps.index.remove(path);
      return;
    }
    if (decision?.kind === 'republish' && await this.deps.stat(path)) return;
    if ((await this.deps.blobsEnabled()) && this.writeAllowed(path)) {
      const generation = entry.generation + 1;
      const resp = await this.postPath({
        path, key: entry.key, hash: entry.hash, size: entry.size, generation, state: 'deleted',
      });
      if (resp.json.accepted !== true) {
        error('blob.delete tombstone not accepted:', path, resp.status);
      }
    }
    const removeCaptured = async () => {
      const current = this.deps.index.get(path);
      if (current && current.seq === capturedSeq
        && current.pendingDecision?.kind === decision?.kind
        && current.pendingDecision?.seq === decision?.seq) this.deps.index.remove(path);
    };
    if (decision?.kind === 'republish') await this.pathEffects.withPathLock(path, removeCaptured);
    else await removeCaptured();
  }

  private pump(): void {
    if (this.deps.index.poisoned()) { warn('blob.pump paused: index recovery required'); return; }
    while (this.active < this.maxParallel && this.queue.length > 0) {
      if (this.deps.index.poisoned()) { warn('blob.dequeue paused: index recovery required'); return; }
      const path = this.queue.shift() as string;
      this.active += 1;
      const run: Promise<void> = this.upload(path)
        .catch((e) => { error('blob.upload failed:', path, e); })
        .finally(() => {
          this.queued.delete(path);
          this.active -= 1;
          this.running.delete(run);
          this.uploadSettled(path);
          this.pump();
        });
      this.running.add(run);
    }
  }

  /** Await all queued uploads (tests / shutdown). */
  async flush(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
    await this.deps.index.flush();
  }

  // ── The lane ──────────────────────────────────────────────────────

  private async upload(path: string): Promise<void> {
    if (this.superseded.delete(path)) return;
    if (!(await this.deps.blobsEnabled())) {
      this.gateBlocked.add(path);
      return;
    }
    if (this.superseded.delete(path) || this.deps.index.get(path)?.pendingDecision) return;
    const key = this.deps.index.keyFor(path);
    if (!key) return;

    const cat = obsidianSyncCategoryOf(path);
    if (cat && !this.enabled()[cat]) return;

    if (this.now() < this.quotaExceededUntil) {
      this.deps.index.update(path, { skipped: true });
      return;
    }

    let size = await this.stableSize(path);
    if (size === null || this.deps.index.get(path)?.pendingDecision) return;

    // Cap-skip BEFORE reading: an oversized file is never pulled into memory.
    const cap = attachmentCap(path);
    if (size > cap) {
      this.deps.index.update(path, { size, skipped: true });
      this.noticeCap(path, cap);
      return;
    }

    let bytes: Uint8Array = new Uint8Array(await this.deps.readBinary(path));
    if (this.deps.index.get(path)?.pendingDecision) return;
    const canonical = await this.canonicalSvgBytes(path, bytes);
    if (this.deps.index.get(path)?.pendingDecision) return;
    if (canonical === null) return;
    bytes = canonical;
    size = bytes.byteLength;
    const hash = blake3_hex(bytes);
    if (this.superseded.delete(path)) return;

    // Echo suppression: the server already has exactly these bytes for this path.
    const entry = this.deps.index.get(path);
    if (entry && entry.lastRemoteHash === hash) return;

    // Gate immediately before the first POST effect (getJwt() sits between
    // this decision and the request, so re-check here, not earlier).
    if (!this.writeAllowed(path)) {
      this.deps.index.update(path, { skipped: true });
      return;
    }

    const valid = () => !this.deps.index.get(path)?.pendingDecision && !this.superseded.has(path);
    const uploaded = await this.ensureBlob(path, hash, size, bytes, valid);
    if (!valid()) return;
    if (!uploaded) {
      this.deps.index.update(path, { skipped: true });
      return;
    }
    if (this.superseded.delete(path)) return;
    await this.reference(path, key, hash, size, bytes);
  }

  /**
   * SVG: sanitize, write back if bytes changed, return canonical bytes.
   * Non-SVG: return `bytes` unchanged. Sanitize failure parks and returns null.
   */
  private async canonicalSvgBytes(path: string, bytes: Uint8Array, valid = () => !this.deps.index.get(path)?.pendingDecision,
    authority: EffectAuthority = { kind: 'upload' }): Promise<Uint8Array | null> {
    if (!valid()) return null;
    if (!isSvgPath(path)) return bytes;
    const before = bytes.byteLength;
    let writeEffect = false;
    try {
      const sanitized = sanitize_svg(bytes);
      if (!uint8Equal(bytes, sanitized)) {
        writeEffect = true;
        const token = this.pathEffects.register(path, authority);
        try {
          const normal = await this.pathEffects.withPathLock(path, async () => {
            if (this.pathEffects.isCancelled(token) || !valid()) return false;
            await this.deps.writeBinary(path, bufferOf(sanitized));
            return await this.pathEffects.classify(token) === 'normal';
          });
          if (!normal || !valid()) return null;
        } finally { this.pathEffects.settle(token); }
      }
      log(`svg sanitized: ${before} → ${sanitized.byteLength} bytes`);
      return sanitized;
    } catch (e) {
      if (writeEffect) { error('blob.svg write effect failed:', path, e); return null; }
      if (!valid()) return null;
      this.deps.index.update(path, { skipped: true });
      this.noticeSvg(path, thrownReason(e));
      return null;
    }
  }

  /** Debounce, then require the size to be identical across two stat calls. */
  private async stableSize(path: string): Promise<number | null> {
    let previous = (await this.deps.stat(path))?.size;
    if (previous === undefined) return null;
    for (let i = 0; i < STABILITY_ATTEMPTS; i++) {
      await this.sleep(UPLOAD_DEBOUNCE_MS);
      const next = (await this.deps.stat(path))?.size;
      if (next === undefined) return null;
      if (next === previous) return next;
      previous = next;
    }
    return null;
  }

  private noticeCap(path: string, cap: number): void {
    const last = this.capNoticeAt.get(path);
    if (last !== undefined && this.now() - last < CAP_NOTICE_THROTTLE_MS) return;
    this.capNoticeAt.set(path, this.now());
    this.deps.notify(attachmentTooLargeMessage(path, cap));
  }

  private noticeSvg(path: string, reason: string): void {
    const key = `svg:${path}`;
    const last = this.capNoticeAt.get(key);
    if (last !== undefined && this.now() - last < CAP_NOTICE_THROTTLE_MS) return;
    this.capNoticeAt.set(key, this.now());
    this.deps.notify(svgRejectedMessage(path, reason));
  }

  private noticeQuota(quotaBytes?: number): void {
    const last = this.capNoticeAt.get(QUOTA_NOTICE_KEY);
    if (last !== undefined && this.now() - last < CAP_NOTICE_THROTTLE_MS) return;
    this.capNoticeAt.set(QUOTA_NOTICE_KEY, this.now());
    this.deps.notify(
      typeof quotaBytes === 'number'
        ? quotaExceededMessage(quotaBytes)
        : 'VaultCRDT: this vault is over the storage limit and attachments will not sync.',
    );
  }

  /** Pause the upload lane after a 413. quota_bytes only feeds the notice text. */
  private applyQuotaPause(json: Record<string, unknown>): void {
    this.quotaExceededUntil = this.now() + QUOTA_RETRY_MS;
    const quotaBytes = json.quota_bytes;
    this.noticeQuota(typeof quotaBytes === 'number' ? quotaBytes : undefined);
  }

  /** Upload the bytes unless the server already stores this hash. Returns false on quota or 422. */
  private async ensureBlob(path: string, hash: string, size: number, bytes: Uint8Array, valid = () => true): Promise<boolean> {
    if (!valid()) return false;
    if (!this.writeAllowed(path)) {
      this.deps.index.update(path, { skipped: true });
      return false;
    }
    const start = await this.http('POST', '/vault/blobs/uploads', { hash, size }, valid);
    if (!valid()) return false;
    if (start.status === 413) {
      this.applyQuotaPause(start.json);
      return false;
    }
    if (start.status === 422) {
      this.deps.index.update(path, { skipped: true });
      this.noticeSvg(
        path,
        typeof start.json.error === 'string' ? start.json.error : 'rejected by server',
      );
      return false;
    }
    if (start.json.exists === true) {
      log('blob.dedup', { size });
      return true;
    }
    const uploadId = typeof start.json.upload_id === 'string' ? start.json.upload_id : '';
    if (!uploadId) throw new Error(`blob upload not started (status ${start.status})`);
    const segment = typeof start.json.segment_bytes === 'number' && start.json.segment_bytes > 0
      ? start.json.segment_bytes
      : DEFAULT_SEGMENT_BYTES;
    let offset = typeof start.json.next_offset === 'number' ? start.json.next_offset : 0;
    let recovered = false;

    while (offset < size) {
      if (!valid()) return false;
      const end = Math.min(offset + segment, size);
      let resp: HttpResult;
      // Mid-cycle flip: no further segment PUT once the category is OFF.
      if (!this.writeAllowed(path)) {
        this.deps.index.update(path, { skipped: true });
        return false;
      }
      try {
        resp = await this.putSegment(uploadId, bytes, offset, end, size, valid);
        if (!valid()) return false;
        if (resp.status === 422) {
          this.deps.index.update(path, { skipped: true });
          this.noticeSvg(
            path,
            typeof resp.json.error === 'string' ? resp.json.error : 'rejected by server',
          );
          return false;
        }
        if (resp.status !== 201 && resp.status !== 202 && resp.status !== 409) {
          throw new Error(`segment upload failed (status ${resp.status})`);
        }
      } catch (e) {
        // Reconnect resume: ask the server once where it wants us to continue.
        if (!valid()) return false;
        if (recovered) throw e;
        recovered = true;
        const probe = await this.http('GET', `/vault/blobs/uploads/${uploadId}`, undefined, valid);
        if (!valid()) return false;
        offset = typeof probe.json.next_offset === 'number' ? probe.json.next_offset : offset;
        continue;
      }
      // 409 carries the offset the server actually has — jump there (resume).
      const next = typeof resp.json.next_offset === 'number' ? resp.json.next_offset : end;
      if (resp.status === 201) return true;
      offset = next;
    }
    return true;
  }

  private async putSegment(
    uploadId: string, bytes: Uint8Array, from: number, to: number, size: number, valid: () => boolean,
  ): Promise<HttpResult> {
    const slice = bytes.slice(from, to);
    return this.request({
      method: 'PUT',
      valid,
      path: `/vault/blobs/uploads/${uploadId}`,
      body: slice.buffer,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${from}-${to - 1}/${size}`,
      },
    });
  }

  /** Reference the (now uploaded) hash from the path state. */
  private async reference(
    path: string, key: string, hash: string, size: number, bytes: Uint8Array,
    retriedUpload = false,
  ): Promise<void> {
    if (this.now() < this.quotaExceededUntil) {
      this.deps.index.update(path, { skipped: true });
      return;
    }
    // Gate immediately before the reference POST.
    if (!this.writeAllowed(path)) {
      this.deps.index.update(path, { skipped: true });
      return;
    }
    const prev = this.deps.index.get(path);
    if (prev?.pendingDecision || this.superseded.has(path)) return;
    const generation = (prev?.generation ?? 0) + 1;
    const valid = () => !this.deps.index.get(path)?.pendingDecision && !this.superseded.has(path);
    const resp = await this.http('POST', '/vault/blob-paths', {
      path_key: key,
      display_path: path,
      key_version: 1,
      generation,
      state: 'live',
      content_hash: hash,
      size,
      peer_id: this.deps.peerId(),
    }, valid);

    if (resp.status === 413) {
      this.applyQuotaPause(resp.json);
      this.deps.index.update(path, { skipped: true });
      return;
    }
    if (resp.status === 412) {
      // Server garbage-collected the blob between upload and reference.
      if (retriedUpload) throw new Error(`blob-path rejected: hash ${hash} missing on server`);
      if (!await this.ensureBlob(path, hash, size, bytes, valid) || !valid()) return;
      await this.reference(path, key, hash, size, bytes, true);
      return;
    }
    if (resp.status === 409) {
      // note: LWW loss drops the local version instead of writing a
      // conflict copy. Upgrade path: the S3 conflict-copy flow.
      warn('blob.lww-loss (dropped, conflict copy is S3):', path);
      return;
    }
    if (resp.status === 422) {
      this.deps.index.update(path, { skipped: true });
      this.noticeSvg(
        path,
        typeof resp.json.error === 'string' ? resp.json.error : 'rejected by server',
      );
      return;
    }
    if (resp.json.accepted !== true) throw new Error(`blob-path not accepted (status ${resp.status})`);

    const seq = typeof resp.json.seq === 'number' ? resp.json.seq : (prev?.seq ?? 0);
    const st = await this.deps.stat(path);
    const current = this.deps.index.get(path);
    if (seq <= (current?.seq ?? 0)) return;
    this.deps.index.update(path, {
      ...(current?.pendingDecision && seq > current.pendingDecision.seq ? { pendingDecision: undefined } : {}),
      hash, size, generation, seq, hydrated: true, lastRemoteHash: hash, skipped: false,
      ...(typeof st?.mtime === 'number' ? { mtime: st.mtime } : {}),
    });
  }

  // ── Catch-up ──────────────────────────────────────────────────────

  /**
   * After a successful connect (doc_list complete): fetch blob-path states the
   * server accepted since our highest seq. Downloading is S3 — a changed hash
   * is only recorded as `hydrated: false` here.
   */
  catchUp(): Promise<void> {
    if (this.catchUpRequest) return this.catchUpRequest;
    const request = this.enqueue(() => {
      if (this.catchUpWork) return this.catchUpWork;
      const run = this.runCatchUp().finally(() => {
        if (this.catchUpWork === run) this.catchUpWork = null;
      });
      this.catchUpWork = run;
      return run;
    }).finally(() => {
      if (this.catchUpRequest === request) this.catchUpRequest = null;
      if (this.trailingPassNeeded) {
        this.trailingPassNeeded = false;
        void this.catchUp().catch((e) => error('blob.catch-up failed:', e));
      }
    });
    this.catchUpRequest = request;
    return request;
  }

  private async runCatchUp(): Promise<void> {
    if (this.deps.index.poisoned()) { warn('blob.catch-up paused: index recovery required'); return; }
    if (!(await this.deps.blobsEnabled())) return;
    let p = this.deps.index.cursor();
    let fence: number | undefined;
    let applied = 0;
    let deferred = false;
    const settlementAtStart = this.settlementGeneration;
    const validSeq = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    try {
      walk: while (true) {
        const { json } = await this.http('GET', `/vault/blob-paths?since_seq=${p}&limit=1000`);
        if (!Array.isArray(json.states) ||
            ('max_seq' in json && !validSeq(json.max_seq))) throw new Error('Malformed blob-path envelope');
        const states = json.states as (RemoteState & { seq: number })[];
        let previous = -1;
        for (const s of states) {
          if (!s || !validSeq(s.seq) || s.seq <= previous) throw new Error('Malformed blob-path sequence');
          previous = s.seq;
        }
        if (fence === undefined) {
          if (!('max_seq' in json) && states.length === 0) break;
          fence = 'max_seq' in json ? json.max_seq as number : states[states.length - 1].seq;
        }
        if (p === fence) break;
        for (const s of states) {
          if (s.seq > fence) break walk;
          if (s.state === 'deleted') {
            const path = (typeof s.path_key === 'string' ? this.deps.index.pathForKey(s.path_key) : undefined)
              ?? s.display_path;
            if (typeof path === 'string' && (this.isPending(path) || this.pathEffects.pending(path))) {
              this.deferredPaths.add(path);
              this.noticeRemote(path, remoteDeleteKeptNoticeMessage(path));
              deferred = true;
              break walk;
            }
            await this.applyRemoteTombstone(s);
            applied += 1;
          } else if (s.state === 'live') {
            await this.applyRemoteLive(s);
            applied += 1;
          }
          p = s.seq;
          if (p === fence) break walk;
        }
        if (states.length < 1000) break;
      }
    } catch (e) {
      error('blob.catch-up failed:', e);
      return;
    } finally {
      if (this.settlementGeneration !== settlementAtStart) this.trailingPassNeeded = true;
    }
    if (this.deps.index.poisoned()) return;
    await this.deps.index.flush();
    if (this.deps.index.lastPersistError || this.deps.index.poisoned()) return;
    if (fence !== undefined) this.deps.index.advanceCursor(deferred ? p : fence);
    await this.reconcilePendingDeletesInternal(true);
    if (this.deps.index.poisoned()) { warn('blob.catch-up tail paused: index recovery required'); return; }
    // Category files hydrate eagerly on every device class; downloader filters
    // mobile to .obsidian paths. Sweep is the required backstop (raw is undocumented).
    await this.deps.hydratePending?.();
    await this.deps.sweepObsidian?.();
    await this.sweepAttachments();
    if (applied > 0 && this.deps.isMobile) this.deps.hydrateActiveFile?.();
  }

  /** Second-device catch-up: create an index entry when the server has a live path we have never seen. */
  private async applyRemoteLive(s: RemoteState): Promise<void> {
    const pathKey = s.path_key;
    if (typeof pathKey !== 'string') return;
    const contentHash = typeof s.content_hash === 'string' ? s.content_hash : '';
    if (!contentHash) return;
    const size = typeof s.size === 'number' ? s.size : 0;
    const generation = typeof s.generation === 'number' ? s.generation : 0;
    const seq = typeof s.seq === 'number' ? s.seq : 0;
    const display = typeof s.display_path === 'string' ? s.display_path : undefined;

    let path = this.deps.index.pathForKey(pathKey);
    if (!path) {
      if (!display || !this.deps.index.keyFor(display)) return;
      path = display;
      const local = this.deps.index.get(path);
      if (!local) {
        const same = await this.localFileMatches(path, contentHash, size);
        // An upload acknowledgement may have installed an entry while reading.
        if (this.deps.index.get(path)) return this.applyRemoteLive(s);
        const cat = obsidianSyncCategoryOf(path);
        // Category files are whole-file LWW (no JSON-key merge, no conflict copies):
        // a differing local file is still indexed so catch-up can overwrite.
        if (same === false && !cat) {
          log('blob.catch-up.unindexed-local-modified', path);
          return;
        }
        if (this.categoryDetached(path)) {
          // Toggle-off: still index the per-path server state. Explicit
          // skipped+hydrated:false — unknown-path defaults are hydrated:true
          // and the sweep would tombstone a file this device never had.
          this.deps.index.update(path, {
            hash: contentHash,
            size,
            generation,
            seq,
            skipped: true,
            hydrated: false,
            lastRemoteHash: null,
          });
          return;
        }
        this.deps.index.update(path, {
          hash: contentHash,
          size,
          generation,
          seq,
          hydrated: same === true,
          lastRemoteHash: same === true ? contentHash : null,
        });
        return;
      }
    }

    let local = this.deps.index.get(path);
    if (!local || seq < local.seq) return;
    if (local.pendingDecision && seq > local.seq) {
      this.deps.index.update(path, { pendingDecision: undefined });
      const stat = await this.deps.stat(path);
      local = this.deps.index.get(path);
      if (!local || seq < local.seq) return;
      if (!stat) this.deps.index.update(path, { hydrated: false });
    }
    if (this.categoryDetached(path)) {
      this.deps.index.update(path, {
        hash: contentHash,
        size,
        generation,
        seq,
        skipped: true,
        hydrated: false,
      });
      return;
    }
    if (local.hash === contentHash) {
      this.deps.index.update(path, { seq, generation });
      return;
    }
    this.deps.index.update(path, {
      hash: contentHash,
      size,
      generation,
      seq,
      hydrated: false,
    });
  }

  private categoryDetached(path: string): boolean {
    const cat = obsidianSyncCategoryOf(path);
    return !!(cat && !this.enabled()[cat]);
  }

  private async localFileMatches(path: string, contentHash: string, size: number): Promise<boolean | null> {
    const stat = await this.deps.stat(path);
    if (!stat) return null;
    if (size > 0 && stat.size !== size) return false;
    const bytes = new Uint8Array(await this.deps.readBinary(path));
    return blake3_hex(bytes) === contentHash;
  }

  private async applyRemoteTombstone(s: RemoteState): Promise<void> {
    if (typeof s.path_key !== 'string') return;
    const path = this.deps.index.pathForKey(s.path_key)
      ?? (typeof s.display_path === 'string' ? s.display_path : undefined);
    if (!path) return;
    const seq = typeof s.seq === 'number' ? s.seq : 0;
    let local = this.deps.index.get(path);
    if (!local || seq < local.seq || local.pendingDecision?.seq === seq) return;

    const cat = obsidianSyncCategoryOf(path);
    // Toggle-off + remote tombstone: skipped category → index.remove only.
    // No republish (would upload despite OFF), no file delete (detach).
    if (cat && local.skipped) {
      this.deps.index.remove(path);
      return;
    }
    // N16: category toggle OFF right now — detach only. No trash, no
    // adapter.remove, no republish; just drop the index entry.
    if (!this.writeAllowed(path)) {
      this.deps.index.remove(path);
      return;
    }

    const remoteGen = typeof s.generation === 'number' ? s.generation : local.generation;
    const stat = await this.deps.stat(path);
    local = this.deps.index.get(path);
    if (!local || seq < local.seq) return;
    if (!stat) {
      this.deps.index.remove(path);
      return;
    }

    const pending = this.isPending(path);
    let locallyModified = false;
    let expectedHash = '';
    if (!pending) {
      const bytes = new Uint8Array(await this.deps.readBinary(path));
      local = this.deps.index.get(path);
      if (!local || seq < local.seq) return;
      expectedHash = blake3_hex(bytes);
      locallyModified = expectedHash !== local.lastRemoteHash;
    }
    if (pending || locallyModified) {
      this.deps.index.update(path, {
        seq, pendingDecision: { kind: 'republish', seq, generation: remoteGen },
      });
      await this.deps.index.flush();
      this.noticeRemote(path, remoteDeleteKeptNoticeMessage(path));
      return;
    }

    this.deps.index.update(path, {
      seq, pendingDecision: { kind: 'delete', expectedHash, expectedSize: stat.size, seq, generation: remoteGen },
    });
    await this.deps.index.flush();
  }

  reconcilePendingDeletes(networkReady: boolean): Promise<void> {
    if (this.reconcileRequest) return this.reconcileRequest;
    const request = this.enqueue(() => {
      if (this.reconcileWork) return this.reconcileWork;
      const work = this.reconcilePendingDeletesInternal(networkReady).finally(() => {
        if (this.reconcileWork === work) this.reconcileWork = null;
      });
      this.reconcileWork = work;
      return work;
    }).finally(() => {
      if (this.reconcileRequest === request) this.reconcileRequest = null;
    });
    this.reconcileRequest = request;
    return request;
  }

  private async reconcilePendingDeletesInternal(networkReady: boolean): Promise<void> {
    const { index } = this.deps;
    for (const [path, entry] of index.entries()) {
      if (index.poisoned()) return;
      let decision = entry.pendingDecision;
      if (!decision) continue;
      const valid = () => {
        const current = index.get(path);
        return !index.poisoned() && current?.key === entry.key && current.seq === entry.seq &&
          current.pendingDecision?.kind === decision?.kind && current.pendingDecision?.seq === decision?.seq;
      };
      try {
        if (decision.kind === 'delete') {
          const stat = await this.deps.stat(path);
          if (!valid()) continue;
          if (!stat) { index.remove(path); continue; }
          let mismatch = stat.size !== decision.expectedSize;
          if (!mismatch) {
            const bytes = await this.deps.readBinary(path);
            if (!valid()) continue;
            mismatch = blake3_hex(new Uint8Array(bytes)) !== decision.expectedHash;
          }
          if (!mismatch) {
            const stable = await this.deps.stat(path);
            if (!valid()) continue;
            mismatch = !stable || stable.size !== stat.size;
          }
          if (mismatch) {
            if (!valid()) continue;
            const next = { kind: 'republish' as const, seq: decision.seq, generation: decision.generation };
            index.update(path, { pendingDecision: next });
            decision = next;
            await index.flush();
            if (!valid()) continue;
            if (index.lastPersistError) continue;
          } else {
            await this.pathEffects.withPathLock(path, async () => {
              const category = obsidianSyncCategoryOf(path);
              const effectAllowed = () => {
                if (!valid()) return false;
                if (!this.writeAllowed(path)) { index.remove(path); return false; }
                return true;
              };
              if (!effectAllowed()) return;
              if (category) {
                if (!this.deps.mkdir || !this.deps.rename) throw new Error('Recovery move unavailable');
                // Adapter mkdir is not recursive on every platform.
                for (const dir of ['.trash', '.trash/vaultcrdt']) {
                  const exists = await this.deps.stat(dir);
                  if (!valid()) break;
                  if (!exists) {
                    await this.deps.mkdir(dir);
                    if (!valid()) break;
                  }
                }
                if (!valid()) return;
                const base = `.trash/vaultcrdt/${this.now()}-seq${decision!.seq}-${path.replace(/\//g, '~')}`;
                let destination = base;
                let suffix = 2;
                while (true) {
                  const exists = await this.deps.stat(destination);
                  if (!valid()) break;
                  if (!exists) break;
                  destination = `${base}-${suffix++}`;
                }
                if (!effectAllowed()) return;
                await this.deps.rename(path, destination);
              } else {
                if (!effectAllowed()) return;
                if (!this.deps.trashIfPresent) throw new Error('Trash unavailable');
                await this.deps.trashIfPresent(path);
              }
              if (!valid()) return;
              const remaining = await this.deps.stat(path);
              if (!valid()) return;
              if (remaining) { error('blob.reconcile: file still present', path); return; }
              index.remove(path);
              this.noticeRemote(path, category ? remoteDeleteRemovedNoticeMessage(path) : remoteDeleteTrashedNoticeMessage(path));
            });
            continue;
          }
        }
        if (decision.kind === 'republish' && networkReady && valid()) {
          const attempted = index.get(path)!;
          const status = await this.republishLive(path, attempted, decision.generation);
          if (!valid()) continue;
          if (status === 'lost' && index.get(path) === attempted) {
            index.update(path, { pendingDecision: undefined });
            this.noticeRemote(path, remoteDeleteKeptNoticeMessage(path));
          }
        }
      } catch (e) {
        if (index.poisoned()) return;
        error('blob.reconcile failed:', path, e);
      }
    }
  }

  private async republishLive(
    path: string,
    local: { key: string; generation: number },
    remoteGen = 0,
    minGeneration = 0,
  ): Promise<'ack' | 'lost' | 'error' | 'skipped'> {
    const captured = this.deps.index.get(path);
    const valid = () => {
      const current = this.deps.index.get(path);
      return !this.deps.index.poisoned() && !!current && current.key === local.key &&
        current.seq === captured?.seq && current.pendingDecision?.kind === captured?.pendingDecision?.kind &&
        current.pendingDecision?.seq === captured?.pendingDecision?.seq;
    };
    try {
      if (!valid()) return 'skipped';
      if ((await this.deps.stat(path))?.size === undefined || !valid()) return 'skipped';
      let bytes: Uint8Array = new Uint8Array(await this.deps.readBinary(path));
      if (!valid()) return 'skipped';
      const canonical = await this.canonicalSvgBytes(path, bytes, valid,
        { kind: 'decision', seq: captured!.pendingDecision?.seq ?? captured!.seq });
      if (!valid()) return 'skipped';
      if (canonical === null) return 'error';
      bytes = canonical;
      const size = bytes.byteLength;
      const hash = blake3_hex(bytes);
      const uploaded = await this.ensureBlob(path, hash, size, bytes, valid);
      if (!valid()) return 'skipped';
      if (!uploaded) return 'error';
      if (!this.writeAllowed(path)) return 'skipped';
      const generation = Math.max(local.generation, remoteGen, minGeneration - 1) + 1;
      const resp = await this.postPath({
        path, key: local.key, hash, size, generation, state: 'live',
      });
      if (!valid()) return 'skipped';
      if (resp.status === 409) return 'lost';
      if (resp.status === 422) {
        this.noticeSvg(path, typeof resp.json.error === 'string' ? resp.json.error : 'rejected by server');
        return 'error';
      }
      if (resp.json.accepted !== true) return 'error';
      const seq = typeof resp.json.seq === 'number' ? resp.json.seq : local.generation;
      const current = this.deps.index.get(path);
      if (!current || seq <= current.seq) return 'skipped';
      this.deps.index.update(path, {
        ...(current.pendingDecision && seq > current.pendingDecision.seq ? { pendingDecision: undefined } : {}),
        hash, size, generation, seq, hydrated: true, lastRemoteHash: hash, skipped: false,
      });
      return 'ack';
    } catch (e) {
      if (!valid()) return 'skipped';
      error('blob.republish failed:', path, e);
      return 'error';
    }
  }

  private noticeRemote(path: string, text: string): void {
    const last = this.capNoticeAt.get(path);
    if (last !== undefined && this.now() - last < CAP_NOTICE_THROTTLE_MS) return;
    this.capNoticeAt.set(path, this.now());
    this.deps.notify(text);
  }

  private async postPath(opts: {
    path: string; key: string; hash: string; size: number;
    generation: number; state: 'live' | 'deleted';
  }): Promise<HttpResult> {
    return this.http('POST', '/vault/blob-paths', {
      path_key: opts.key,
      display_path: opts.path,
      key_version: 1,
      generation: opts.generation,
      state: opts.state,
      content_hash: opts.hash,
      size: opts.size,
      peer_id: this.deps.peerId(),
    });
  }

  // ── HTTP ─────────────────────────────────────────────────────────

  private async http(method: string, path: string, body?: unknown, valid?: () => boolean): Promise<HttpResult> {
    return this.request({
      valid,
      method,
      path,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
  }

  private async request(opts: {
    method: string; path: string; body?: string | ArrayBuffer; headers?: Record<string, string>; valid?: () => boolean;
  }): Promise<HttpResult> {
    const jwt = await this.deps.getJwt();
    if (opts.valid && !opts.valid()) throw new Error('Blob authority changed before request');
    return blobRequest({
      serverUrl: this.deps.serverUrl(),
      jwt,
      method: opts.method,
      path: opts.path,
      body: opts.body,
      headers: opts.headers,
    });
  }
}

/** Read a response header without assuming the server's casing. */
export function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

export async function blobRequest(opts: {
  serverUrl: string;
  jwt: string;
  method: string;
  path: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
}): Promise<BlobHttpResult> {
  const resp = await requestUrl({
    url: `${toHttpBase(opts.serverUrl)}${opts.path}`,
    method: opts.method,
    headers: { ...opts.headers, Authorization: `Bearer ${opts.jwt}` },
    ...(opts.body === undefined ? {} : { body: opts.body }),
    throw: false,
  });
  const arrayBuffer = resp.arrayBuffer instanceof ArrayBuffer ? resp.arrayBuffer : new ArrayBuffer(0);
  const headers = resp.headers && typeof resp.headers === 'object' && !Array.isArray(resp.headers)
    ? resp.headers
    : {};
  return {
    status: typeof resp.status === 'number' ? resp.status : 200,
    json: parseResponseJson(resp),
    arrayBuffer,
    headers,
  };
}

function parseResponseJson(resp: { json?: unknown; text?: unknown }): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = resp.json;
  } catch {
    raw = undefined;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (raw === undefined || raw === null) {
    try {
      const text = typeof resp.text === 'string' ? resp.text : '';
      if (text) {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      return {};
    }
  }
  return {};
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer;
}

function thrownReason(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error && e.message) return e.message;
  return 'invalid SVG';
}
