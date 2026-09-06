import { requestUrl } from 'obsidian';
import { blake3_hex } from '../wasm/vaultcrdt_wasm';
import { attachmentCap } from './path-policy';
import { toHttpBase } from './url-policy';
import { log, error, warn } from './logger';
import { attachmentTooLargeMessage } from './user-facing-copy';
import type { BlobIndex } from './blob-index';

/** Debounce before hashing, so foreign writers (camera apps) can finish. */
export const UPLOAD_DEBOUNCE_MS = 2000;
/** One cap notice per path per 5 minutes, like the inbox discovery notice. */
export const CAP_NOTICE_THROTTLE_MS = 5 * 60_000;
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
  stat(path: string): Promise<{ size: number } | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
  notify(text: string): void;
  /** Mobile uploads one file at a time (design §3). */
  isMobile: boolean;
  now?: () => number;
  /** Injected wait — tests resolve immediately. */
  sleep?: (ms: number) => Promise<void>;
}

interface HttpResult { status: number; json: Record<string, unknown> }

interface RemoteState {
  path_key?: unknown;
  state?: unknown;
  content_hash?: unknown;
  seq?: unknown;
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

  constructor(private deps: BlobUploaderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { window.setTimeout(r, ms); }));
  }

  private get maxParallel(): number {
    return this.deps.isMobile ? 1 : 2;
  }

  /** Vault create/modify for an attachment path. */
  onFileChanged(path: string): void {
    if (this.queued.has(path)) return;
    this.queued.add(path);
    this.queue.push(path);
    this.pump();
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

  // ── The lane ──────────────────────────────────────────────────────────────

  private async upload(path: string): Promise<void> {
    if (!(await this.deps.blobsEnabled())) return;
    const key = this.deps.index.keyFor(path);
    if (!key) return;

    const size = await this.stableSize(path);
    if (size === null) return;

    // Cap-skip BEFORE reading: an oversized file is never pulled into memory.
    const cap = attachmentCap(path);
    if (size > cap) {
      this.deps.index.update(path, { size, skipped: true });
      this.noticeCap(path, cap);
      return;
    }

    const bytes = new Uint8Array(await this.deps.readBinary(path));
    const hash = blake3_hex(bytes);

    // Echo suppression: the server already has exactly these bytes for this path.
    const entry = this.deps.index.get(path);
    if (entry && entry.lastRemoteHash === hash) return;

    await this.ensureBlob(hash, size, bytes);
    await this.reference(path, key, hash, size, bytes);
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

  /** Upload the bytes unless the server already stores this hash. */
  private async ensureBlob(hash: string, size: number, bytes: Uint8Array): Promise<void> {
    const start = await this.http('POST', '/vault/blobs/uploads', { hash, size });
    if (start.json.exists === true) {
      log('blob.dedup', { size });
      return;
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
      if (resp.status === 201) return;
      offset = next;
    }
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

    if (resp.status === 412) {
      // Server garbage-collected the blob between upload and reference.
      if (retriedUpload) throw new Error(`blob-path rejected: hash ${hash} missing on server`);
      await this.ensureBlob(hash, size, bytes);
      await this.reference(path, key, hash, size, bytes, true);
      return;
    }
    if (resp.status === 409) {
      // ponytail: LWW loss drops the local version instead of writing a
      // conflict copy. Upgrade path: the S3 conflict-copy flow.
      warn('blob.lww-loss (dropped, conflict copy is S3):', path);
      return;
    }
    if (resp.json.accepted !== true) throw new Error(`blob-path not accepted (status ${resp.status})`);

    const seq = typeof resp.json.seq === 'number' ? resp.json.seq : (prev?.seq ?? 0);
    const serverGen = typeof resp.json.generation === 'number' ? resp.json.generation : generation;
    this.deps.index.update(path, {
      hash, size, generation: serverGen, seq, hydrated: true, lastRemoteHash: hash, skipped: false,
    });
  }

  // ── Catch-up ──────────────────────────────────────────────────────────────

  /**
   * After a successful connect (doc_list complete): fetch blob-path states the
   * server accepted since our highest seq. Downloading is S3 — a changed hash
   * is only recorded as `hydrated: false` here.
   */
  async catchUp(): Promise<void> {
    if (!(await this.deps.blobsEnabled())) return;
    const since = this.deps.index.maxSeq();
    const resp = await this.http('GET', `/vault/blob-paths?since_seq=${since}&limit=1000`);
    const states = Array.isArray(resp.json.states) ? (resp.json.states as RemoteState[]) : [];
    let maxSeq = since;
    for (const s of states) {
      if (typeof s.seq === 'number' && s.seq > maxSeq) maxSeq = s.seq;
      if (typeof s.path_key !== 'string' || s.state !== 'live') continue;
      const path = this.deps.index.pathForKey(s.path_key);
      if (!path) continue;
      const local = this.deps.index.get(path);
      if (!local || local.hash === s.content_hash) continue;
      this.deps.index.update(path, { hydrated: false });
    }
    if (typeof resp.json.max_seq === 'number' && resp.json.max_seq > maxSeq) {
      maxSeq = resp.json.max_seq;
    }
    this.deps.index.noteMaxSeq(maxSeq);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

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
    const jwt = await this.deps.getJwt();
    const resp = await requestUrl({
      url: `${toHttpBase(this.deps.serverUrl())}${opts.path}`,
      method: opts.method,
      headers: { ...opts.headers, Authorization: `Bearer ${jwt}` },
      ...(opts.body === undefined ? {} : { body: opts.body }),
      throw: false,
    });
    const json = (resp.json ?? {}) as Record<string, unknown>;
    return { status: typeof resp.status === 'number' ? resp.status : 200, json };
  }
}
