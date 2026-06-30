# ThymerExcalidraw — Project Context

> **Read this first if you are an agent picking up this plugin.**
>
> Captures the live state, architecture decisions, recent bug fixes, and
> gotchas discovered while building the v0.4.x–v0.5.x lines of this plugin.
>
> **Debugging this plugin** (probe pattern, MCP access, the
> eight gotchas that each cost an hour, worked-example debug of
> bug 3): see [DEBUG.md](DEBUG.md).
>
> **Live test harness** (CDP + `__excalDebug` + test recipes):
> see [TESTING.md](TESTING.md).
>
> **Current investigation state** (what's known vs. hypothesised,
> files touched, next steps): see [AGENT_NOTES.md](AGENT_NOTES.md).
>
> **Version history**: see [CHANGELOG.md](CHANGELOG.md).

---

## 1. Current state (post-v0.5.8 fix)

| What | Value |
|------|-------|
| Version | **0.5.8** (`EXCAL_VERSION` in `plugin.js:2429`, `plugin.json` line 5) |
| Plugin type | `AppPlugin` (global), not Collection plugin |
| Deployed to | Thymer-Cabinet sync (`WKXP9WA3F5TCTMV5PS747QVV8H`) — the test workspace. `npm run push` defaults to a different active workspace, so always set `THYMER_WS_GUID` explicitly when pushing for tests. |
| Excalidraw UMD | `0.17.6` pinned via `cdnVersion` in `plugin.json` |
| Workspace storage | Single canonical `Excalidrawings` collection per workspace (was 4 dupes — see §4) |

**Last meaningful change (v0.5.8):** Fixed the
"fresh load shows blank canvas — old shapes missing" bug (bug 9).
The actual break was in `_buildInitialData` / `_sceneDocHasContent`
(plugin.js:4605 / 4675), which could not parse the v3 save format
`{ v:3, scene: { sceneJson: "<JSON string>" } }`. The save path
uses `serializeAsJSON` which produces `{ sceneJson: "..." }`; the
load path only checked `doc.sceneJson` (top-level) and
`doc.scene.elements` (direct array), so the actual nested
`doc.scene.sceneJson` was never read. Result: `null` returned
on every load, Excalidraw started empty, `elementCount: 0`.
The v0.5.7 "multi-collection search" / `excalidrawing` fallback
was solving the wrong layer — the record *was* being found
via the `source_note` cross-ref, the scene just couldn't be
parsed. Also fixed three secondary defects uncovered during the
trace: the undefined `_isDrawingsCollection` typo at line 3437
(dead-code multi-collection search), the cache-null no-re-query
path in `_findDrawingRecordBySourceGuid` (transient failure
could permanently poison the cache), and the backwards
`excalidrawing` matcher on the drawing record (the field is
self-referential on the drawings collection, not
source-pointing). See `DEBUG.md` gotcha 5.12 for the full
diagnosis.

**Previous meaningful change (v0.5.7):** Fixed the
"right-clicking inside the Excalidraw panel opens Thymer's
note-action context menu in addition to Excalidraw's own"
bug. Excalidraw is mounted in-page (React root) inside
`.excal-panel-shell` → `.excal-panel-stage` → `.excal-host`
→ `<canvas>`. The `contextmenu` event from a right-click
bubbles from the canvas up to `document`, where Thymer's
host has a context-menu listener that opens the note-action
menu (Cut, Copy, Paste, Add block, etc.). Both menus ended
up open at once. The Thymer `events.on(...)` API exposes
`panel.navigated`, `panel.focused`, `panel.closed`,
`record.updated`, `reload` — no native `panel.contextmenu`
hook. **Fix:** added `_installContextMenuGuard(shellEl, session)`
that attaches a capture-phase `contextmenu` listener on
`.excal-panel-shell` calling `e.stopPropagation()`. Capture
phase is critical — it runs before the bubble reaches
`document`. Excalidraw's own canvas-level handler still runs
(downstream of the shell, sees the event). The host's
document-level handler does not (upstream, never sees it).
The guard is installed **only in the React mount path** —
the excalidraw.com iframe fallback has a different problem
(the iframe is a separate origin, the inner Excalidraw menu
is unreachable from the host page), so the guard is skipped
there. Teardown wired into `_teardownRealtimeListeners`.
Verified live: in-panel right-click now opens only
Excalidraw's menu; right-click outside the panel still opens
Thymer's menu; after closing the panel the guard is gone
(right-click the same area re-opens Thymer's menu).

**Last meaningful change (v0.5.6 round 3):** Fixed the
"layer order changes on tab B but not on tab A" bug. In
Excalidraw, the elements array order is the z-order (later =
on top). The WS delta carries only changed elements, not the
array position. The receiver's `_mergeSceneElements` preserved
local order and dropped the z-order change. Fix: added
`sceneOrder: [...ids]` to the WS broadcast (the full current
array order). On receive, if the order differs AND at least
one incoming element is newer than its local counterpart,
the merge reorders to match the sender. The "newer" check
uses the existing `version` / `versionNonce` LWW contract so
a stale broadcast can't override a fresher local reorder.
Verified: reorder on either tab propagates in <1s, and
move+reorder together syncs correctly.

**Last meaningful change (v0.5.6 round 2):** Fixed the
"tab A draws, tab B moves, tab A stays put" bidirectional bug.
The v0.5.5 clone fix was applied only in
`_broadcastElementDelta` (the WS-send path), but there were
**four other re-seed sites** that stored live element
references from `excalApi.getSceneElements()`:
`_setupRealtimeListeners` (initial), `_handleIncomingWsMessage`
(after applying remote delta), `_handleRemoteRecordUpdated`
(after applying remote DB save), `_handleReload` (after
applying local record at boot). All four reintroduced the
bug-3 in-place-mutation trap. The move on tab B would compute
delta from a snapshot that followed Excalidraw's live
mutations, see `prevEl.version === el.version`, and emit an
empty delta. Fix: extracted `_cloneElementSnapshot(el)` and
applied it to **all five re-seed sites** (the four above plus
the existing broadcast-time store). Verified live: 5
back-and-forth moves between two tabs, all positions matching
exactly (v=32, 33, 34, 35, 36).

**Last meaningful change (v0.5.6 round 1):** Fixed the two-tab
shape sync (rectangle/ellipse/diamond). The
`isDegenerateFreedraw` filter was renamed to
`isDegenerateElement` and broadened to cover all shape types
(`rectangle | ellipse | diamond | line | arrow`) with
`w < 1 && h < 1`. The clone in `lastBroadcastElements` was
widened to also clone `boundElements`, `groupIds`, and
`containerId` — the same class of mutate-in-place trap on
shape elements that bit freedraw's `points` in v0.5.5. The
save path's `drawingRecord.prop().set()` is now awaited so
the DB write completes before `_flushPanelSession` clears the
dirty flag.

**Known issue (out of scope for v0.5.6):** The cached
`drawingRecord` becomes a stale handle after page reload; both
`setName` and `prop().set()` silently no-op against the stale
handle. The plugin reports "Changes saved" but the DB isn't
updated. Fix candidate: re-resolve the record by GUID on every
save instead of caching. See `AGENT_NOTES.md` current state.

**Last meaningful change (v0.5.5 round 1):** Fixed the line→dot
save bug. The `isDegenerateFreedraw` filter that already ran at
WebSocket broadcast time now also runs in `_serializeScene`, so
the save path strips partial freedraws before `pendingScene` is
written to the database.

**Last meaningful change (v0.5.3):** Fixed the WS sync feedback loop that caused version inflation, ensure-start spam, and "line→dot" rendering on the receiving instance (see §11).

**Last meaningful change (v0.4.1):** Stopped the "Excalidrawings collection spawning" bug that produced 4 duplicate collections in the same workspace (see §4).

---

## 2. Architecture

### Drawing model (post-cleanup)

- **One `Excalidrawings` collection per workspace**, named exactly `Excalidrawings`.
- **One drawing record per source note**, titled `<note title> · Excalidrawing`.
- Each drawing record carries:
  - `Source note` (record) → the user note the drawing belongs to
  - `Scene` (text) → Excalidraw JSON
  - `Excalidrawing` (record) → self-reference (legacy shim field — see §3)
  - `Title` (text) → mirror of record name
- The source note carries:
  - `Excalidrawing` (record) → points to its drawing record
  - This is the plugin's primary navigation handle (`EXCAL_SOURCE_FIELD_ID = 'excalidrawing'` in `plugin.js`)

### The "shim" pattern (legacy, still in the data)

The older plugin version created a 2-record design for the same note:
- A "shim" record in the canonical `Excalidrawings` collection with `excalidrawing` cross-ref
- The actual scene data in a separate collection

We **flattened this** in v0.4.1 cleanup — the shim is now a single record with `Source note` + `Scene` + `Excalidrawing` (self-ref). The cross-collection ref is gone.

**If you see a `Excalidrawing` field on a drawing record (not on a source note), it's the legacy self-ref.** Safe to ignore or clear.

### Plugin internals (high level)

- `onLoad()` registers a command-palette command (`Excalidraw: Open drawing for this note`), a sidebar item, and a status bar item. Boots the drawings collection asynchronously.
- `_ensureDrawingsCollection()` is the entry point for the "find or create the collection" flow. Wrapped in:
  - `localStorage` lease (`thymerext_excal_drawings_create_lease_v1`) — per-origin
  - Cross-realm queue on `window.top` (`__thymerExcalDrawingsCreateQ_v1`) — per-origin
  - Global dedup promise (`__thymerExcalDrawingsEnsureP`) — per-origin
  - **None of these coordinate across browser origins.** See §4.
- `_invokeCreateCollectionOnce()` is the only place that calls `data.createCollection()`. **This is the function hardened in v0.4.1.**
- `_pickCanonicalDrawingsCollection()` chooses the winner when multiple match. Also hardened in v0.4.1.
- Drawing panel uses `ui.registerCustomPanelType(EXCAL_PANEL_TYPE, ...)` — see `EXCAL_PANEL_TYPE` constant.

---

## 3. The "Excalidrawings spawning" bug — root cause & fix

### Symptom (reported by user)

"new excalidrawings collections keep on spawning"

Live evidence (before fix, workspace `WKXP9WA3F5TCTMV5PS747QWV8H`): 4 collections all named `Excalidrawings`, each with the `excalidraw_drawings_coll_v1` custom marker.

### Root cause (confirmed via MCP + code reading)

The create-collection guards in `_ensureDrawingsCollectionCore()` and `_invokeCreateCollectionOnce()` rely on `localStorage` leases and `window.top` queues. **Both are per-origin.**

When two browser contexts load the plugin for the same workspace (e.g., dev-server on `localhost:4173` and prod on `harry.thymer.com`), they:
1. Pass the lease check (different `localStorage` per origin)
2. Pass discovery (no `Excalidrawings` visible to that origin yet)
3. Both call `data.createCollection()` — two new collections appear
4. Both `saveConfiguration()` with `name: "Excalidrawings"` + the marker — both stay marked

**The `_pickCanonicalDrawingsCollection` warning at line 2671-2675 only fires when `candidates.length > 1` is visible to the current origin.** If only 2 of the 4 dupes are visible to the user, they never see the warning.

### Fix (v0.4.1)

Four small edits in `plugin.js`:

1. **`_invokeCreateCollectionOnce()` (line ~2872)** — pre-create discovery check + post-create adopt-if-exists:
   ```js
   // Before createCollection():
   const existing = await this._discoverDrawingsCollection();
   if (existing) return existing;
   // After createCollection():
   const winner = await this._discoverDrawingsCollection();
   if (winner && winner !== coll && this._collectionLooksLikeDrawings(winner)) {
     return winner;
   }
   ```
   Makes the function idempotent — two racing callers both pick up the same collection.

2. **`_pickCanonicalDrawingsCollection()` (line ~2660)** — structured warning with all candidate GUIDs:
   ```js
   const guids = candidates.map((c) => this._getCollectionGuid(c) || '?').join(', ');
   console.warn(`[${EXCAL_PLUGIN_NAME}] ${candidates.length} "Excalidrawings" collections found ... GUIDs: [${guids}]`);
   // Also expose to globalThis.__excalDebug.duplicateDrawingsCollections
   ```
   So the user sees the full list of duplicates from any browser origin.

3. **`onLoad()` (line ~2558)** — chain `.then()` to surface boot-time info:
   ```js
   void this._bootDrawingsCollection().then((coll) => {
     if (globalThis.__excalDebug) {
       globalThis.__excalDebug.bootCollectionGuid = coll ? this._getCollectionGuid(coll) : null;
     }
   });
   ```

4. **Version bump** in `EXCAL_VERSION` and `plugin.json` (`0.4.0` → `0.4.1`).

### What we did NOT change (scope guard)

- Existing `localStorage` lease, cross-realm queue, global ensure promise — keep as defense-in-depth
- Schema shape, field names, plugin type, `cdnVersion`
- Realtime sync code
- The `excalidrawing` cross-collection ref design (now flat self-ref instead)

### Cleanup of existing duplicates (done in this session)

In workspace `WKXP9WA3F5TCTMV5PS747QWV8H`:

| Source note | Winner (latest `modified`) | Losers (trashed) |
|-------------|---------------------------|------------------|
| `159BTXS2GAEDEG4Z7EVRP2YK8J` ("index", Test Collection) | `1VJKZ59605NNWBJWYX91WS4M5Y` (12:28:44) | `1S147C6H0E90NP4Z6QF62KVZG9` (12:28:30) |
| `1CGXQ63T1ARB7PX9D2KWGSCKBP` ("Some other record") | `1FN4J478YH1DC0ZA2XJEYBCWS6` (12:18:28) | `18DGK4KDRCJZRR9VPY2F97539D` (12:18:14), `19JZNDTA91MFNT58T14D493R49` (12:12:03) |
| `14YFFVT9B5HSVH7RGJGHZA1SWV` ("Correspondence") | `1GSF7M2HR5X4BSEZ9S83DQCDFE` (13:01:19, latest) | `1PTGXFNAP2SMRBW2VYN4T0DV83` (12:49:22) |
| `195DTS7JK11ECZXKKSP1MB6S4Z` (current "index" shim) | flattened into single record with Source note + Scene | trashed scene record `1A9WS2G2CEXXMV88KSEAND7Z3T` |

All 3 winning records moved to canonical collection `1Z4RHRCF721RRBVGNWNY4NX56Z` (GUIDs preserved by `move_record_to_collection`).

Trashed empty duplicate collections:
- `11YKTFN9CRZC0468ZZ2B3YF3YR`
- `1XFFCN4GWH8YHBJNYHADT3T8YT`
- `1ABVC3RXW05YW6F6S9H1BVVDR5`

**Final state:** 1 `Excalidrawings` collection, 3 drawing records (one per source note).

---

## 4. MCP tool quirks discovered

### `thymer_update_record_property` stringifies arrays

When you pass `value: ["record", "<GUID>"]` to set a `record`-type property, the tool stores the **JSON string** of the array as the value's second element, not the array itself. Result: `value` becomes `["record", "[\"record\", \"<GUID>\"]"]` (double-wrapped).

**Fix:** pass the **plain string value** for the second element:
```json
{"property": "excalidrawing", "value": "1FN4J478YH1DC0ZA2XJEYBCWS6"}
```
This produces a clean `["record", "1FN4J478YH1DC0ZA2XJEYBCWS6"]` (the tool adds the `["record", ...]` wrapper itself).

`Scene` (text) follows the same pattern — pass the raw JSON string for the value, not `["text", "..."]`.

### `thymer_move_record_to_collection` preserves GUIDs

Confirmed: a moved record keeps its GUID. This made the cleanup safe (no need to re-point source notes' Excalidrawing fields just because we moved records between collections).

### `thymer_list_workspaces` returns one record per org

The `list_workspaces` tool returned `mcp_access: "readwrite"` for the active workspace, but `list_collections` for the same workspace then returned "MCP access is disabled". Root cause: the MCP server has two duplicate "harry.thymer.com" organizations registered. Different tools resolve to different orgs.

**Workaround:** call `list_collections` (or any tool that needs the workspace) without the `organization` parameter, or with the full hostname. The duplicate-org issue is at the MCP server level — out of scope to fix here.

### Deploy script picks the wrong workspace by default

`npm run push` calls `list_workspaces` and picks the first one. To target a specific workspace, set `THYMER_WS_GUID`:
```bash
$env:THYMER_WS_GUID="WKXP9WA3F5TCTMV5PS747QWV8H"; npm run push
```
Workspaces to know:
- `W6CDWK9CQRRWPJV2K5SM9YSW6P` — Harry's Workspace
- `WKXP9WA3F5TCTMV5PS747QVV8H` — Thymer-Cabinet sync (active by default; the one we test in)

---

## 5. Test workspace conventions

- "Thymer-Cabinet sync" is the test workspace — safe to trash, move, restructure data.
- "Harry's Workspace" is the production-like workspace — be conservative.
- Active notes we work with: "index", "Correspondence", "Some other record" (all in `Test Collection` `1H3Z8J1WYR0S4FPM967TR298GF`).
- User's user guid appears as `T58NDRDGNQ` in the org metadata but resolves to `harry.thymer.com` for tool calls.

---

## 6. Build & deploy

| Command | What it does |
|---------|-------------|
| `npm run build:quick` | One-shot esbuild → `dist/plugin.js` (minified ESM, **do not** paste this into Thymer) |
| `npm run dev` | Watch mode + CDP hot-reload to `localhost:9222` Chrome session |
| `npm run push` / `npm run deploy` | Build (unminified, no module format) + MCP `preview_plugin` + `update_plugin_code` + `update_plugin_json_config` |
| `npm run deploy:preview` | Build + MCP hot-reload (no persist) |

**Important:** `dist/plugin.js` from `build:quick` is NOT what gets pushed. The deploy script builds its own bundle to avoid the minification issue where `class Plugin` gets renamed and Thymer can't construct it. See `DEPLOYMENT.md` for full details.

---

## 7. Debug hooks available

After v0.4.1, the plugin sets:
- `globalThis.__excalDebug.bootCollectionGuid` — the GUID of the canonical Excalidrawings collection picked at boot
- `globalThis.__excalDebug.duplicateDrawingsCollections` — array of all candidate collection GUIDs (only set when `candidates.length > 1`)

Plus the long-standing `DIAG:` console logs scattered through the plugin (set during the early drawing-realtime debugging — search for "DIAG:" in `plugin.js` to see them).

---

## 8. Lessons / things to remember for future agents

1. **The plugin creates a per-workspace collection named exactly `Excalidrawings`.** Don't search by GUID — search by name. The canonical marker is `custom.excalidraw_drawings_coll_v1 === true`.
2. **Per-origin locks don't coordinate across origins.** Any "ensure this exists once" logic in a Thymer plugin must use the workspace as the source of truth, not localStorage. The v0.4.1 fix added this.
3. **`_getActiveRecord()` returns null when viewing a collection table.** The sidebar button and command palette require a specific record to be open, not just a collection. The plugin uses `this.ui.getActivePanel()?.getActiveRecord?.()`.
4. **Drawing records have a self-referencing `excalidrawing` field** (legacy shim). When you see a drawing record with `excalidrawing = <its own guid>`, that's the flat design (correct). When you see a record where `excalidrawing = <another collection's record>`, that's a stale shim and should be flattened.
5. **Don't use `update_record_property` with array values for record-typed properties.** Pass the plain string value instead. Same for text properties — pass the plain text, not `["text", "..."]`.
6. **MCP `move_record_to_collection` preserves GUIDs** — safe to migrate between collections.
7. **The plugin runs in two browser origins regularly** (dev-server + prod). Any code that affects workspace data MUST be safe under that condition. Cross-origin coordination must use the workspace, not browser storage.
8. **The plugin's "Excalidrawings" collection is found by name + marker.** `_collectionLooksLikeDrawings()` matches exact name OR `/^excalidraw/i` regex. So a collection named "Excalidraw notes" would also match — be careful with naming.

---

## 9. Quick reference — GUIDs after cleanup

Canonical `Excalidrawings` collection in Thymer-Cabinet sync: `1Z4RHRCF721RRBVGNWNY4NX56Z`

Drawing records (one per source note):
- `195DTS7JK11ECZXKKSP1MB6S4Z` → Test Collection "index" `159BTXS2GAEDEG4Z7EVRP2YK8J` (has the rectangle+arrow scene)
- `1GSF7M2HR5X4BSEZ9S83DQCDFE` → "Correspondence" `14YFFVT9B5HSVH7RGJGHZA1SWV`
- `1FN4J478YH1DC0ZA2XJEYBCWS6` → "Some other record" `1CGXQ63T1ARB7PX9D2KWGSCKBP`

Test Collection: `1H3Z8J1WYR0S4FPM967TR298GF`

---

## 10. If you are investigating a similar issue

Checklist for "collection count > 1" reports:
1. List all collections matching `/^excalidraw/i` in the workspace via `thymer_list_collections`
2. For each, check `custom.excalidraw_drawings_coll_v1 === true` (the marker)
3. Use `thymer_list_records` to count records per dup
4. Identify the canonical one (most complete schema, or most records, or most recent `modified` on its records)
5. Use `thymer_move_record_to_collection` to migrate winning records to canonical
6. Update source notes' `excalidrawing` field to point to the new winner (use `update_record_property` with plain GUID string, NOT array)
7. `thymer_trash_record` the losers and empty duplicates
8. Verify with another `thymer_list_collections` — should be exactly 1

---

## 11. The "line → dot" and sync feedback loop bug — root cause & fix (v0.5.3)

### Symptoms (reported by user)

1. **Line/freedraw drawn on instance A shows as a dot on instance B.** Live evidence: drawing record `1NVHN7RE5AB9QGEJ5S5TT6HM5S` ("Tasks · Excalidrawing") had two freedraw elements with `points:[[0,0]], width:0, height:0, lastCommittedPoint:null` — incomplete "dot" artifacts stuck in the saved scene.
2. **`ensure start` fires every 3–5 seconds** instead of once on load. Every autosave re-entered the full collection-discovery flow.
3. **Massive onChange + empty-delta churn** when idle. "empty delta — skip broadcast" flooded the console.
4. **Rapid version inflation.** Text element `ZgF7a6mT4_BgPIWbnE6Zs` went from `version:1` to `version:94` in ~27 seconds. Confirmed persisted in the saved scene.

### Root cause (3 compounding bugs)

**A. `_ensureDrawingsCollection` self-deletes its dedup promise (plugin.js:3087).** The `finally { delete host[gKey] }` block means every subsequent call re-enters the full `_ensureDrawingsCollectionCore` (30-iteration retry, post-lease discovery, create). Every autosave (1.5s) re-fires the DIAG log.

**B. `lastBroadcastElements` desync after force-apply (plugin.js:5089-5096, the critical bug).** The old code updated `lb` by comparing `data.elements` (pre-force-apply incoming) against `merged` (pre-force-apply merge result). After force-apply bumped versions to `maxLocalVersion + 1`, the condition failed for stuck elements, so `lb` retained the stale version **forever**. This created a permanent mismatch between `lb` and the scene, causing every subsequent `onChange` to detect a non-empty delta and re-broadcast — which triggered more force-applies, more bumping, more re-broadcasts. **This is the version-inflation engine.**

**C. Double-rAF echo window (plugin.js:5086, 5152, 5182).** `applyingRemoteUpdate` was reset via `requestAnimationFrame(() => requestAnimationFrame(...))` (~32ms). Any `onChange` Excalidraw fired after this window (from async render commits) leaked through as a broadcast, feeding the loop even when idle.

### Fix (v0.5.3)

Four small edits in `plugin.js`:

1. **`_adoptDrawingsCollection()` (line 2829)** — set `this._drawingsCollectionRef = coll` on success.
   **`_ensureDrawingsCollection()` (line 3080)** — early-return `this._drawingsCollectionRef` if set. Ensures ensure-start fires once on boot, never again on every autosave.

2. **`_handleIncomingWsMessage()` (line 5090-5099)** — replaced the buggy `lb` update with a full rebuild from `session.excalApi.getSceneElements()`. After any remote update (including force-apply), `lb` is now always in sync with the actual scene. Any echo `onChange` that fires as a side-effect of `updateScene` now finds an empty delta and is skipped naturally.
   **Same fix applied to `_handleRemoteRecordUpdated()` (line 5150-5161) and `_handleReload()` (line 5187-5198).**

3. **Replaced the double-rAF with a timestamp debounce.**
   - Set `session.lastRemoteApplyMs = Date.now()` before every `updateScene` (lines 5057, 5084, 5151, 5188).
   - Removed all 3 `requestAnimationFrame(() => requestAnimationFrame(...))` blocks.
   - Reset `session.applyingRemoteUpdate = false` synchronously after `updateScene` returns.
   - Added a 150ms timestamp guard in the `onChange` handler (line 3646):
     ```js
     const echoSuppressed = session.applyingRemoteUpdate || (Date.now() - (session.lastRemoteApplyMs || 0) < 150);
     if (!echoSuppressed) plugin._scheduleWsBroadcast(session, elements);
     ```
   - `applyingRemoteUpdate` initialized to `false` and `lastRemoteApplyMs` initialized to `0` in session defaults (line 4163).

4. **`_broadcastElementDelta()` (line 4958-4960)** — skip broadcasting freedraw elements with `points.length <= 1` and `lastCommittedPoint === null`. Prevents the initial "pointer-down" single-point state from being broadcast as a "dot" before the stroke is completed.

### Data cleanup (applied via MCP, same session)

In workspace `WKXP9WA3F5TCTMV5PS747QVV8H`, record `1NVHN7RE5AB9QGEJ5S5TT6HM5S` ("Tasks · Excalidrawing"):

| Action | Element | Before | After |
|--------|---------|--------|-------|
| Removed | `eOlgiT2YZ1WDnEY2L_0vK` (freedraw) | `points:[[0,0]], width:0, height:0, version:2` | — |
| Removed | `qsV6oaUUHd7Mtlwkdzw1Z` (freedraw) | `points:[[0,0]], width:0, height:0, version:2` | — |
| Reset | `ZgF7a6mT4_BgPIWbnE6Zs` (text) | `version:94, versionNonce:2067836027` | `version:1, versionNonce:540171372` |

Cleanup script: `scripts/cleanup-drawing-records.mjs` (one-shot, safe to delete or keep for reference).

### What we did NOT change (scope guard)

- Schema shape, field names, plugin type, `cdnVersion`
- Force-apply LWW mechanism (kept, but now safe because `lb` is always in sync)
- Excalidraw UMD version
- WS throttle (80ms), autosave (1500ms)

### Verification checklist (post-deploy)

- [ ] `npm run deploy` succeeds with no errors → done
- [ ] `ensure start` DIAG log fires once on boot, never again on every autosave
- [ ] No "empty delta — skip broadcast" spam when idle (may still fire a few times during the 150ms echo-suppression window after a remote update)
- [ ] No version inflation in the console (versions should stay within 1–50 for typical drawings)
- [ ] Drawing a line on A appears as a line on B (not a dot)
- [ ] Drawing a freedraw stroke on A appears with all points on B
- [ ] Bidirectional edits converge correctly

