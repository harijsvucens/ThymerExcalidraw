# ThymerExcalidraw Changelog

## 0.6.5 — 2026-07-01

### Fixed (permanent save-block after legitimate deletion)

- **Root cause.** The v0.6.2 `_flushPanelSession` guard (lines ~5823–5832) compared `pendingCount` against `_dbSceneElementCount` with no deletion tracking. After a real deletion, the count dropped below the floor, the guard refused the save, and the floor was never ratcheted down — so every subsequent `onChange` also refused. The plugin fell into a permanent save-block: the user could delete elements but the DB never reflected it, and on panel reopen the deleted elements reappeared.

- **Fix (v0.6.5): Ratchet floor on legitimate deletions.** In the `onChange` handler, after computing `explicitDeletionCount` from the id-diff, if the entire drop is explained by deletions (`unexplainedDrop <= explicitDeletionCount`), ratchet `_dbSceneElementCount` down to the current live count. This ensures `_flushPanelSession` sees a realistic floor on the next save attempt.

- **Fix (v0.6.3): Real deletion detection replaces dead `appState.deletedIds` check.** The old `emptyOverPopulated` guard checked `appState?.deletedIds` — but Excalidraw's real AppState has no `deletedIds` field; deletions surface as `isDeleted: true` entries inside `elements`. The check always returned truthy (vacuously), so the guard never excused a legitimate delete. Replaced with an id-diff heuristic (`_lastSeenLiveIds` vs `currentLiveIds`) that matches the broadcast code's (`_broadcastElementDelta`, line 5490–5494) production-proven approach.

- **Fix (v0.6.3): DB-aware guard now runs perpetually.** The v0.6.2 guard was gated on `_hadNonEmptyInitialData !== true`, which disabled it for the rest of the session after the first healthy load. Changed to a running floor updated after every successful load, reload, WS merge, and save — the guard stays meaningful for the life of the session.

- **Fix (v0.6.3): Legacy-row empty-override in `_pickNewerDoc`.** `_pickNewerDoc` uses a pure `updatedAt` comparison with no content awareness. A stale/empty legacy Plugin Backend row (`fromRow`) with a newer `updatedAt` than the real Excalidrawings collection record could win the cascade and blank the canvas — the same mechanism v0.6.2 fixed for localStorage, but sourced from `fromRow`. Added the same content-aware override.

- **Fix (v0.6.3): Ratchet floor after WS merge.** After `_mergeSceneElements` applies a remote delta, `_dbSceneElementCount` and `_lastSeenLiveIds` are updated to match the merged state. Without this, a legitimate remote deletion from another tab left the floor at its old higher value, and the local tab's next `onChange` would see an "unexplained" drop.

- **UX: Version tag in status bar.** Added a small `v0.6.5` tag in the panel status bar for easy version identification without opening the browser console.

- Probe line: `explicitDeletionCount=N unexplainedDrop=M dbAwareBlocked=...` in onChange handler.

## 0.6.2 — 2026-07-01

### Fixed (stale localStorage could override populated DB; partial-scene save via WS could overwrite populated DB)

- **Root cause (v0.6.2).** Even after the v0.6.1 mount-echo fix
  prevented NEW empty scenes from being written, existing stale
  empty localStorage entries from pre-v0.6.1 bleaches could still
  override the DB on load. The `_pickNewerDoc` function compared
  only `updatedAt` timestamps — a newer empty localStorage entry
  would win over an older populated DB entry. Symptom: "Open
  Excalidraw on instance A → blank canvas. Move objects on
  instance B → they appear on A." The WS subscription is keyed
  on the source record GUID, so A received B's WS deltas even
  when A's load returned empty from poisoned localStorage.
- **Fix 1: Content-aware merge.** In `_loadDrawingDoc`, if the DB
  has non-empty elements and localStorage is empty, the DB wins
  regardless of `updatedAt`. Prevents stale localStorage from
  blanking the canvas on load.
- **Fix 2: Heal poisoned localStorage.** After a successful load
  from the DB, write the DB doc back to localStorage. Clears
  stale empty entries for future loads.
- **Fix 3: Block WS deltas when load failed.** In
  `_handleIncomingWsMessage`, if `session.drawingRecordGuid` is
  null (load failed or returned empty), skip the delta and trigger
  `_reloadDrawingDoc` instead. Prevents partial-scene accumulation
  on a blank canvas.
- **Fix 4: DB-aware save guard (Layer 4).** In the onChange handler
  and `_flushPanelSession`, compare the live element count against
  `_dbSceneElementCount` (tracked from the DB at load time). If
  the live scene has fewer elements and no explicit deletions,
  refuse the save. This is the strongest data-loss prevention —
  even if the load returns empty but WS deltas arrive, a partial
  scene can never overwrite the populated DB.
- **Fix 5: WS filter also matches `drawingRecordGuid`.** The WS
  message filter now checks both `session.recordGuid` and
  `session.drawingRecordGuid`, ensuring cross-tab sync arrives
  even when the source-record filter would not cover it.
- Added `_countDocNonDeleted(doc)` helper and `_reloadDrawingDoc`
  method. New session field `_dbSceneElementCount`.
- Added DEBUG.md §5.14 documenting the localStorage poisoning
  gotcha and all five fixes.
- Tests: T11 (localStorage poisoning), T12 (cross-tab partial-save
  guard), T13 (DB-wins reconciliation), T14 (load fail + WS delta).

## 0.6.1 — 2026-07-01

### Fixed (panel-open could overwrite populated drawing with empty scene)

- **Root cause.** When a user opened an Excalidraw panel for a note
  that already had drawing data, the plugin's autosave sometimes
  wrote `elements:[]` to both the database and the localStorage
  mirror, blanking out the user's real work. Symptom reported
  2026-07-01: opened the "Wed Jul 1 · Excalidrawing" record, the
  saved scene had `updatedAt: 2026-07-01T14:34:02.885Z` with
  zero elements, even though the user had been drawing on it.
  Data was only restored because Firefox still had a stale
  localStorage mirror from an earlier session.
- **Why the existing 500ms echo guard didn't catch it.** The
  onChange handler computes
  `echoSuppressed = session.applyingRemoteUpdate
    || (Date.now() - (session.lastRemoteApplyMs || 0) < EXCAL_ECHO_GUARD_MS)`.
  `lastRemoteApplyMs` was initialised to `0` in
  `_openDrawingPanelWithSession`, so at mount
  `Date.now() - 0` is a huge number — not `< 500`. The guard
  only ever fired for echoes of *remote* updates, never for
  Excalidraw's own initial-mount onChange. **Fix (Layer 1):**
  seed `lastRemoteApplyMs: Date.now()` in the session init.
- **Excalidraw's first onChange events fire with empty
  `elements`**, before `initialData` is applied. The probe in
  `tests/baseline/T1T3-baseline.json` shows the pattern:
  `DIAG: onChange 0 els, applyingRemote=false echoSuppressed=false`
  fires 4 times in a row at the start of every test, then the
  loaded scene arrives. The 500ms guard expires (e.g. on slow
  CDN loads) and the autosave writes the empty scene.
  **Fix (Layer 2):** snapshot the loaded scene's id signature
  (`length + sorted ids` via `_excalSceneSignature`) after
  `_buildInitialData`; in the onChange handler, skip the save
  if the new scene's signature matches.
- **Belt-and-suspenders (Layer 3).** Even with Layers 1+2, a
  regression could let an empty scene reach `pendingScene`.
  When `_hadNonEmptyInitialData === true` and the live scene
  has 0 elements with no deletion IDs, refuse the save
  unconditionally. The same guard is mirrored in
  `_flushPanelSession` so the pagehide / visibilitychange /
  panel-closed force-flush paths can't bypass it either.
- New helpers at module level:
  - `_excalSceneSignature(elements)` — stable hash for echo
    detection.
  - `_excalSerializedElementCount(pendingScene)` — counts
    non-deleted elements in either the v3 `{ sceneJson: ... }`
    shape or the fallback `{ elements, appState, files }` shape.
    Returns `-1` when the count can't be determined (treated as
    "not empty" so we never silently drop a real save).
- New session fields (initialised in `_openDrawingPanelWithSession`):
  - `_hadNonEmptyInitialData: boolean` — true iff the loaded
    scene had at least one non-deleted element.
  - `_initialSceneSignature: string|null` — see Layer 2.
- Bumped `EXCAL_VERSION` to `0.6.1` and `plugin.json` version
  to `0.6.1`.

### Live verification (browser-driven, fresh Chrome Dev Test6)

- Reverted Wed Jul 1's `1JC9C44WQDVD19JFXBM8PYQJ74` to its
  populated state (10 elements, `updatedAt:
  2026-07-01T14:39:33.724Z`).
- Opened the source note "Wed Jul 1"
  (`S-16S1WSXAWSHVHJZ72G6J3JRTCP-P000000000-0-20260701`) in
  Harry's workspace (`W6CDWK9CQRRWPJV2K5SM9YSW6P`).
- Command palette → "Excalidraw: Open drawing for this note"
  → panel mounted, 3-second wait with no user input, closed
  panel.
- Post-test `thymer_get_record` on `1JC9C44WQDVD19JFXBM8PYQJ74`:
  `elements.length` still 10, `updatedAt` unchanged. The page
  console showed the new probe line
  `DIAG: onChange N els, ... echoSuppressed=true mountEcho=...`
  for the initial-mount onChange events (echo guard now
  firing), and zero `DIAG: empty-over-populated save REFUSED`
  warnings (the live scene was non-empty throughout).
- New regression test `tests/sync/T10-mount-echo.mjs`:
  asserts the same property. Pre-v0.6.1 the test would have
  failed (the DB would have flipped to empty); post-v0.6.1
  the test passes.
- Re-ran `tests/sync/T9-close-reopen.mjs` and
  `T1T3-baseline.mjs`: no regression. The pagehide flush
  still saves real edits (the freedraw baseline test draws,
  closes, reopens, and reads back the full geometry).

### Diagnostic

- The `EXCAL_VERSION` log line in the page console now shows
  `0.6.1`. A stale service-worker cache or wrong workspace
  would show `0.6.0` or earlier — re-check `THYMER_WS_GUID`
  and hot-reload.
- The mount-echo guard's onChange probe line now includes
  `mountEcho=...` and `emptyOverPopulated=...` fields. A
  cluster of `mountEcho=true` lines at panel-open is normal
  (Excalidraw's first-wave onChange events). An
  `emptyOverPopulated=true` line is a *bug* — it would mean
  the autosave tried to blank out populated data.

## 0.6.0 — 2026-06-30

### Added (Show Data button in Excalidraw panel)

- **"Show Data" button** (`📋`) in the top-right corner of the Excalidraw editor panel.
  When clicked, opens the raw drawing record in a new panel where Thymer's version
  history is accessible. The Excalidraw panel stays open alongside it.
- **`_skipInterceptForGuid` guard** in `_refreshPanelChrome`. When the button navigates
  to the drawing record, a skip flag prevents the auto-intercept from redirecting
  back to the source note, so the raw record data view persists.
- Bumped `EXCAL_VERSION` to `0.6.0` and `plugin.json` version to `0.6.0`.

## 0.5.9 — 2026-06-30

### Fixed (close-Tymer-quickly loses unsaved changes)

- **Page-hide flush.** The autosave debounce was 1.5s. If the user
  closed Thymer within 1.5s of drawing, the change was in
  `pendingScene` only — never reached the DB, never reached
  localStorage. On reopen the canvas came back blank. Symptom:
  "draw, close, reopen → blank" with quick close, but a normal wait
  worked.
  - Added `_installPageHideFlush()` in `onLoad()` (plugin.js:3653).
    Installs `pagehide`, `beforeunload`, and `visibilitychange` (on
    `hidden` only) listeners that call `_flushPanelSession(true)`.
  - The `panel.closed` event only fires for the panel close, not for
    the whole page/app going away — these new listeners cover tab
    close, window close, and tab backgrounding.
  - The flush is idempotent: `_flushPanelSession` has a
    `saveInFlight` re-entrancy guard, so overlapping pagehide /
    beforeunload / visibilitychange fires are no-ops.
- **localStorage write moved before the DB write in
  `_saveDrawingDoc` (plugin.js:5008).** The DB write is `await`ed
  and may not complete if the page unloads mid-save. The
  localStorage mirror write is sync — by doing it FIRST, even a
  mid-save page close leaves the mirror updated. `_loadDrawingDoc`'s
  `_pickNewerDoc` merge already prefers the newer mirror on reload,
  so this closes the gap for the DB write that didn't land.
- **Autosave debounce floor lowered** from 800ms to 200ms, default
  from 1500ms to 400ms (plugin.json `custom.autosaveMs`, plugin.js
  `_autosaveMs` init at line 2579). The save is cheap (one prop set
  + one localStorage write); 400ms is short enough that the pagehide
  flush rarely has to fight a long gap, and short enough that "wait
  for Changes saved" feels snappy.

### Diagnostic

- Bumped `EXCAL_VERSION` to `0.5.9` and `plugin.json` version to
  `0.5.9`. The canary `EXCAL_VERSION` line in the page console now
  distinguishes v0.5.9 from earlier builds.

### Live verification (Playwright, Chrome Dev Test profile)

- `tests/sync/T9-close-reopen.mjs`:
  - **Phase 1 + 2 (wait-for-autosave round-trip):** drew 1 freedraw
    on "Notes" record (`1J9YG6E4KYZ9JRATQ9SM0479AT`), waited 2.5s for
    autosave, opened a fresh page, opened the same Excalidraw panel.
    In-memory count matched (2 == 2). Pre-v0.5.9 same flow had
    `phase1_afterMem_count > phase2_reopen_count` when the user
    closed too fast. Post-v0.5.9: `pass: true`.
  - **Phase 3 (quick-close regression test, NEW):** drew 1 freedraw,
    called `page.close()` IMMEDIATELY without waiting for the
    autosave debounce, opened a fresh page. Post-v0.5.9: the
    new freedraw was preserved (`beforeQuickCount: 2 →
    afterQuickCount: 3`). The pagehide listener force-flushed the
    pending scene before the page unloads. Pre-v0.5.9 same flow
    lost the change.

## 0.5.8 — 2026-06-30

### Fixed (fresh-load shows blank canvas — root cause)

- **`_buildInitialData` could not parse the v3 save format.**
  `_serializeScene` (React mount) produces
  `{ sceneJson: "<JSON string>" }` and `_saveDrawingDoc` wraps it
  as `{ v:3, scene: { sceneJson: "..." } }`. But `_buildInitialData`
  only checked `doc.sceneJson` (top-level, legacy flat format) and
  `doc.scene.elements` (direct array, fallback when
  `serializeAsJSON` is unavailable). The actual v3 structure
  stores the elements inside `doc.scene.sceneJson` (a nested JSON
  string) — **neither branch handled it**. Result: the function
  returned `null` on every load, Excalidraw started with an empty
  canvas, and `elementCount` was 0. The v0.5.7 "multi-collection
  search" / `excalidrawing` fallback was solving the wrong
  problem — the drawing record *was* being found (the
  `source_note` cross-ref matched), the scene was just never
  parsed. **Fix:** added a third branch in `_buildInitialData`
  that parses `doc.scene.sceneJson` through `lib.restore()` and
  returns the restored elements. The same blind spot existed in
  `_sceneDocHasContent` (status bar would show "Ready" instead of
  "Loaded"); added the corresponding `doc.scene?.sceneJson`
  check there too. Verified live: opening source note "index"
  now shows the ellipse stored in the database
  (`elementCount: 1`), and drawing a second shape + reload
  shows both shapes.

### Fixed (secondary defects found during the v0.5.8 trace)

- **`_isDrawingsCollection` was undefined.** Line 3437 called
  `this._isDrawingsCollection(c)` inside `_getAllDrawingsCollections`,
  but the method that actually exists is
  `_collectionLooksLikeDrawings(c)` (line 2702). The `try/catch`
  silently swallowed the `TypeError`, so the "search ALL
  Excalidrawings collections" enhancement was dead code —
  `_getAllDrawingsCollections` returned only the primary
  collection from `_ensureDrawingsCollection()`. **Fix:**
  renamed the call to the existing method.
- **Cache-null re-query.** `_findDrawingRecordBySourceGuid`
  returned `null` immediately if `_drawingRecordCache.get(sourceGuid)`
  was a cached `null` from a prior failed call, so a transient
  failure could permanently poison the cache. **Fix:** only
  return early on a truthy cache hit; a cached `null` falls
  through to a fresh search.
- **Backwards `excalidrawing` matcher removed.** The
  v0.5.7-era matcher checked
  `r.reference('excalidrawing') === sourceGuid` on the
  drawing record itself, but the `excalidrawing` field on
  the `Excalidrawings` collection is self-referential
  (`filter_colguid` points to itself), not source-pointing.
  The matcher could never match and added noise. Removed.

### Live verification (browser-driven, fresh Chrome Dev Test6)

- Opened source note "index" in Thymer-Cabinet sync
  (`WKXP9WA3F5TCTMV5PS747QVV8H`) via the command palette
  (Ctrl+P → "Excalidraw: Open drawing for this note").
  Pre-v0.5.8: `elementCount: 0`, blank canvas.
  Post-v0.5.8: `elementCount: 1`, the ellipse stored in
  the database is rendered.
- Injected a rectangle via `updateScene` API; the save
  path fired (`prop().set()` awaited), the DB scene field
  was updated with the new element, status bar showed
  "Changes saved".
- Full page reload (Ctrl+Shift+R after unregistering the
  service worker and clearing caches) → reopened the
  panel → `elementCount: 1` (the rectangle, loaded from
  the DB). End-to-end round-trip confirmed.
- Bug 5 (DB save stale handle) turned out to be the same
  bug from the other direction: the scene *was* being
  written to the DB, but it was being loaded back as
  `null` on every read, so the user perceived it as
  "nothing saves". The v0.5.8 parse fix resolves both
  symptoms.

### Diagnostic

- Bumped `EXCAL_VERSION` to `0.5.8` and `plugin.json` version
  to `0.5.8`. The canary `EXCAL_VERSION` line in the page
  console now distinguishes v0.5.8 from earlier builds; a stale
  service-worker cache will show `0.5.7` or earlier.

## 0.5.7 — 2026-06-30

### Fixed (host context menu suppression)

- **Right-clicking inside the Excalidraw panel no longer opens
  Thymer's note-action context menu in addition to Excalidraw's
  own.** Today, the `contextmenu` event fired inside the canvas
  was caught by both Excalidraw's handler (correct) and by the
  host application's document-level listener (wrong — opens
  Thymer's Cut/Copy/Paste/Add-block menu inside the panel).
  Both menus ended up open at once, the top one occluded by
  the other depending on z-order. **Fix:** added
  `_installContextMenuGuard(shellEl, session)` (capture-phase
  listener on `.excal-panel-shell` that calls
  `e.stopPropagation()`). The capture-phase target is the
  shell — Excalidraw's own listener on the canvas still runs
  (it's downstream of the shell), and the host's listener on
  `document` never sees the event (it's upstream). The guard
  is installed only in the React mount path (not the
  excalidraw.com iframe fallback, where the inner menu is
  unreachable from the host anyway). Teardown is wired into
  `_teardownRealtimeListeners` so the listener is removed
  when the panel is closed. Verified live: in-panel
  right-click now opens **only** Excalidraw's menu; right-click
  outside the panel still opens Thymer's menu; after closing
  the panel the guard is gone (right-click the same area
  re-opens Thymer's menu). New gotcha 5.11 in `DEBUG.md`.

## 0.5.6 — 2026-06-30

### Fixed (shape sync)

- **Shapes (rectangle, ellipse, diamond) now sync between tabs.**
  The `isDegenerateFreedraw` filter (now renamed `isDegenerateElement`)
  only covered freedraws. Rectangle, ellipse, and diamond all
  report `width: 0, height: 0` between pointer-down and pointer-up,
  so the in-progress zero-size state was being broadcast as a real
  element. The receiving tab was left holding the dot. The new
  helper filters shapes with `w < 1 && h < 1` for `rectangle`,
  `ellipse`, `diamond`, `line`, and `arrow` — well below any
  human-drawn shape, but larger than the pointer-down state.
- **`lastBroadcastElements` clone widened to all array-valued
  fields.** The v0.5.5 fix cloned `points` (the freedraw trap).
  Shape elements additionally have `boundElements` and `groupIds`
  that Excalidraw mutates in place; cloning those too means the
  delta-filter snapshot is fully decoupled from the live
  Excalidraw state. `containerId` reference is also cloned for
  connected shapes.
- **`_serializeScene` uses the broader filter.** The save path
  now also drops in-progress shape states before writing
  `pendingScene`, so a mid-drag autosave can't persist a
  zero-size shape.

### Fixed (bidirectional move sync)

- **WS-receive and record-update re-seeds re-introduced the
  bug-3 in-place-mutation trap.** The v0.5.5 fix was applied
  only in `_broadcastElementDelta` (the WS-send path), but
  there are **four other places** that re-seed
  `session.lastBroadcastElements` from live `excalApi.getSceneElements()`:
  `_setupRealtimeListeners` (initial seed), `_handleIncomingWsMessage`
  (after applying a remote delta), `_handleRemoteRecordUpdated`
  (after applying a remote DB save), and `_handleReload` (after
  applying the local record at boot). All four stored the live
  element reference, so the next local `onChange` saw
  `prevEl.version === el.version` (same object) and the broadcast
  emitted an empty delta. A move on tab B after a draw on tab A
  was the visible symptom: tab B moved correctly, tab A stayed
  put. **Fix:** extracted `_cloneElementSnapshot(el)` (shallow
  clone plus `points` / `boundElements` / `groupIds` /
  `containerId`) and applied it to **all five re-seed sites**
  (the four above plus the existing broadcast-time store).
  Verified by 5 back-and-forth moves between two tabs, all
  positions matching exactly across both panes.

### Fixed (layer-order / z-order sync)

- **Layer order is the array order, but the WS delta didn't
  carry it.** Excalidraw uses the elements array order as the
  z-order (later = on top). When the user changes layer order
  on tab B (bring to front / send to back), the moved element's
  version bumps and goes into the delta, but the **array
  position** is not part of the delta. The receiver's
  `_mergeSceneElements` preserves local order and only updates
  the per-element data, so the layer change was dropped. The
  visible symptom: "the shape moves on tab B but stays in the
  same z-position on tab A". **Fix:** added a `sceneOrder: [...ids]`
  field to the WS broadcast (the full current array order, not
  just the delta), and on the receive side applied it when
  (a) the order actually differs from local and (b) at least
  one incoming element is newer than its local counterpart
  (so a stale broadcast can't override a fresher local
  reorder). The check uses the existing `version` /
  `versionNonce` LWW contract. Verified: changing z-order on
  either tab now propagates to the other in under 1 second.
  Combined move + reorder on a single element also syncs
  correctly (move bumps version, reorder moves the array
  position, both reach the receiver).

### Fixed (save await)

- **`_saveDrawingDoc` now awaits the prop setter.** The previous
  code did `drawingRecord.prop(...).set(sceneJson)` without
  awaiting the returned promise. In current Thymer versions the
  prop setter is asynchronous; without `await`, the save
  resolves before the DB write lands and a quick hard refresh
  can see the previous scene. With `await`, the save truly
  completes before `_flushPanelSession` clears `dirty`.

### Diagnostic

- Added an always-on log line
  `DIAG: skipped N degenerate (in-progress) element(s)` whenever
  the broadcast loop or save path filters an in-progress shape.
  Useful for spotting over-filtering in production (a non-zero
  count during a normal drawing session means the threshold is
  too aggressive).

### Known issues (out of scope for this release)

- The plugin's in-page `drawingRecord` handle can become stale
  after a page reload, at which point both `setName` and
  `prop().set()` silently no-op. The status bar still reports
  "Changes saved" because the await on the prop setter resolves
  with no error. MCP-side writes (e.g. via `thymer_update_record_property`)
  work fine — this is a plugin-side stale-handle issue, not a
  Thymer API issue. To be addressed in a follow-up.

### Live verification (browser-driven)

- Drew a rectangle, ellipse, and diamond on tab 1 of a two-tab
  setup. Tab 2 received all three with matching `id`, `type`,
  `x`, `y`, `width`, `height`, `version`, and `versionNonce`.
  Pre-fix: tab 2 received the in-progress zero-size state and
  rendered dots. Post-fix: tab 2 renders the actual shapes at
  their final positions and sizes.
- 5 back-and-forth moves between two tabs: tab 1 → tab 2 →
  tab 1 → tab 2 → tab 1. All 5 positions matched exactly
  across both panes (v=32, 33, 34, 35, 36). Pre-fix: every
  other move was dropped (the receiver stayed at the previous
  position with a stale version). Post-fix: every move
  propagates within 1 second.

## 0.5.5 — 2026-06-29

Sync / persistence fixes verified live against a fresh
drawing on the index record.

### Fixed (round 1: line→dot)

- **Line→dot save bug.** Drawing a freedraw with a mid-stroke pause
  longer than the 1.5s autosave no longer persists a degenerate
  1–5 point dot. The `isDegenerateFreedraw` filter that already
  ran at broadcast time now also runs in `_serializeScene`, so the
  save path strips partial freedraws before `pendingScene` is
  written to the database. The saved scene now matches the
  in-memory scene after a pause-and-resume stroke.
- **Echo guard widened to 500ms** and now also gates the save path
  (previously only the WebSocket broadcast). Excalidraw render
  commits can land >150ms apart during heavy edits; the wider
  window prevents an echo `onChange` from re-serialising and
  re-saving a just-applied remote update.
- **Anti-LWW force-apply block removed** from
  `_handleIncomingWsMessage`. The block was discarding local
  edits with a higher version and re-applying the older remote
  data (the opposite of last-write-wins). The merge is now a true
  LWW by `version` + `versionNonce`.
- **Duplicate `sceneJson` key removed** from the saved doc. The
  old code wrote both `doc.scene.sceneJson` and a top-level
  `doc.sceneJson` with the same value; the top-level key is gone.

### Fixed (round 2: two-tab divergence)

- **`lastBroadcastElements` now stores shallow clones.** The
  previous code stored *references* to the live Excalidraw
  elements, which are mutated in place. After the first broadcast
  set `prev` to the element at v=3, Excalidraw's next render
  bumped that same object to v=27, so every subsequent broadcast
  had `prevEl.version === el.version` and emitted an empty delta.
  The throttle (80ms) still fired, but the WS message had
  nothing to send, so the in-progress stroke on tab A never
  reached tab B — tab B was left holding the v=3 partial. The
  fix clones the element (and its `points` array) when storing
  in `lastBroadcastElements`, so the snapshot is decoupled from
  Excalidraw's live mutations and the delta is computed
  correctly.
- **Throttle callback now always broadcasts.** Previously the
  `setTimeout` only fired a broadcast if `wsPendingBroadcast`
  was set, so a single onChange could leave a pending flag that
  the timeout would consume once and then go silent. The
  callback now always calls `_broadcastElementDelta` with the
  latest scene; `_broadcastElementDelta` itself short-circuits
  if the delta is empty.

### Deployment

- Deployed via `npm run push` with
  `THYMER_WS_GUID=WKXP9WA3F5TCTMV5PS747QVV8H` (Harry's Workspace).
  Note: the deploy script's auto-discovered workspace may differ
  from the workspace the test Chrome is bound to. Set
  `THYMER_WS_GUID` explicitly when pushing for tests.

### Tests

- `tests/sync/T1T3-baseline.mjs` re-run from a blank scene.
  In-memory and saved scene now agree (26 + 41 points). Pre-fix
  baseline in `tests/baseline/BASELINE-line-dot.json` (5 + 2
  points) is now historical.
- `tests/sync/twotab-sync.mjs` opens the same drawing in two
  tabs of the same context, draws on tab A, and reads both.
  Pre-fix: tab B held `points: 2, v: 3` for the same element tab
  A drew as `points: 26, v: 27`. Post-fix: both tabs converge
  to `points: 26, v: 27` with `divergent: []`.

## 0.5.4 — pre-fix baseline

- `isDegenerateFreedraw` filter ran only at the WebSocket broadcast
  layer, not at the save layer. Mid-stroke pauses could persist a
  partial freedraw as a degenerate dot in the database.
- 150ms echo guard gated only the broadcast, not the save.
- Anti-LWW force-apply block was active.
- `lastBroadcastElements` stored element references, so the
  delta-filter snapshot drifted with Excalidraw's in-place
  mutations and two-tab sync diverged.
- Saved doc carried a redundant top-level `sceneJson` key.
