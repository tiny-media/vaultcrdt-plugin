import { requestUrl } from 'obsidian';
import { blake3_hex, sanitize_svg } from '../wasm/vaultcrdt_wasm';
import { attachmentCap, obsidianSyncCategoryOf, pathCaseKey, type ObsidianSyncEnabled } from './path-policy';
import { toHttpBase } from './url-policy';
import { log, error, warn } from './logger';
import { attachmentTooLargeMessage, quotaExceededMessage, remoteDeleteKeptNoticeMessage, remoteDeleteRemovedNoticeMessage, remoteDeleteTrashedNoticeMessage, svgRejectedMessage } from './user-facing-copy';
import type { BlobIndex } from './blob-index';

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
  /** Per-device .obsidian category toggles (defaults OFF). */
  obsidianSyncEnabled?: () => ObsidianSyncEnabled;
  /** Backstop adapter sweep for .obsidian category files. */
  sweepObsidian?: () => Promise<void>;
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
  private catchUpWork: Promise<void> | null = null;
  /** Paths whose in-flight upload should not reference after a rename/delete. */
  private superseded = new Set<string>();
  /** Session pause after a 413 quota_exceeded; uploads skip until this timestamp. */
  quotaExceededUntil = 0;

  constructor(private deps: BlobUploaderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { window.setTimeout(r, ms); }));
  }

  private get maxParallel(): number {
    return this.deps.isMobile ? 1 : 2;
  }

  private enabled(): ObsidianSyncEnabled {
    return this.deps.obsidianSyncEnabled?.() ?? { settings: false, styles: false };
  }

  /** Vault create/modify for an attachment path. */
  onFileChanged(path: string): void {
    const cat = obsidianSyncCategoryOf(path);
    if (cat && !this.enabled()[cat]) return;
    if (this.queued.has(path)) return;
    this.queued.add(path);
    this.queue.push(path);
    this.pump();
  }

  isPending(path: string): boolean {
    return this.queued.has(path);
  }

  private dropQueued(path: string): void {
    this.queued.delete(path);
    this.queue = this.queue.filter((p) => p !== path);
  }

  /**
   * Rename an attachment. Case-only (same blob path key): one live POST, new
   * display_path, generation+1. Different key: live POST at the new key then
   * tombstone at the old key. Never-synced entries are treated as a new path.
   */
  async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
    const wasPending = this.isPending(oldPath);
    this.dropQueued(oldPath);
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
      this.deps.index.move(oldPath, newPath);
      this.deps.index.update(newPath, { generation, seq, hash: old.hash, size: old.size });
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
      this.deps.index.move(oldPath, newPath);
      this.deps.index.update(newPath, {
        key: newKey, generation, seq, hash: old.hash, size: old.size,
      });
    }

    if (wasPending) this.onFileChanged(newPath);
  }

  /**
   * Local delete of an attachment. Never-synced: index.remove only. Else POST
   * a tombstone then remove. Remote-triggered trash removes the index entry
   * BEFORE fileManager.trashFile so this route sees no entry and no-ops
   * (delete-echo suppression).
   */
  async onFileDeleted(path: string): Promise<void> {
    this.dropQueued(path);
    this.superseded.add(path);
    const entry = this.deps.index.get(path);
    if (!entry || !entry.hash) {
      this.deps.index.remove(path);
      return;
    }
    if (await this.deps.blobsEnabled()) {
      const generation = entry.generation + 1;
      const resp = await this.postPath({
        path, key: entry.key, hash: entry.hash, size: entry.size, generation, state: 'deleted',
      });
      if (resp.json.accepted !== true) {
        error('blob.delete tombstone not accepted:', path, resp.status);
      }
    }
    this.deps.index.remove(path);
  }

  private pump(): void {
    while (this.active < this.maxParallel && this.queue.length > 0) {
      const path = this.queue.shift() as string;
      this.active += 1;
      const run: Promise<void> = this.upload(path)
        .catch((e) => { error('blob.upload failed:', path, e); })
        .finally(() => {
          this.queued.delete(path);
          this.active -= 1;
          this.running.delete(run);
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
    if (!(await this.deps.blobsEnabled())) return;
    if (this.superseded.delete(path)) return;
    const key = this.deps.index.keyFor(path);
    if (!key) return;

    const cat = obsidianSyncCategoryOf(path);
    if (cat && !this.enabled()[cat]) return;

    if (this.now() < this.quotaExceededUntil) {
      this.deps.index.update(path, { skipped: true });
      return;
    }

    let size = await this.stableSize(path);
    if (size === null) return;

    // Cap-skip BEFORE reading: an oversized file is never pulled into memory.
    const cap = attachmentCap(path);
    if (size > cap) {
      this.deps.index.update(path, { size, skipped: true });
      this.noticeCap(path, cap);
      return;
    }

    let bytes: Uint8Array = new Uint8Array(await this.deps.readBinary(path));
    const canonical = await this.canonicalSvgBytes(path, bytes);
    if (canonical === null) return;
    bytes = canonical;
    size = bytes.byteLength;
    const hash = blake3_hex(bytes);
    if (this.superseded.delete(path)) return;

    // Echo suppression: the server already has exactly these bytes for this path.
    const entry = this.deps.index.get(path);
    if (entry && entry.lastRemoteHash === hash) return;

    const uploaded = await this.ensureBlob(path, hash, size, bytes);
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
  private async canonicalSvgBytes(path: string, bytes: Uint8Array): Promise<Uint8Array | null> {
    const ext = pathCaseKey(path).slice(pathCaseKey(path).lastIndexOf('.') + 1);
    if (ext !== 'svg') return bytes;
    const before = bytes.byteLength;
    try {
      const sanitized = sanitize_svg(bytes);
      if (!uint8Equal(bytes, sanitized)) {
        await this.deps.writeBinary(path, bufferOf(sanitized));
      }
      log(`svg sanitized: ${before} → ${sanitized.byteLength} bytes`);
      return sanitized;
    } catch (e) {
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
  private async ensureBlob(path: string, hash: string, size: number, bytes: Uint8Array): Promise<boolean> {
    const start = await this.http('POST', '/vault/blobs/uploads', { hash, size });
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
      const end = Math.min(offset + segment, size);
      let resp: HttpResult;
      try {
        resp = await this.putSegment(uploadId, bytes, offset, end, size);
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
        if (recovered) throw e;
        recovered = true;
        const probe = await this.http('GET', `/vault/blobs/uploads/${uploadId}`);
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
    uploadId: string, bytes: Uint8Array, from: number, to: number, size: number,
  ): Promise<HttpResult> {
    const slice = bytes.slice(from, to);
    return this.request({
      method: 'PUT',
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
    const prev = this.deps.index.get(path);
    const generation = (prev?.generation ?? 0) + 1;
    const resp = await this.http('POST', '/vault/blob-paths', {
      path_key: key,
      display_path: path,
      key_version: 1,
      generation,
      state: 'live',
      content_hash: hash,
      size,
      peer_id: this.deps.peerId(),
    });

    if (resp.status === 413) {
      this.applyQuotaPause(resp.json);
      this.deps.index.update(path, { skipped: true });
      return;
    }
    if (resp.status === 412) {
      // Server garbage-collected the blob between upload and reference.
      if (retriedUpload) throw new Error(`blob-path rejected: hash ${hash} missing on server`);
      if (!await this.ensureBlob(path, hash, size, bytes)) return;
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
    this.deps.index.update(path, {
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
  async catchUp(): Promise<void> {
    if (this.catchUpWork) return this.catchUpWork;
    const run = this.runCatchUp().finally(() => {
      if (this.catchUpWork === run) this.catchUpWork = null;
    });
    this.catchUpWork = run;
    return run;
  }

  private async runCatchUp(): Promise<void> {
    if (!(await this.deps.blobsEnabled())) return;
    const since = this.deps.index.maxSeq();
    const resp = await this.http('GET', `/vault/blob-paths?since_seq=${since}&limit=1000`);
    const states = Array.isArray(resp.json.states) ? (resp.json.states as RemoteState[]) : [];
    let maxSeq = since;
    for (const s of states) {
      if (typeof s.seq === 'number' && s.seq > maxSeq) maxSeq = s.seq;
      if (typeof s.path_key !== 'string') continue;
      if (s.state === 'deleted') {
        await this.applyRemoteTombstone(s);
        continue;
      }
      if (s.state !== 'live') continue;
      await this.applyRemoteLive(s);
    }
    if (typeof resp.json.max_seq === 'number' && resp.json.max_seq > maxSeq) {
      maxSeq = resp.json.max_seq;
    }
    this.deps.index.noteMaxSeq(maxSeq);
    // Category files hydrate eagerly on every device class; downloader filters
    // mobile to .obsidian paths. Sweep is the required backstop (raw is undocumented).
    await this.deps.hydratePending?.();
    await this.deps.sweepObsidian?.();
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
        const cat = obsidianSyncCategoryOf(path);
        // Category files are whole-file LWW (no JSON-key merge, no conflict copies):
        // a differing local file is still indexed so catch-up can overwrite.
        if (same === false && !cat) {
          log('blob.catch-up.unindexed-local-modified', path);
          return;
        }
        if (this.categoryDetached(path)) {
          // Toggle-off: still index so maxSeq stays meaningful. Explicit
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

    const local = this.deps.index.get(path);
    if (!local) return;
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
    if (local.hash === contentHash) return;
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
    const local = this.deps.index.get(path);
    if (!local) return;

    const cat = obsidianSyncCategoryOf(path);
    // Toggle-off + remote tombstone: skipped category → index.remove only.
    // No republish (would upload despite OFF), no file delete (detach).
    if (cat && local.skipped) {
      this.deps.index.remove(path);
      return;
    }

    const remoteGen = typeof s.generation === 'number' ? s.generation : local.generation;
    const stat = await this.deps.stat(path);
    if (!stat) {
      this.deps.index.remove(path);
      return;
    }

    const pending = this.isPending(path);
    let locallyModified = false;
    if (!pending) {
      const bytes = new Uint8Array(await this.deps.readBinary(path));
      locallyModified = blake3_hex(bytes) !== local.lastRemoteHash;
    }
    if (pending || locallyModified) {
      if (!pending) await this.republishLive(path, local, remoteGen);
      this.noticeRemote(path, remoteDeleteKeptNoticeMessage(path));
      return;
    }

    // Echo suppression: drop the index entry BEFORE trash/remove. The vault
    // 'delete' event then hits onFileDeleted's never-synced branch and no-ops.
    this.deps.index.remove(path);
    if (cat) {
      // Category files have no TFile; trashIfPresent would no-op and the sweep
      // would see the leftover file as new and resurrect it on the deleter.
      await this.deps.removeFile?.(path);
      this.noticeRemote(path, remoteDeleteRemovedNoticeMessage(path));
      return;
    }
    await this.deps.trashIfPresent?.(path);
    this.noticeRemote(path, remoteDeleteTrashedNoticeMessage(path));
  }

  private async republishLive(
    path: string,
    local: { key: string; generation: number },
    remoteGen: number,
  ): Promise<void> {
    if ((await this.deps.stat(path))?.size === undefined) return;
    let bytes: Uint8Array = new Uint8Array(await this.deps.readBinary(path));
    const canonical = await this.canonicalSvgBytes(path, bytes);
    if (canonical === null) return;
    bytes = canonical;
    const size = bytes.byteLength;
    const hash = blake3_hex(bytes);
    const uploaded = await this.ensureBlob(path, hash, size, bytes);
    if (!uploaded) return;
    const generation = Math.max(local.generation, remoteGen) + 1;
    const resp = await this.postPath({
      path, key: local.key, hash, size, generation, state: 'live',
    });
    if (resp.status === 422) {
      this.deps.index.update(path, { skipped: true });
      this.noticeSvg(
        path,
        typeof resp.json.error === 'string' ? resp.json.error : 'rejected by server',
      );
      return;
    }
    if (resp.json.accepted !== true) return;
    const seq = typeof resp.json.seq === 'number' ? resp.json.seq : local.generation;
    this.deps.index.update(path, {
      hash, size, generation, seq, hydrated: true, lastRemoteHash: hash, skipped: false,
    });
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

  private async http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    return this.request({
      method,
      path,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
  }

  private async request(opts: {
    method: string; path: string; body?: string | ArrayBuffer; headers?: Record<string, string>;
  }): Promise<HttpResult> {
    return blobRequest({
      serverUrl: this.deps.serverUrl(),
      jwt: await this.deps.getJwt(),
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
