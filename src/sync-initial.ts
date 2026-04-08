import { App, TFile } from 'obsidian';
import { createDocument, type WasmSyncDocument } from './wasm-bridge';
import { DocumentManager } from './document-manager';
import type { VVCacheEntry } from './state-storage';
import { vvCovers, hasSharedHistory, vvEquals, conflictPath, fnv1aHash } from './conflict-utils';
import { EditorIntegration } from './editor-integration';
import { PushHandler } from './push-handler';
import { log, warn, error } from './logger';
import { isSyncablePath } from './path-policy';

export type SyncMode = 'pull' | 'push' | 'merge';

interface DocEntry {
  doc_uuid: string;
  updated_at: string;
  server_vv: Uint8Array;
}

const PARALLEL_DOWNLOADS = 5;

// Marker identifiers for throwaway probe documents used to inspect server
// snapshots without polluting the device's stable peer-id space. The probe
// doc's VV/peerId never escapes its enclosing function scope.
const PROBE_DOC_UUID = '__probe__';
const PROBE_PEER_ID = '__probe__';

/**
 * Return the freshest local text for a file: editor content if any leaf has
 * the file open (covers active AND background editors via iterateAllLeaves),
 * otherwise the on-disk content. Adopt-/conflict-decisions in the initial
 * sync MUST use this — disk content alone can be stale relative to unsaved
 * editor edits, which would lead to false adopts and lost work.
 */
async function readEffectiveLocalContent(
  app: App,
  editor: EditorIntegration,
  file: TFile,
): Promise<string> {
  const fromEditor = editor.readCurrentContent(file.path);
  if (fromEditor !== null) return fromEditor;
  return await app.vault.read(file);
}

export interface InitialSyncDeps {
  app: App;
  docs: DocumentManager;
  editor: EditorIntegration;
  push: PushHandler;
  lastServerVV: Map<string, string>;
  lastRemoteWrite: Map<string, string>;
  writingFromRemote: Set<string>;
  tag: string;
  peerId: string;
  ws: WebSocket | null;
  send: (msg: object) => void;
  requestDocList: () => Promise<{ docs: DocEntry[]; tombstones: string[] }>;
  requestSyncStart: (
    docUuid: string,
    clientVV: string | null,
  ) => Promise<{ delta: Uint8Array; serverVV: string } | null>;
  trace: (event: string, data?: Record<string, unknown>) => void;
  tracePath: (event: string, path: string, data?: Record<string, unknown>) => void;
  observePath: (path: string) => void;
  wasEditedDuringStartup: (path: string) => boolean;
}

export async function runInitialSync(
  deps: InitialSyncDeps,
  onProgress?: (done: number, total: number, changed: number) => void,
  mode: SyncMode = 'merge',
): Promise<void> {
  const t0 = performance.now();
  const { app, docs, editor, push, lastServerVV, lastRemoteWrite, writingFromRemote, tag } = deps;

  // Build local file index (metadata only — no content reads yet).
  // Filter by isSyncablePath() at the source so every downstream stage
  // (overlapping, local-only, rename, create) inherits the policy instead
  // of re-checking it and occasionally forgetting.
  const localFiles = (app.vault.getMarkdownFiles() as TFile[]).filter((f) =>
    isSyncablePath(f.path),
  );
  const localFileMap = new Map<string, TFile>();
  for (const file of localFiles) {
    localFileMap.set(file.path, file);
  }

  // Snapshot the delete-journal BEFORE any reconcile — downstream filtering
  // uses this stable snapshot so that even if reconcilePendingDeletes() clears
  // an entry, we still don't re-download the path in this same run.
  //
  // Then resend all pending deletes (idempotent; reconcile-based semantics:
  // the journal is an intent list and only shrinks once the server's
  // doc_list view has confirmed the outcome — see reconcilePendingDeletes()).
  // WS FIFO per connection guarantees the server processes the resends
  // before answering the subsequent request_doc_list.
  const pendingDeleteSet = new Set(push.pendingDeletePaths());
  push.resendPendingDeletes();

  const { docs: serverDocs, tombstones } = await deps.requestDocList();
  const tombstoneSet = new Set(tombstones);
  const localPathSet = new Set(localFileMap.keys());
  const serverUuidSet = new Set(serverDocs.map((d) => d.doc_uuid));
  push.reconcilePendingDeletes(tombstoneSet, serverUuidSet);

  // Decode server VVs from binary to JSON strings for comparison
  const serverVVStrings = new Map<string, string>();
  const serverDocMap = new Map<string, DocEntry>();
  for (const d of serverDocs) {
    serverDocMap.set(d.doc_uuid, d);
    if (d.server_vv && d.server_vv.length > 0) {
      serverVVStrings.set(d.doc_uuid, new TextDecoder().decode(d.server_vv));
    }
  }

  // Load cached VVs from last successful sync
  const cachedVVs = await docs.loadVVCache();

  deps.trace('initial-sync.start', {
    serverDocs: serverDocs.length,
    localFiles: localFiles.length,
    tombstones: tombstones.length,
    hasCachedVVs: cachedVVs !== null,
  });
  log(`${tag} initialSync start`, {
    serverDocs: serverDocs.length,
    localFiles: localFiles.length,
    tombstones,
    hasCachedVVs: cachedVVs !== null,
  });

  // 1. Server-only docs — request delta (no local VV).
  // isSyncablePath() filters untrusted server entries (`.obsidian/*`, etc).
  // pendingDeleteSet prevents resurrection of locally-deleted paths even if
  // the server hasn't yet processed our just-flushed delete message.
  const serverOnlyUuids = [...serverDocMap.keys()].filter(
    (uuid) =>
      !tombstoneSet.has(uuid) &&
      !localPathSet.has(uuid) &&
      !pendingDeleteSet.has(uuid) &&
      isSyncablePath(uuid),
  );
  const overlappingFiles = localFiles.filter(
    (f) =>
      !tombstoneSet.has(f.path) &&
      !pendingDeleteSet.has(f.path) &&
      serverDocMap.has(f.path),
  );
  const localOnlyFiles = localFiles.filter(
    (f) =>
      !tombstoneSet.has(f.path) &&
      !pendingDeleteSet.has(f.path) &&
      !serverDocMap.has(f.path),
  );
  deps.trace('initial-sync.partition', {
    serverOnly: serverOnlyUuids.length,
    overlapping: overlappingFiles.length,
    localOnly: localOnlyFiles.length,
  });
  const totalSteps = serverOnlyUuids.length + overlappingFiles.length + localOnlyFiles.length;
  let stepsDone = 0;
  let changed = 0;
  const contentHashes = new Map<string, number>();
  const syncedPaths = new Set<string>();

  // The VV cache is only a valid fast-path if its hash reflects the FINAL
  // local content after download/merge/adopt. Pre-sync local text is often
  // stale on the exact runs we care about here (fresh pull, remote catch-up,
  // active-editor merge), so callers must refresh the hash after every full
  // sync path before we persist vv-cache.json.
  const rememberCurrentDocHash = async (path: string): Promise<void> => {
    const doc = await docs.getOrLoad(path);
    contentHashes.set(path, fnv1aHash(doc.get_text()));
  };

  // Priority sync: sync the currently active editor doc FIRST so the user
  // can start typing immediately.
  const activeDoc = editor.getActiveEditorPath();
  if (activeDoc) deps.observePath(activeDoc);
  if (activeDoc && serverDocMap.has(activeDoc) && localFileMap.has(activeDoc)) {
    const file = localFileMap.get(activeDoc)!;
    deps.tracePath('initial-sync.priority.begin', activeDoc);
    const localContent = await readEffectiveLocalContent(app, editor, file);
    await syncOverlappingDoc(deps, activeDoc, localContent, serverDocMap);
    await rememberCurrentDocHash(activeDoc);
    syncedPaths.add(activeDoc);
    stepsDone++;
    changed++;
    onProgress?.(stepsDone, totalSteps, changed);
    deps.tracePath('initial-sync.priority.done', activeDoc, {
      elapsedMs: Number((performance.now() - t0).toFixed(0)),
    });
    console.info(`${tag} priority sync complete (${(performance.now() - t0).toFixed(0)}ms)`, { path: activeDoc });
  }

  let downloadOk = 0;
  let downloadFail = 0;
  if (mode !== 'push') {
    log(`${tag} downloading ${serverOnlyUuids.length} server-only docs (parallel=${PARALLEL_DOWNLOADS})`);
    let wsAbortError: Error | null = null;
    const downloadOne = async (uuid: string): Promise<void> => {
      const existing = await docs.getOrLoad(uuid);
      if (existing.version() > 0) {
        downloadOk++;
        stepsDone++;
        onProgress?.(stepsDone, totalSteps, changed);
        return;
      }

      try {
        const result = await deps.requestSyncStart(uuid, null);
        if (result) {
          const doc = await docs.getOrLoad(uuid);
          doc.import_snapshot(result.delta);
          lastServerVV.set(uuid, result.serverVV);
          const serverText = doc.get_text();
          contentHashes.set(uuid, fnv1aHash(serverText));
          await editor.writeToVault(uuid, serverText);
          await docs.persist(uuid);
          downloadOk++;
          changed++;
        }
      } catch (err) {
        downloadFail++;
        warn(`${tag} download failed for ${uuid}:`, err);
        if (!deps.ws || deps.ws.readyState !== WebSocket.OPEN) {
          wsAbortError = err as Error;
        }
      }
      stepsDone++;
      onProgress?.(stepsDone, totalSteps, changed);
    };

    const inFlight = new Set<Promise<void>>();
    for (const uuid of serverOnlyUuids) {
      if (wsAbortError) break;
      const p = downloadOne(uuid).then(() => { inFlight.delete(p); });
      inFlight.add(p);
      if (inFlight.size >= PARALLEL_DOWNLOADS) {
        await Promise.race(inFlight);
      }
    }
    await Promise.all(inFlight);

    if (wsAbortError) {
      warn(`${tag} WS closed during download, aborting (${downloadOk} ok, ${downloadFail} fail)`);
      throw wsAbortError;
    }
  } else {
    stepsDone += serverOnlyUuids.length;
    onProgress?.(stepsDone, totalSteps, changed);
  }
  deps.trace('initial-sync.downloads.done', {
    ok: downloadOk,
    fail: downloadFail,
    total: serverOnlyUuids.length,
    elapsedMs: Number((performance.now() - t0).toFixed(0)),
  });
  console.info(`${tag} downloads done (${(performance.now() - t0).toFixed(0)}ms): ${downloadOk} ok, ${downloadFail} fail of ${serverOnlyUuids.length}`);

  // 2. Overlapping docs — two-tier skip: VV+hash → full sync
  let skippedVVMatch = 0;

  for (const file of overlappingFiles) {
    if (syncedPaths.has(file.path)) { stepsDone++; onProgress?.(stepsDone, totalSteps, changed); continue; }
    const currentServerVV = serverVVStrings.get(file.path);
    const cached = cachedVVs?.get(file.path);

    if (cached && currentServerVV && vvEquals(currentServerVV, cached.vv)) {
      // VV matches — but verify local content hasn't changed externally
      // (git pull, Syncthing, manual edit while Obsidian was closed) OR
      // in an open editor with unsaved keystrokes.
      const effective = await readEffectiveLocalContent(app, editor, file);
      const effectiveHash = fnv1aHash(effective);
      contentHashes.set(file.path, effectiveHash);

      if (effectiveHash === cached.contentHash) {
        deps.tracePath('initial-sync.vv-hash-skip', file.path, { effectiveHash });
        lastServerVV.set(file.path, currentServerVV);
        skippedVVMatch++;
        stepsDone++;
        onProgress?.(stepsDone, totalSteps, changed);
        continue;
      }
      // Local content changed (disk or editor) — fall through to full sync
      deps.tracePath('initial-sync.overlap-sync', file.path, {
        reason: 'hash-mismatch',
        effectiveHash,
        cachedHash: cached.contentHash,
      });
      await syncOverlappingDoc(deps, file.path, effective, serverDocMap);
      await rememberCurrentDocHash(file.path);
      changed++;
      stepsDone++;
      onProgress?.(stepsDone, totalSteps, changed);
      continue;
    }

    const localContent = await readEffectiveLocalContent(app, editor, file);
    deps.tracePath('initial-sync.overlap-sync', file.path, {
      reason: cached ? 'vv-mismatch' : 'no-cache',
      localLen: localContent.length,
    });
    await syncOverlappingDoc(deps, file.path, localContent, serverDocMap);
    await rememberCurrentDocHash(file.path);
    stepsDone++;
    onProgress?.(stepsDone, totalSteps, changed);
  }

  deps.trace('initial-sync.overlapping.done', {
    skippedVVMatch,
    synced: overlappingFiles.length - skippedVVMatch,
    elapsedMs: Number((performance.now() - t0).toFixed(0)),
  });
  console.info(`${tag} overlapping done (${(performance.now() - t0).toFixed(0)}ms): ${skippedVVMatch} skipped (VV match), ${overlappingFiles.length - skippedVVMatch} synced`);

  // 3. Local-only docs — push full snapshot via doc_create (skip in pull mode)
  if (mode !== 'pull') {
    for (const file of localOnlyFiles) {
      const content = await readEffectiveLocalContent(app, editor, file);
      contentHashes.set(file.path, fnv1aHash(content));
      log(`${tag} local-only push`, { path: file.path, contentLen: content.length });
      const doc = await docs.getOrLoad(file.path);
      doc.sync_from_disk(content);
      push.pushDocCreate(file.path, doc);
      await docs.persist(file.path);
      changed++;
      stepsDone++;
      onProgress?.(stepsDone, totalSteps, changed);
    }
  } else {
    stepsDone += localOnlyFiles.length;
    onProgress?.(stepsDone, totalSteps, changed);
  }

  // 4. Offline deletes were already flushed above, before any downloads.

  // 5. Tombstones — trash local files (skip if server also has the doc — create-after-delete)
  for (const uuid of tombstoneSet) {
    if (serverDocMap.has(uuid)) continue;
    if (!isSyncablePath(uuid)) continue;
    const f = app.vault.getAbstractFileByPath(uuid);
    if (f instanceof TFile) {
      writingFromRemote.add(uuid);
      try {
        await app.vault.trash(f, true);
      } finally {
        setTimeout(() => writingFromRemote.delete(uuid), 500);
      }
    }
  }

  // 6. Persist VV cache with content hashes for next startup
  const vvCacheEntries = new Map<string, VVCacheEntry>();
  for (const [path, vv] of lastServerVV) {
    vvCacheEntries.set(path, { vv, contentHash: contentHashes.get(path) ?? 0 });
  }
  await docs.saveVVCache(vvCacheEntries);

  // 7. Clean orphaned .loro files (deleted/renamed docs, old encoding)
  const validPaths = new Set<string>([...localPathSet, ...serverDocMap.keys()]);
  const orphansRemoved = await docs.cleanOrphans(validPaths);
  if (orphansRemoved > 0) {
    log(`${tag} cleaned ${orphansRemoved} orphaned state files`);
  }

  deps.trace('initial-sync.complete', {
    elapsedMs: Number((performance.now() - t0).toFixed(0)),
  });
  console.info(`${tag} initialSync complete (${(performance.now() - t0).toFixed(0)}ms)`);
}

/** Full sync for a single overlapping doc — conflict detection + merge + push. */
async function syncOverlappingDoc(
  deps: InitialSyncDeps,
  path: string,
  localContent: string,
  serverDocMap: Map<string, DocEntry>,
): Promise<void> {
  const { app, docs, editor, push, lastServerVV, lastRemoteWrite, tag } = deps;
  deps.tracePath('overlap.begin', path, { localLen: localContent.length });

  // Belt-and-suspenders: every caller is supposed to pass editor-aware
  // content (see readEffectiveLocalContent), but defensively re-read from
  // any open editor here too. Adopt-/conflict-decisions below MUST be made
  // against the freshest local text — disk content can be stale relative to
  // unsaved keystrokes in any open leaf.
  const freshEditorContent = editor.readCurrentContent(path);
  if (freshEditorContent !== null) {
    localContent = freshEditorContent;
  }

  const doc = await docs.getOrLoad(path);
  const hadPersistedState = doc.version() > 0;
  const editedDuringStartup = deps.wasEditedDuringStartup(path);
  deps.tracePath('overlap.doc-state', path, {
    hadPersistedState,
    version: doc.version(),
    editedDuringStartup,
  });

  // ── Phase 2: missing local CRDT state — adopt server, never merge ──────
  // Plaintext equality is NOT proof of causal equality. If the server has a
  // doc for this path and we don't, we MUST NOT run sync_from_disk(local) on
  // a fresh Loro doc — that synthesises a brand-new CRDT history that will
  // collide with the server's existing history at the next merge and can
  // double the document text. Instead: adopt the server snapshot wholesale.
  // If the local text differs, preserve the local copy in a conflict file
  // first (unless the local file is blank, in which case the server is
  // unambiguously the canonical version).
  if (!hadPersistedState) {
    const probe = await deps.requestSyncStart(path, null);
    if (probe && probe.delta.length > 0) {
      const tempDoc = createDocument(PROBE_DOC_UUID, PROBE_PEER_ID);
      tempDoc.import_snapshot(probe.delta);
      const serverText = tempDoc.get_text();

      const localIsBlank = localContent.trim() === '';
      const textsDiffer = serverText !== localContent;

      if (textsDiffer && !localIsBlank) {
        deps.tracePath('overlap.phase2-conflict', path, { serverLen: serverText.length, localLen: localContent.length });
        const cPath = conflictPath(app, path);
        warn(`${tag} state-loss conflict (missing local CRDT)`, { path, conflictPath: cPath });
        await app.vault.create(cPath, localContent);
      } else if (textsDiffer) {
        log(`${tag} state-loss adopt (empty local, server has content)`, { path });
      } else {
        log(`${tag} state-loss adopt (identical text)`, { path });
      }

      doc.import_snapshot(probe.delta);
      lastServerVV.set(path, probe.serverVV);
      if (textsDiffer) {
        deps.tracePath('overlap.phase2-write-to-vault', path, { textLen: serverText.length });
        await editor.writeToVault(path, serverText);
      }
      await docs.persist(path);
      return;
    }
    // Server has the path in doc_list but returned no delta (or doc_unknown).
    // This means there is nothing to adopt: either the server stub is empty,
    // or the path has just been deleted between doc_list and sync_start. The
    // synthetic-history risk that Phase 2 was added to prevent only matters
    // when the server has *real* CRDT content to clash with — an empty server
    // stub is safe to push the local content into. Fall through to the
    // normal local-create path (sync_from_disk + push delta).
  }

  // Detect external disk changes (edits outside Obsidian while it was closed).
  const hadLocalDiskChange = !doc.text_matches(localContent) && localContent.trim() !== '';

  // Sync local disk changes into CRDT before computing VV
  if (hadLocalDiskChange) {
    deps.tracePath('overlap.local-disk-change', path, { localLen: localContent.length });
    doc.sync_from_disk(localContent);
  }

  const clientVV = doc.export_vv_json();
  const result = await deps.requestSyncStart(path, clientVV);

  if (result) {
    // Concurrent external-edit conflict detection
    if (result.delta.length > 0 && hadLocalDiskChange) {
      const persistedSnapshot = await docs.loadPersistedSnapshot(path);
      const tempDoc = createDocument(PROBE_DOC_UUID, PROBE_PEER_ID);
      if (persistedSnapshot) tempDoc.import_snapshot(persistedSnapshot);
      tempDoc.import_snapshot(result.delta);
      const serverText = tempDoc.get_text();

      if (serverText.trim() !== '' && serverText !== localContent) {
        if (editedDuringStartup) {
          deps.tracePath('overlap.concurrent-live-editor-merge', path, {
            serverLen: serverText.length,
            localLen: localContent.length,
          });
        } else {
          deps.tracePath('overlap.concurrent-conflict', path, { serverLen: serverText.length, localLen: localContent.length });
          const cPath = conflictPath(app, path);
          warn(`${tag} concurrent external edit conflict`, { path, conflictPath: cPath });
          await app.vault.create(cPath, localContent);

          await docs.removeAndClean(path);
          const freshDoc = await docs.getOrLoad(path);
          const fullResult = await deps.requestSyncStart(path, null);
          if (fullResult && fullResult.delta.length > 0) {
            freshDoc.import_snapshot(fullResult.delta);
            lastServerVV.set(path, fullResult.serverVV);
          }
          deps.tracePath('overlap.concurrent-write-to-vault', path, { textLen: freshDoc.get_text().length });
          await editor.writeToVault(path, freshDoc.get_text());
          await docs.persist(path);
          return;
        }
      }
    }

    // ── Phase 3: disjoint VV — adopt server, never merge ────────────────
    // Plaintext equality may justify adoption, never causal merge. Two
    // independent CRDT histories with the same end text MUST NOT be merged
    // through Loro: Loro will treat the inserts as concurrent and concatenate
    // them, doubling the document. The previous "no fork when disjoint VVs
    // but same content" optimisation is the architectural root cause of the
    // 805-conflict-file storm in the richardsachen vault — see
    // gpt-audit/conflict-storm-plan.md.
    if (
      result.delta.length > 0 &&
      clientVV !== '{}' &&
      !hasSharedHistory(clientVV, result.serverVV)
    ) {
      const tempDoc = createDocument(PROBE_DOC_UUID, PROBE_PEER_ID);
      tempDoc.import_snapshot(result.delta);
      const serverText = tempDoc.get_text();

      const textsDiffer = serverText !== localContent;
      if (textsDiffer && localContent.trim() !== '') {
        deps.tracePath('overlap.phase3-conflict', path, { serverLen: serverText.length, localLen: localContent.length });
        const cPath = conflictPath(app, path);
        warn(`${tag} disjoint VV conflict`, { path, conflictPath: cPath });
        await app.vault.create(cPath, localContent);
      } else if (textsDiffer) {
        log(`${tag} disjoint VV adopt (blank local)`, { path });
      } else {
        log(`${tag} disjoint VV adopt (identical text)`, { path });
      }

      // Discard the disjoint local CRDT history entirely and replace it with
      // a fresh doc seeded from the server snapshot. removeAndClean drops
      // both the in-memory doc and the persisted .loro file.
      await docs.removeAndClean(path);
      const freshDoc = await docs.getOrLoad(path);
      freshDoc.import_snapshot(result.delta);
      lastServerVV.set(path, result.serverVV);
      if (textsDiffer) {
        deps.tracePath('overlap.phase3-write-to-vault', path, { textLen: serverText.length });
        await editor.writeToVault(path, serverText);
      }
      await docs.persist(path);
      return;
    }

    // For the active editor doc: flush pending keystrokes into the CRDT
    // before merging so import_and_diff produces a correct surgical diff.
    const isActiveEditorDoc = editor.getActiveEditorPath() === path;
    deps.tracePath('overlap.editor-mode', path, { isActiveEditorDoc });
    if (isActiveEditorDoc && result && result.delta.length > 0) {
      await push.flushPendingEdits(path);
    }

    // Import server delta — for active editor doc, use import_and_diff
    // to get a surgical TextDelta instead of a full editor replacement.
    let diffJson: string | null = null;
    if (result.delta.length > 0) {
      if (isActiveEditorDoc) {
        try {
          diffJson = doc.import_and_diff(result.delta);
        } catch (err) {
          warn(`${tag} import_and_diff failed, falling back to import_snapshot`, { path, err });
          doc.import_snapshot(result.delta);
        }
      } else {
        doc.import_snapshot(result.delta);
      }
    }
    lastServerVV.set(path, result.serverVV);

    const serverContent = doc.get_text();

    if (localContent.trim() === '' && serverContent.trim() !== '' && !isActiveEditorDoc) {
      deps.tracePath('overlap.empty-local-write-to-vault', path, { textLen: serverContent.length });
      log(`${tag} overlapping: empty local, adopting server`, { path });
      await editor.writeToVault(path, serverContent);
    } else {
      const clientVVAfterMerge = doc.export_vv_json();
      if (!vvCovers(result.serverVV, clientVVAfterMerge)) {
        const delta = doc.export_delta_since_vv_json(result.serverVV);
        if (delta.length > 0) {
          log(`${tag} overlapping push delta (VV gap)`, { path, deltaLen: delta.length });
          deps.send({
            type: 'sync_push',
            doc_uuid: path,
            delta,
            peer_id: deps.peerId,
          });
        }
      } else {
        log(`${tag} overlapping match`, { path });
      }

      // Apply merged content — active editor gets surgical diff, others get full replace
      if (isActiveEditorDoc) {
        const currentEditorContent = editor.readCurrentContent(path);
        const editorAlreadyMatches =
          currentEditorContent !== null && doc.text_matches(currentEditorContent);

        if (editorAlreadyMatches) {
          deps.tracePath('overlap.active-persist-disk', path, { textLen: serverContent.length });
          await editor.writeToVault(path, serverContent);
        } else if (diffJson) {
          let hasTextChanges = false;
          try {
            const ops = JSON.parse(diffJson);
            hasTextChanges = Array.isArray(ops) && ops.some(
              (op: { insert?: string; delete?: number }) => op.insert !== undefined || op.delete !== undefined
            );
          } catch { /* empty */ }

          if (hasTextChanges) {
            if (editor.applyDiffToEditor(path, diffJson, serverContent, true)) {
              deps.tracePath('overlap.apply-diff', path, { textLen: serverContent.length });
              const postApplyContent = editor.readCurrentContent(path);
              if (postApplyContent !== null && !doc.text_matches(postApplyContent)) {
                doc.sync_from_disk(postApplyContent);
              }
              lastRemoteWrite.set(path, postApplyContent ?? serverContent);
            } else {
              deps.tracePath('overlap.apply-diff-fallback-write', path, { textLen: serverContent.length });
              await editor.writeToVault(path, serverContent);
            }
          } else {
            deps.tracePath('overlap.active-persist-disk', path, { textLen: serverContent.length, reason: 'empty-diff' });
            await editor.writeToVault(path, serverContent);
          }
        } else if (result.delta.length > 0) {
          deps.tracePath('overlap.active-write-to-vault', path, { textLen: serverContent.length });
          await editor.writeToVault(path, serverContent);
        }
      } else if (localContent !== serverContent) {
        deps.tracePath('overlap.write-to-vault', path, { textLen: serverContent.length });
        await editor.writeToVault(path, serverContent);
      }
    }
  }
  await docs.persist(path);
}
