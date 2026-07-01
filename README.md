# Excalidraw (Thymer global plugin)

Side-panel Excalidraw sketches tied to the **currently open note**. One drawing per note; data lives in the **Excalidrawings** collection with bidirectional note links.

## Install

1. In Thymer: **Command Palette → Plugins → Create Plugin** (Global / App plugin), or open an existing global plugin slot.
2. Paste [`plugin.json`](plugin.json) into **Configuration**.
3. Paste the full [`plugin.js`](plugin.js) into **Custom Code** and save.
4. Reload Thymer.

On first use the plugin creates an **Excalidrawings** collection (if missing) and, on first save from a note, adds an **Excalidrawing** property to that note's collection when the schema allows it.

## Use

1. Open any note.
2. **Command Palette → `Excalidraw: Open drawing for this note`**
3. A new panel opens with the canvas. Edits **auto-save** after ~1.5s idle.
4. Close the panel when done — a final save runs on close.

Each note has its own drawing record titled **`<note title> · Excalidrawing`**. Reopen the command on the same note to continue editing.

## Storage

| What | Where |
|------|--------|
| Scene JSON | **Excalidrawings** → **Scene** property on each drawing record |
| Back-link | **Source note** on the drawing record |
| Forward link | **Excalidrawing** on the source note (auto-added to collection schema when possible) |

Legacy drawings in **Plugin Backend** (`record_kind` = `drawing`) are still **read** for migration; new saves go to **Excalidrawings** only.

## Performance notes

- Excalidraw loads via **classic UMD script tags** (unpkg/jsDelivr) — works in Thymer's plugin sandbox where ES modules hang.
- If UMD fails, falls back to an **excalidraw.com iframe** (draw immediately; persist via Share link button).
- Nothing runs on idle pages beyond the lightweight plugin bootstrap.

## Troubleshooting

- **Stuck on "Loading editor…"** — re-paste latest `plugin.js`. Status should advance through "Loading React…", "Loading Excalidraw…", then show the canvas or excalidraw.com iframe.
- **Iframe mode** — full Excalidraw site embedded. After drawing: Menu → Share → Get link, then click **Save share link to note** in the toolbar.
- **Excalidrawing property not added** — some collection plugins lock schema (`managed.fields`). Add a record field named **Excalidrawing** manually, filtered to **Excalidrawings**.

## Config (`plugin.json` → `custom`)

| Key | Default | Purpose |
|-----|---------|---------|
| `cdnVersion` | `0.17.6` | Pin `@excalidraw/excalidraw` UMD version |
| `autosaveMs` | `1500` | Debounced save delay (minimum 800) |

## Changelog (v0.3.0 → v0.6.2)

### v0.6.2 — LocalStorage poisoning fix, DB-wins merge, WS delta guard

- **DB always wins over empty localStorage.** `_pickNewerDoc` is now content-aware: if DB has non-empty elements and localStorage is empty, DB wins regardless of `updatedAt`. Poisons (stale empty entries from pre-v0.6.1) can no longer blank the canvas on load.
- **Heal poisoned localStorage on load.** After a DB load, the DB doc is written back to localStorage, clearing stale empty entries.
- **Block WS deltas when load failed.** If `session.drawingRecordGuid` is null, skip the delta and trigger `_reloadDrawingDoc` instead, preventing partial-scene accumulation on a blank canvas.
- **DB-aware save guard (Layer 4).** Compare live element count against `_dbSceneElementCount` — if fewer elements with no explicit deletions, refuse the save. The strongest data-loss prevention.
- **WS filter also matches `drawingRecordGuid`.** Cross-tab sync works even when the source-record filter doesn't cover it.
- Tests: T11 (localStorage poisoning), T12 (cross-tab partial-save guard), T13 (DB-wins reconciliation), T14 (load fail + WS delta). Probe line: `DIAG: onChange N els, ... dbAwareBlocked=...`.

### v0.6.1 — Mount-echo data loss fix (3-layer defense)

- **Layer 1:** Seed `lastRemoteApplyMs: Date.now()` in session init so the 500ms echo guard fires for Excalidraw's own initial-mount onChange events (not just remote updates).
- **Layer 2:** Snapshot scene id signature after `_buildInitialData`; skip save if new scene's signature matches the loaded one.
- **Layer 3:** When `_hadNonEmptyInitialData === true` and live scene has 0 elements with no deletions, refuse the save unconditionally. Mirrored in `_flushPanelSession`.
- New helpers: `_excalSceneSignature`, `_excalSerializedElementCount`.
- T10 mount-echo regression test passes.

### v0.6.0 — Show Data button

- **"Show Data" button** (`📋`) in the Excalidraw panel opens the raw drawing record in a new panel with Thymer version history accessible.

### v0.5.8 — Scene load bugfix & diagnostics
- **Fixed blank canvas on reload**: v3 save format (`doc.scene.sceneJson`) was never parsed by `_buildInitialData` — the function returned `null` on every load, so Excalidraw always started empty. Added a third branch that parses the nested JSON string through `lib.restore()`.
- **Fixed `_isDrawingsCollection` dead code**: `_getAllDrawingsCollections` called a nonexistent method; the `try/catch` silently swallowed it, so multi-collection search was always returning only the primary collection.
- **Cache-null re-query**: A cached `null` from a transient failure could permanently poison the drawing record cache. Only return early on truthy cache hits now.
- Added `first_seen_at_ms` backfill to disambiguate duplicate Excalidrawings collections by their record age.

### v0.5.7 — Context menu suppression
- **Right-click inside the Excalidraw panel** no longer opens Thymer's note-action context menu in addition to Excalidraw's own. Installed a capture-phase `contextmenu` guard on the panel shell that calls `stopPropagation()`.
- Guard is removed on panel close via `_teardownRealtimeListeners`.

### v0.5.6 — Real-time sync (WebSocket + event-driven)
- **Shape sync between tabs**: Rectangles, ellipses, diamonds now sync between browser tabs. In-progress zero-size shape states (between pointer-down and pointer-up) are filtered out via `isDegenerateElement()`.
- **Bidirectional move sync**: Extracted `_cloneElementSnapshot()` and applied it to all 5 re-seed sites, preventing in-place mutation from poisoning the delta-filter snapshot. Moves on either tab now propagate correctly.
- **Layer-order (z-order) sync**: Broadcasting full `sceneOrder` array so layer changes (bring to front/send to back) propagate across tabs. The receiver applies the order only when incoming data is newer (LWW).
- **Save await**: `_saveDrawingDoc` now awaits the prop setter promise, so the DB write truly completes before the panel session is flushed.
- **Echo guard applied to save path** as well as broadcast path to prevent echo-triggered re-saves.

### v0.5.5 — Sync & persistence fixes
- **Line→dot save bug**: `isDegenerateFreedraw` filter now also runs in `_serializeScene`, so mid-stroke pause autosaves don't persist degenerate 1–5 point dots.
- **Two-tab divergence**: `lastBroadcastElements` now stores shallow clones of elements instead of live references, preventing in-place mutation from causing empty deltas.
- **Throttle callback always broadcasts**: the timeout callback now unconditionally calls `_broadcastElementDelta`, which short-circuits if the delta is empty.
- **Anti-LWW force-apply block removed**: the merge is now a true LWW by `version` + `versionNonce`.
- **Duplicate `sceneJson` key removed** from the saved doc (was writing both `doc.scene.sceneJson` and top-level `doc.sceneJson`).

### v0.3.0 — Build tooling & development infrastructure
- **esbuild dev server** (`dev.js`): watch mode with CDP hot-reload via Chrome DevTools Protocol.
- **Deploy script** (`scripts/deploy-plugin.mjs`): MCP-based build + preview + persist pipeline, supporting `THYMER_WS_GUID` targeting.
- **Documentation**: `DEBUG.md` (8 gotchas from the v0.5.5 sync-bug session), `CONTEXT.md` (architecture), `DEPLOYMENT.md` (deploy commands), `TESTING.md` (test setup), `AGENT_NOTES.md` (agent workflow).
- **Test harness**: `tests/` directory with sync test scripts (baseline, two-tab sync).
- **Diagnostics**: `__excalDebug` global for runtime introspection, duplicate collection detection, element-level DIAG logging for WS broadcasts.
