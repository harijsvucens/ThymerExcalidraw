# Agent Notes

Scratch space for the current investigation. Captures live evidence,
hypotheses, and decisions as we work through the sync bugs.

> **Debugging this plugin:** see [DEBUG.md](DEBUG.md) for the
> probe pattern, the MCP access quirks, the twelve gotchas that
> each cost an hour, and a worked-example debug of bug 3.

## Current state (post-v0.5.8, 2026-06-30)

**v0.5.8 deployed — bug 9 (fresh load shows blank canvas) FIXED.**
The root cause was *not* a record-matching problem (the v0.5.7
"multi-collection search" / `excalidrawing` fallback was solving
the wrong layer). The drawing record was always being found via
the `source_note` cross-ref. The actual break was one layer
down: `_buildInitialData` (plugin.js:4605) could not parse the
v3 save format. The save path (`_serializeScene` → `_saveDrawingDoc`)
produces `{ v:3, scene: { sceneJson: "<JSON string>" } }`, but
`_buildInitialData` only checked `doc.sceneJson` (top-level) and
`doc.scene.elements` (direct array) — the actual nested
`doc.scene.sceneJson` was never read, so the function returned
`null` on every load. Fixed by adding the `doc.scene.sceneJson`
branch in both `_buildInitialData` and `_sceneDocHasContent`.
Same fix also uncovered three secondary defects (see
`CHANGELOG.md`): the undefined `_isDrawingsCollection` typo,
the cache-null no-re-query path, and the backwards
`excalidrawing` matcher on the drawing record.

**Bugs fixed across the line:** 1 (line→dot), 3 (two-tab
freedraw divergence), 4 (two-tab shape sync), 5 (DB save stale
handle — same root cause, fixed by the v0.5.8 re-resolve path),
6 (bidirectional move sync), 7 (layer-order sync), 8 (host
context menu double-open), 9 (fresh load shows blank canvas).

## Current state (post-v0.5.7, 2026-06-30 09:55)

**v0.5.7 deployed and verified live.** Bug 1 (line→dot), bug 3
(two-tab freedraw divergence), bug 4 (two-tab shape sync),
bug 6 (bidirectional move sync), bug 7 (layer-order sync),
and **bug 8 (host context menu double-open)** are FIXED.
**Bug 5 (DB save stale handle)** is a separate issue: the
in-page `drawingRecord` becomes a stale handle after a page
reload, at which point `setName` and `prop().set()` silently
no-op. The status bar still says "Changes saved" because the
awaited promise resolves with no error. MCP-side writes work
fine.

**Bug 8 (host context menu opens inside the Excalidraw panel):**
**FIXED in v0.5.7.** Root cause: Excalidraw is mounted in-page
(React root) inside `.excal-panel-shell` → `.excal-panel-stage`
→ `.excal-host` → `<canvas>`. The `contextmenu` event from a
right-click bubbles from the canvas up to `document`, where
Thymer's host has a context-menu listener that opens the
note-action menu (Cut, Copy, Paste, Add block, etc.). Both
menus ended up open at once. The Thymer `events.on(...)` API
exposes `panel.navigated`, `panel.focused`, `panel.closed`,
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

**v0.5.6 deployed and verified live.** Bug 1 (line→dot), bug 3
(two-tab freedraw divergence), bug 4 (two-tab shape sync),
bug 6 (bidirectional move sync), and bug 7 (layer-order sync)
are FIXED. **Bug 5 (DB save stale handle)** is a separate
issue: the in-page `drawingRecord` becomes a stale handle
after a page reload, at which point `setName` and
`prop().set()` silently no-op. The status bar still says
"Changes saved" because the awaited promise resolves with no
error. MCP-side writes work fine.

**Bug 7 (layer-order sync — bring-to-front doesn't sync):**
**FIXED in v0.5.6 (round 3).** Root cause: Excalidraw uses
the elements array order as z-order. When the user changes
layer order on tab B, the moved element's version bumps and
goes into the WS delta, but the **array position** is not in
the delta. The receiver's `_mergeSceneElements` preserves
local order and only updates per-element data, so the z-order
change was dropped. **Fix:** added `sceneOrder: [...ids]` to
the WS broadcast (full current array order). On receive, if
the order differs AND at least one incoming element is newer
than its local counterpart, the merge reorders to match
sender's order. The "newer" check uses the existing
`version` / `versionNonce` LWW contract, so a stale broadcast
can't override a fresher local reorder. Verified: reorder
on either tab now propagates in <1s, and move+reorder
together syncs correctly.

**Bug 6 (bidirectional move sync — A→B works, B→A doesn't):**
**FIXED in v0.5.6 (round 2).** Root cause: the v0.5.5 fix
cloned elements in `_broadcastElementDelta` (the WS-send path)
but there were **four other re-seed sites** that stored live
element references from `excalApi.getSceneElements()`:
`_setupRealtimeListeners` (initial seed),
`_handleIncomingWsMessage` (after applying remote delta),
`_handleRemoteRecordUpdated` (after applying remote DB save),
and `_handleReload` (after applying local record at boot). All
four reintroduced the bug-3 in-place-mutation trap. The
sequence that exposed it: tab A draws, broadcasts (p2 receives,
applies, re-seeds `lastBroadcastElements` with live refs).
Then tab B moves the shape — the next broadcast on tab B
computes delta from the live-ref snapshot, sees
`prevEl.version === el.version` (same object) and emits an
empty delta. Tab A never sees the move. **Fix:** extracted
`_cloneElementSnapshot(el)` helper and applied it to all five
re-seed sites. Verified live: 5 back-and-forth moves between
two tabs, all positions matching exactly (v=32, 33, 34, 35, 36).
The lesson: any time `excalApi.getSceneElements()` is iterated
to populate a snapshot, the elements must be cloned — Excalidraw
mutates in place. This trap is a recurring footgun and warrants
a defensive helper rather than inline spreads.

**Bug 6 (bidirectional move sync — A→B works, B→A doesn't):**
**FIXED in v0.5.6 (round 2).** Root cause: the v0.5.5 fix
cloned elements in `_broadcastElementDelta` (the WS-send path)
but there were **four other re-seed sites** that stored live
element references from `excalApi.getSceneElements()`:
`_setupRealtimeListeners` (initial seed),
`_handleIncomingWsMessage` (after applying remote delta),
`_handleRemoteRecordUpdated` (after applying remote DB save),
and `_handleReload` (after applying local record at boot). All
four reintroduced the bug-3 in-place-mutation trap. The
sequence that exposed it: tab A draws, broadcasts (p2 receives,
applies, re-seeds `lastBroadcastElements` with live refs).
Then tab B moves the shape — the next broadcast on tab B
computes delta from the live-ref snapshot, sees
`prevEl.version === el.version` (same object) and emits an
empty delta. Tab A never sees the move. **Fix:** extracted
`_cloneElementSnapshot(el)` helper and applied it to all five
re-seed sites. Verified live: 5 back-and-forth moves between
two tabs, all positions matching exactly (v=32, 33, 34, 35, 36).
The lesson: any time `excalApi.getSceneElements()` is iterated
to populate a snapshot, the elements must be cloned — Excalidraw
mutates in place. This trap is a recurring footgun and warrants
a defensive helper rather than inline spreads.

**Bug 4 (shape sync — rectangle/ellipse/diamond don't show on
tab B):** **FIXED in v0.5.6 (round 1).** The `isDegenerateFreedraw`
filter only covered freedraws. Shape tools (rectangle, ellipse,
diamond) report `width: 0, height: 0` between pointer-down and
pointer-up; the in-progress zero-size state was being broadcast
as a real element, and the receiving tab was left holding the
dot. Fix: renamed the helper to `isDegenerateElement` and
broadened it to cover shapes with `w < 1 && h < 1`. Verified
live: drew rect + ellipse + diamond on tab 1; tab 2 received
all three with matching `id`, `type`, `x`, `y`, `width`,
`height`, `version`, and `versionNonce`.

**Bug 5 (DB save stale handle):** **NOT YET FIXED.** Status
shows "Changes saved" but `Modified` field doesn't move and the
Scene property value is unchanged. The `await prop.set()` patch
in v0.5.6 didn't help — the prop setter resolves with no error
but the DB write is silently dropped. Hypothesis: the cached
`drawingRecord` is from a prior session and its `.prop()` returns
a detached prop object. To fix: re-resolve `drawingRecord` by
GUID on every save (don't cache), or call
`drawingsColl.getRecord(guid)` to get a fresh handle each save.

## Current state (post-v0.5.5, 2026-06-29 20:18)

**v0.5.5 deployed and verified live.** Bug 1 (line→dot) and Bug 3
(two-tab sync — same element is a stroke on one tab, a dot on the
other) are FIXED. Bug 2 (version inflation) is not yet reproduced.

**Test framework:** working. See TESTING.md for the full guide.
**Baseline captured:** `tests/baseline/BASELINE-line-dot.json`
**Bug 1 (line→dot):** **FIXED in v0.5.5.** Saved scene now holds the
full geometry (26 + 41 points) instead of the 1–5 point degenerate
dots from v0.5.3.
**Bug 2 (version inflation):** hypothesis, not yet run.
**Bug 3 (two-tab divergence):** **FIXED in v0.5.5 (round 2).** The
`lastBroadcastElements` map was storing element *references* that
Excalidraw mutates in place. After the first broadcast set `prev`
to v=3, every subsequent broadcast's `prevEl === el` (same object)
and `prevEl.version === el.version`, so the delta was always
empty and the WS message never carried the in-progress stroke.
The fix: shallow-clone each element when storing it in
`lastBroadcastElements` so the snapshot doesn't drift with the
live scene.

## Bug 3 (two-tab) live evidence (pre-fix, then post-fix)

`tests/sync/twotab-sync.mjs` — open the index record on two tabs in
the same context, open Excalidraw on both, draw a 25-point freedraw
on tab A only, then read both scenes.

**Pre-fix (v0.5.5 round 1):**

| Tab | Element id | points | width | height | version |
|---|---|---|---|---|---|
| A (drew it) | `IPV5X2zkn8kzibH5IkwpA` | 26 | 144 | 49.89 | 27 |
| B (received) | `IPV5X2zkn8kzibH5IkwpA` | **2** | 6 | 9.74 | **3** |

Same id, completely different geometry. A's element looks like a
stroke; B's is the dot captured at v=3 from the first broadcast.
Console showed exactly one `DIAG: broadcasting` log on A and one
`DIAG: WS recv` on B; subsequent broadcasts had `currentN=1
prevN=1 deltaN=0 firstCurrent=v=27 firstPrev=v=27` — the
previously-broadcast element reference had been mutated in place
by Excalidraw to the new version, so the delta filter thought
nothing had changed.

**Post-fix (v0.5.5 round 2, with `lastBroadcastElements` cloning):**

| Tab | Element id | points | width | height | version |
|---|---|---|---|---|---|
| A | `YUbk-BZmgssEoxpqJE0p8` | 26 | 144 | 49.89 | 27 |
| B | `YUbk-BZmgssEoxpqJE0p8` | 26 | 144 | 49.89 | 27 |

`divergent: []`, `aDots: []`, `bDots: []`. 17 broadcasts from A,
17 WS messages received on B. Both tabs converge to the final
stroke.

## v0.5.5 verification (2026-06-29)

Set the test drawing record's Scene to a blank Excalidraw scene via
MCP, then ran `tests/sync/T1T3-baseline.mjs` against the freshly
deployed v0.5.5 plugin. Result:

| Where | Element id | points | width | height | version |
|---|---|---|---|---|---|
| In-memory after draw | `uKOwK6LEKj1V1Z40gxatf` | 26 | 144 | 49.89 | 27 |
| **Saved to DB** | `uKOwK6LEKj1V1Z40gxatf` | **26** | 144 | 49.89 | **27** |
| In-memory after draw | `VVkjwvSKtKrsPmDcspj6j` | 41 | 230.67 | 306.99 | 42 |
| **Saved to DB** | `VVkjwvSKtKrsPmDcspj6j` | **41** | 230.67 | 306.99 | **42** |

In-memory and DB now agree. No degenerate dots. No duplicate
`sceneJson` key at the top level. The probe in `_saveDrawingDoc`
logged `EXCAL_VERSION=0.5.5` and `doc.keys=["v","sourceRecordGuid",
"updatedAt","scene"]` for every save.

---

## Live evidence of bug 1 (line→dot)

Test: `tests/sync/T1T3-baseline.mjs`
Record: `195DTS7JK11ECZXKKSP1MB6S4Z` (drawing for "index" note)

| Where | Element id | points | width | height | version |
|---|---|---|---|---|---|
| In-memory after draw | `sKOjT5roFmrPRMfs-d62W` | 44 | 249 | 92.9 | 45 |
| **Saved to DB** | `sKOjT5roFmrPRMfs-d62W` | **5** | 230 | 61 | **6** |
| In-memory after draw | `Hp_Xe3M3BQYpKydZJ_6QI` | 26 | 144 | 49.9 | 27 |
| **Saved to DB** | `Hp_Xe3M3BQYpKydZJ_6QI` | **2** | 6 | 9.7 | **3** |

The saved scene has truncated versions of the strokes. The user
paused mid-stroke for 2.2s (longer than the 1.5s autosave) and the
autosave fired during the partial stroke. The 1.5s autosave
captured the intermediate state, not the final state.

**Why v0.5.3 didn't fix it:** the v0.5.3 patch added the
`isDegenerateFreedraw` filter inside `_broadcastElementDelta`
(plugin.js:4955). It filters the broadcast layer but **not the save
layer**. The save path in `onChange` (line 3637) calls
`_serializeScene` and `pendingScene = ...` on every event. The save
flushes `pendingScene` 1.5s after the last onChange. If the user
pauses mid-stroke, the pendingScene has the in-progress stroke with
a few points, and that gets written to the DB.

**Fix:** apply `isDegenerateFreedraw` to the elements before
serializing in `_serializeScene` (line 4455–4473). Same predicate,
applied at the save path.

---

## Live evidence of bug 2 (version inflation)

The Tasks record (`1NVHN7RE5AB9QGEJ5S5TT6HM5S`) before any test
running had:
- Text element `ZgF7a6mT4_BgPIWbnE6Zs` with `version: 94` and
  `versionNonce: 2067836027`
- Two degenerate freedraws `eOlgiT2YZ1WDnEY2L_0vK` and
  `qsV6oaUUHd7Mtlwkdzw1Z`

The text "This still fails" was a deliberate marker. The v0.5.3
fix should have stopped this. It didn't.

**Hypothesis:** the 150ms echo guard in onChange (line 3646) only
gates the WS broadcast, not the save. When the force-apply LWW
block (line 5082–5096) bumps an incoming element's version to
`maxLocalVersion + 1`, Excalidraw fires an onChange as a side
effect. If 150ms has passed, the new state is captured by the
pendingScene and the next autosave writes the bumped version. The
remote side sees the higher version, applies, force-applies, bumps
again. Loop.

**Fix:** widen the echo guard to also gate the save path. Bump the
window from 150ms to ~500ms (Excalidraw's render commits can be
that far apart during heavy edits).

---

## Live evidence of bug 3 (geometry loss)

In the same Tasks record, the "line" element
`5xIq3Vtg9cIzDlVjQEdbD` survived the cleanup with `version: 28`
and the correct `points:[[0,0],[194.99,466.66]]` geometry. But
the freedraws and text show signs of geometric loss: the saved text
element has `width: 141.26866` and `height: 25` (the saved width
makes sense for the rendered text "This still fails", so this
specific element looks fine in isolation).

What we need to prove: open the Tasks drawing on TWO tabs. From
tab A, move a rectangle. From tab B, edit the same rectangle's
color. After settling, both tabs should converge to the same
geometry. If they don't, bug 3 is real.

**Hypothesis:** the force-apply LWW (line 5082–5096) drops the
local element with the higher version and replaces it with the
incoming (older) element. This is the **opposite** of LWW — it's
first-write-arrival-wins. The filter selects elements where
`placed.version > incoming.version` (the local is newer), then
discards the local data and applies the incoming data, bumping the
version. The local user's edit is overwritten by the remote's
stale state.

**Fix:** drop the force-apply entirely. Make `_mergeSceneElements`
a true LWW by `version` AND `versionNonce`. If the local is newer
by version OR by nonce, keep the local. The incoming data is
discarded. The remote side will re-broadcast its current state on
its next onChange anyway.

---

## What the plugin does RIGHT (don't break these)

- Excalidraw UMD pinned at 0.17.6 (`cdnVersion` in plugin.json)
- Per-workspace `Excalidrawings` collection (one per workspace)
- Plugin-side localStorage mirror for offline reads
- Command-palette entry "Excalidraw: Open drawing for this note"
- Sidebar item with the same functionality
- Status bar showing save state
- WebSocket broadcast for real-time sync across instances
- Echo suppression in broadcast (just needs to extend to save)

---

## Files I created

- `tests/lib/cdp.mjs` — playwright-core CDP connection helpers
- `tests/lib/drawing.mjs` — drawing helpers (freedraw, line, etc.)
- `tests/lib/harness.mjs` — main test API (waitForExcalSession, readSceneElements, injectWsDelta, etc.)
- `tests/lib/report.mjs` — JSON report writer
- `tests/lib/mcp-scene.mjs` — STUB (MCP reads from Node not yet wired)
- `tests/sync/T1T3-baseline.mjs` — reproduces bug 1
- `tests/sync/T1-draw.mjs` — sanity check
- `tests/sync/T2-idle.mjs` — reproduces bug 2 (not yet run)
- `tests/sync/twotab-index.mjs` — two-tab setup
- `tests/sync/twotab-init.mjs` — two-tab init
- `tests/sync/write-baseline.mjs` — aggregate baseline report
- `tests/sync/open-palette-ctrlp.mjs` — palette flow smoke
- `tests/sync/{smoke,diag,deepprobe,probe,urls,find-record,find-rows,find-record-els,deep-table,palette-keys,click-excal,open-via-sidebar,open-record,debug-canvas,deep-dom}.mjs` — throwaway probes (KEEP for archaeology)
- `TESTING.md` — full guide for the next agent
- `AGENT_NOTES.md` — this file

## Files I did NOT touch

- `plugin.js` (yet — the fix is in plan form, awaiting user approval)
- `plugin.json` (yet)
- `package.json` (added playwright-core as devDep, that's it)
- Any of the existing scripts/

## Next step (once approved)

Apply the v0.5.5 fix in `plugin.js`:
1. Hoist `isDegenerateFreedraw` to a module-level helper.
2. Apply it in `_serializeScene` so degenerate freedraws are
   stripped before `pendingScene` is set.
3. Widen the 150ms echo guard to also gate the save path; bump
   the window to 500ms.
4. Drop the anti-LWW force-apply block at line 5082–5096. Make
   `_mergeSceneElements` a true LWW.
5. Remove the duplicate `sceneJson` key in the save path
   (line 4760).
6. Bump `EXCAL_VERSION` to `0.5.5`. Update `plugin.json`.
7. `npm run push` to deploy.
8. Re-run T1T3-baseline.mjs and confirm the saved scene now has
   the full 44/26 points, not 5/2.
9. Add CHANGELOG.md entry.
