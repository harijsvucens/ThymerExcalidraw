# Debugging the Excalidraw Plugin

> **Read this first if you are an agent asked to:** reproduce a sync
> bug, verify a fix, or instrument the running plugin. The plugin
> code is minified into a single bundle; you cannot read it from
> the page. All debugging goes through (a) the **probe pattern**
> (add a temporary `console.log` to the source, rebuild, redeploy,
> re-run the test, read the page's console), and (b) the **MCP
> read** of the saved record.
>
> The session that landed v0.5.5 lost about an hour to each of
> the gotchas below. The v0.5.6 round 2 session found one more
> (gotcha 5.9). Don't repeat them.

---

## 1. The four "channels" you can use

| Channel | What it sees | When to use it |
|---|---|---|
| `console.log` inside the plugin source (the **probe**) | Anything inside `_saveDrawingDoc`, `_handleIncomingWsMessage`, `_broadcastElementDelta`, `onChange`, `_scheduleWsBroadcast`, etc. | When you need to know what the running plugin is doing on a given code path. |
| `page.on('console', ...)` in a Playwright/CDP test | All `console.*` calls in the page, including the probe. | Capture the probe output in a test. The `tests/sync/*.mjs` scripts already wire this up; if you write a new test, copy the `msgs.push(...)` pattern from `T1T3-baseline.mjs`. |
| The `__excalDebug.Excalidraw` global on the page | `getSessionInfo()` → `{ recordGuid, elementCount, wsAvailable }`. `injectWsMessage(fakeMsg)` to simulate a remote delta. `getPluginGuid()`. | Cross-tab sync tests, sanity checks that the panel is mounted. **There is no `getSavedScene` on this object** — for that, go to MCP. |
| Thymer MCP (the `thymer_*` tools) | The persisted record, properties, collections, the plugin code on disk. | Anything you need to verify or mutate in the workspace database. See §3 below. |

You will usually combine all four: probe + capture + debug global + MCP.

---

## 2. The probe pattern (most important skill)

You cannot read the plugin's runtime state directly. To see what
the plugin is actually doing, you add a `console.log` to the
source, rebuild, redeploy, and read the page's console.

### 2.1 — Add a probe to a function

Pick the function on the code path you care about and add a
`console.log` that prints the values you need. Example from the
bug-3 fix:

```js
// in _broadcastElementDelta
console.log(`[${EXCAL_PLUGIN_NAME}] DIAG _broadcastElementDelta ` +
  `currentN=${currentElements.length} ` +
  `prevN=${prev.size} ` +
  `deltaN=${delta.length} ` +
  `firstCurrent=${currentElements[0] ? `id=${currentElements[0].id} v=${currentElements[0].version}` : 'none'} ` +
  `firstPrev=${prev.values().next().value ? `id=${prev.values().next().value.id} v=${prev.values().next().value.version}` : 'none'} ` +
  `EXCAL_VERSION=${EXCAL_VERSION}`);
```

The `EXCAL_VERSION` field is critical — see §2.4.

### 2.2 — Rebuild

```bash
cd ThymerExcalidraw
npm run build:quick   # = node dev.js --once, no lint
```

This writes `dist/plugin.js`. Confirm:

```bash
node scripts/verify-fixes.mjs
# Length: 188959
# Has _drawingsCollectionRef: true
# ...
# EXCAL_VERSION: 0.5.5
```

### 2.3 — Deploy to the RIGHT workspace

The deploy script auto-discovers a workspace, but it may not be
the one the test Chrome is bound to. **Always set
`THYMER_WS_GUID` explicitly** to the workspace the test Chrome is
on. For Harry's workspace:

```powershell
$env:THYMER_WS_GUID = "WKXP9WA3F5TCTMV5PS747QVV8H"
$env:THYMER_DEBUG_PORT = "9223"
npm run push
```

You can confirm the workspace the test Chrome is on by reading
the page URL or by calling `getWorkspaceInfo` via the agent's MCP
tool.

If you forget `THYMER_WS_GUID`, the deploy silently goes to a
different workspace. The plugin reports "Plugin deployed
permanently" but the running Chrome still has the old code. This
costs an hour to diagnose because the agent's MCP tools still
work — they're just talking to a different instance.

### 2.4 — Verify the probe is actually running

The `EXCAL_VERSION` log line in the probe is the canary. After
redeploy, the test should show the new version. If it still shows
the old one, the probe is not running — the plugin in Chrome
hasn't been replaced. Re-check the workspace, hot-reload, and
the agent's `THYMER_WS_GUID`.

A second canary: add a unique tag to the probe message, e.g.
`v0.5.5-r2`. Searching the captured console for that string
proves the new code is live.

### 2.5 — Capture the probe output in a test

Existing tests do this. If you write a new one:

```js
const msgs = [];
page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
// ... drive the scenario ...
// Filter for your probe
const probeLines = msgs.filter((m) => /DIAG myProbe/.test(m.text));
console.log(probeLines.map((m) => m.text).join('\n'));
// Or save them to the report
writeReport('my-test', { probe: probeLines.map((m) => m.text) });
```

For one-off debugging, prefer printing to the test stdout so you
can read it directly:

```bash
node tests/sync/my-debug-test.mjs 2>&1 | Select-String "DIAG myProbe"
```

### 2.6 — Remove the probe before committing

A `console.log` of `EXCAL_VERSION` is fine to leave in for
verification. Anything that dumps element data, full scene
JSON, or any other large structure should be removed before the
final commit — it slows down the running plugin and floods the
console.

---

## 3. MCP access (the "what actually landed in the database" channel)

The agent has direct access to the Thymer MCP tools. Use them.
The raw JSON-RPC bridge at `http://127.0.0.1:13100` exists, but
its tool names are short (`get_record`, not `thymer_get_record`)
and `tools/call` against it returns "Unknown tool: ...". Use the
agent's MCP tools — they work.

### 3.1 — Read the saved record

```
thymer_get_record(workspace="WKXP9WA3F5TCTMV5PS747QVV8H",
                  record="195DTS7JK11ECZXKKSP1MB6S4Z",
                  format="structured")
```

The `Scene` property is a `["text", <json-string>]` tuple. Parse
the string to inspect the saved scene.

### 3.2 — Reset the scene for a clean test

```
thymer_update_record_property(
  workspace="WKXP9WA3F5TCTMV5PS747QVV8H",
  record="195DTS7JK11ECZXKKSP1MB6S4Z",
  property="Scene",
  value=<blank-scene-json>)
```

Blank scene value (with the proper `v: 3` and `sourceRecordGuid`
wrapper so the plugin can read it back):

```json
{"v":3,"sourceRecordGuid":"<source-record-guid>","updatedAt":"<iso>","scene":{"sceneJson":"{\"type\":\"excalidraw\",\"version\":2,\"source\":\"https://harry.thymer.com\",\"elements\":[],\"appState\":{\"viewBackgroundColor\":\"#ffffff\",\"theme\":\"light\"},\"files\":{}}"}}
```

If the plugin reloads the panel after the reset, it should show
an empty canvas. If it doesn't, the plugin is caching the prior
state somewhere — check the plugin's `localStorage` keys (search
`EXCAL_DRAW_PREFIX` in the source for the cache key format).

### 3.3 — Read a specific field of the saved scene

If you only want one element out of the saved scene, fetch the
record (full doc is in the response) and parse the inner
`sceneJson` string with `JSON.parse(JSON.parse(text).scene.sceneJson)`.
Look for `id`, `type`, `points.length`, `version`, `versionNonce`.

---

## 4. Cross-tab debugging (the bug-3 setup)

The two-tab test was the most useful diagnostic harness in the
v0.5.5 session. To reproduce any cross-tab sync bug:

### 4.1 — Two tabs, one context

```js
import { connectBrowser } from '../lib/cdp.mjs';
const browser = await connectBrowser();
const ctx = browser.contexts()[0];
const pageA = ctx.pages()[0];
const pageB = await ctx.newPage();
```

The `BrowserContext` must be shared (otherwise cookies differ
and tab B opens logged out). Open both pages on the same record
via `openRecordBySidebarClick(page, recordGuid)` (NOT
`page.goto('?open=...')` — see gotcha 4 below).

### 4.2 — Open Excalidraw on both

```js
for (const [label, page] of [['A', pageA], ['B', pageB]]) {
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
}
```

### 4.3 — Drive one tab, read both

Draw on A with the `p` tool, then `await sleep(4000)` for sync.
Read both scenes with `readSceneElements(page)`. Diff them — if
A and B disagree on the same `id`, the merge / broadcast layer
is the bug.

### 4.4 — Pair with probe

Add a probe to `_broadcastElementDelta` that logs
`currentN/prevN/deltaN/firstCurrent.v/firstPrev.v` (see §2.1).
If `deltaN=0` but `firstCurrent.v !== firstPrev.v` should have
been a change — **the snapshot was mutated in place**. Clone.

---

## 5. The twelve gotchas (each costs an hour)

### 5.1 — `preview_plugin` may not replace the running instance

The deploy script uses `preview_plugin` for hot-reload and then
`update_plugin_code` to persist. After `npm run push` reports
"Plugin deployed permanently", the running Chrome may still be
on the old code. The probe `EXCAL_VERSION` is the only way to
confirm. If your probe doesn't show up, hot-reload is stale.

**Fix:** check `THYMER_WS_GUID`, redeploy, re-run, look for
`EXCAL_VERSION` in the probe output.

### 5.2 — `npm run push` deploys to the wrong workspace by default

The script auto-discovers via `list_workspaces`, which can return
a workspace other than the one the test Chrome is on (e.g., the
MCP server's "active" workspace, which differs from the
test-Chrome's currently focused workspace).

**Fix:** always set `THYMER_WS_GUID` to the workspace the test
Chrome is on (look at the page URL or the agent's
`list_workspaces` output).

### 5.3 — Agent's MCP tool names have `thymer_` prefix; the JSON-RPC bridge at 13100 doesn't

Use the agent's `thymer_*` tools (they're listed in your tool
palette). If you try to call `thymer_get_record` against
`http://127.0.0.1:13100` directly you get `"Unknown tool:
thymer_get_record"`. The bridge exposes them under the short
name `get_record` instead — and many tools differ.

**Fix:** just use the agent's MCP tools in the chat, not the
raw bridge.

### 5.4 — `?open=...` deep-link opens a Chrome "Open Thymer?" popup

Chrome interprets `https://harry.thymer.com/?open=...` as a
custom protocol handler and shows a "Open this application"
prompt. The prompt blocks Ctrl+P, so the test can't open the
Excalidraw palette and gets `session: null`.

**Fix:** in tests, navigate to the home page first, then click
the record in the sidebar (`openRecordBySidebarClick`). This
bypasses the deep-link handler entirely. The MCP read tools
don't have this problem.

### 5.5 — The plugin instance is hidden in the page's bundle

The plugin is a closed-over class instance reachable through
`window.refreshPlugin` and the `__excalDebug.Excalidraw` global,
but NOT through `window.SomePluginClass`. You cannot poke at
`this._saveDrawingDoc` or `this._flushPanelSession` from the
test directly.

**Fix:** instrument with a probe (see §2). The probe is the
only way to inspect plugin internals.

### 5.6 — `readPersistedSceneViaMcp` in `tests/lib/mcp-scene.mjs` is a stub

It returns `null`. The test catches the error and falls back
to "no DB check". If you want to assert against the saved
scene, call the agent's `thymer_get_record` from the chat (or
from a test that uses the agent's MCP). The stub was left
because the Node-side MCP plumbing wasn't worth the test
infrastructure cost.

### 5.7 — `__excalDebug.Excalidraw` only exposes three methods

```js
{
  getPluginGuid: () => string,
  getSessionInfo: () => ({ recordGuid, elementCount, wsAvailable }),
  injectWsMessage: (msg) => void,  // simulate a remote delta
}
```

There is no `getSceneElements` and no `getSavedScene`. For
scene inspection, use `readSceneElements(page)` (which walks the
React fiber on `.excal-panel-stage canvas`'s parent) or the
agent's MCP `thymer_get_record`.

### 5.8 — `lastBroadcastElements` shares references with Excalidraw

This is the bug-3 root cause and worth its own entry.

The Excalidraw elements array returned by
`session.excalApi.getSceneElements()` shares the *same
element objects* with Excalidraw's internal state. When the
plugin stores one of those elements in
`lastBroadcastElements` and Excalidraw later mutates the
element (e.g., the user keeps drawing — version bumps from 3
to 4 to 5 …), the `lastBroadcastElements` snapshot
"follows" the mutation because it's the same object.

Result: every subsequent broadcast's `prevEl.version ===
el.version` is `true` (same object), so the delta filter
thinks nothing has changed and the WS message is empty.
Tab A draws; tab B sees only the very first broadcast
captured at v=3 and is stuck with a dot.

**Diagnostic pattern:** in `_broadcastElementDelta`, log
`firstCurrent.v` and `firstPrev.v` along with `deltaN`. If
the broadcast is firing but `deltaN=0` while the element
version is clearly changing in the saved scene, the snapshot
is being mutated. **Fix:** shallow-clone the element
(including its `points` array) when storing it in the
snapshot map.

This is a generic trap: any JS code that caches "the last
value of an object" and compares it later with `===` or by
property reads needs to clone, not store the reference, when
the underlying library mutates in place. Excalidraw does.
React fiber data does. Most state containers do. Be
paranoid.

### 5.9 — Bug-3 trap has **four more re-seed sites** besides the broadcast

This is bug 6. The v0.5.5 fix applied the clone in
`_broadcastElementDelta` and the shape sync bug went away —
but the trap was lurking in four more places that all
re-populate `session.lastBroadcastElements` from
`excalApi.getSceneElements()`:

| Site | When it fires |
|---|---|
| `_setupRealtimeListeners` | Panel boot, initial seed from the loaded scene |
| `_handleIncomingWsMessage` | After applying a remote delta |
| `_handleRemoteRecordUpdated` | After applying a remote DB save |
| `_handleReload` | After applying the local record at boot |
| `_broadcastElementDelta` | After sending a delta (the original site) |

All five must clone. The fix in v0.5.6 round 2 extracted a
`_cloneElementSnapshot(el)` helper and applied it to all
five sites. Without this, a move on tab B after a draw on
tab A silently no-ops: tab B re-seeds the snapshot with
live refs when it receives tab A's draw, then when the user
moves on tab B, the next broadcast sees
`prevEl.version === el.version` (same object) and emits an
empty delta. Tab A never gets the move.

**Diagnostic pattern:** if A→B sync works but B→A sync
fails after a draw on A, suspect a re-seed site on B that
stored live references. Add a probe that compares
`prevEl === currentEl` (identity check) in
`_broadcastElementDelta`. If true, the snapshot is the same
object as the live element, and the delta filter is being
defeated.

### 5.10 — Layer order is array order; the delta doesn't carry it

This is bug 7. Excalidraw uses the **elements array order**
as the z-order: later in the array = on top of earlier.
"bring to front" / "send to back" are array rearrangements.
The moved element's version bumps and goes into the WS
delta, but the **array position** is not part of the delta.
The receiver's `_mergeSceneElements` preserves local order
and only updates the per-element data, so the z-order
change is dropped. Visible symptom: "the shape moves on
tab B but stays in the same z-position on tab A".

**Diagnostic pattern:** after a reorder on tab B, log the
array order on both tabs. If tab A has the new per-element
data (e.g., the moved element's `x`/`y`) but the original
array order, the merge is preserving local order and the
z-order change is dropped.

**Fix:** add `sceneOrder: [...ids]` to the WS broadcast
(the full current array order, not just the delta), and
on the receive side apply it only when both:
1. The order actually differs from local.
2. At least one incoming element is newer than its local
   counterpart (so a stale broadcast can't override a
   fresher local reorder — same LWW-by-version contract
   that already gates the per-element merge).

The "newer" check is essential. Without it, a slow tab B
receiving tab A's old broadcast could re-layer its own
fresher ordering back to A's stale state.

### 5.11 — Right-click in the panel opens **two** context menus

This is bug 8. Excalidraw is mounted in-page as a React
root inside `.excal-panel-shell` → `.excal-panel-stage` →
`.excal-host` → `<canvas>`. A right-click fires
Excalidraw's own `contextmenu` handler on the canvas
(correct — shows the Excalidraw element/canvas menu), but
the **same `contextmenu` event** also bubbles up to
`document`, where Thymer's host has a context-menu
listener that opens the note-action menu (Cut, Copy,
Paste, Add block, etc.). Both end up open at once. The
top one is occluded by the other depending on z-order, so
the user often sees the wrong menu — clicking on what they
think is "Bring to front" actually pastes text into the
note.

**Why there's no SDK hook for this:** the `events.on(...)`
API in the plugin only exposes `panel.navigated`,
`panel.focused`, `panel.closed`, `record.updated`,
`reload` (see `plugin.js:2580-2600`). The
`docs/thymer-sdk-api.md` reference also has no
context-menu event. The only fix is a DOM-level capture-
phase listener on the panel's own shell that calls
`e.stopPropagation()`.

**Fix in v0.5.7:** added `_installContextMenuGuard(shellEl,
session)` (capture-phase listener on `.excal-panel-shell`
calling `e.stopPropagation()`). Capture phase is critical —
it runs before the bubble reaches `document`. Excalidraw's
own canvas-level handler still runs (downstream of the
shell, sees the event). The host's document-level handler
does not (upstream, never sees it). Teardown wired into
`_teardownRealtimeListeners`.

**Why not also suppress in the iframe fallback:** the
excalidraw.com iframe is a separate origin — the inner
Excalidraw menu is unreachable from the host page, so the
guard would only suppress Thymer's menu and leave the
user with no menu at all. Skip the guard in the iframe
mount path (`_mountIframeEditor`).

**Diagnostic pattern:** if the user reports "wrong menu
opens on right-click inside the panel" or "two menus on
top of each other", probe the live DOM:
```js
const shell = document.querySelector('.excal-panel-shell');
const hasGuard = shell?.__excalContextMenuGuard ||
                 Object.keys(shell || {}).some(k => k.startsWith('__excal'));
// If hasGuard is false, the listener was not installed.
// Check: was the panel mounted via the React path?
// (iframe path skips the guard by design)
```
Or instrument: in `__excalDebug`, add a counter that
increments each time `_installContextMenuGuard` is called
and each time the listener fires. If the listener is
installed but the count is 0 when a right-click happens,
the event isn't reaching the shell — check that the
click is genuinely inside the panel.

### 5.13 — Excalidraw's first onChange events fire with empty elements (v0.6.1)

This is the **mount-echo data-loss bug** the user reported
2026-07-01. Symptom: open a panel for a note that already has
drawing data; the autosave (or a pagehide / visibilitychange
flush) writes `elements:[]` to the DB and the localStorage
mirror, blanking out the user's work. The data is only
recoverable if a different browser still has a stale
localStorage mirror, or via Thymer's per-record version
history (📋 Show Data button, shipped in v0.6.0).

**Why it happens.** Excalidraw (the React `<Excalidraw>` mount
path) fires `onChange` with `elements: []` *while it's still
bootstrapping* — *before* `initialData` is applied. After
`initialData` lands, it fires `onChange` again with the
loaded elements. The pre-v0.6.1 plugin treated both waves as
real edits and set `pendingScene` to whatever was in
`elements`, so the 400ms autosave debounce (or a quick
pagehide) wrote the empty scene.

The onChange handler's echo guard
(`Date.now() - (lastRemoteApplyMs || 0) < EXCAL_ECHO_GUARD_MS`)
was supposed to suppress this, but `lastRemoteApplyMs` was
initialised to `0`, so the guard
`Date.now() - 0 < 500` is trivially false. The guard only
ever fired for echoes of *remote* updates, never for the
mount's own onChange.

**Smoke-test pattern** — open the console, filter for
`DIAG: onChange` while opening a fresh panel:

```
[Excalidraw] DIAG: onChange 0 els, applyingRemote=false echoSuppressed=false   ← bad
[Excalidraw] DIAG: onChange 0 els, applyingRemote=false echoSuppressed=false   ← bad
[Excalidraw] DIAG: onChange 0 els, applyingRemote=false echoSuppressed=false   ← bad
[Excalidraw] DIAG: onChange 10 els, applyingRemote=false echoSuppressed=false  ← loaded
```

Post-v0.6.1 the first three lines should show
`echoSuppressed=true` (Layer 1), or `mountEcho=true` (Layer
2), or in the worst case the autosave refuses to write
because of Layer 3. The four-line baseline in
`tests/baseline/T1T3-baseline.json` is the canonical
reproducer.

**Fix in v0.6.1 (three layers, defense in depth):**

1. **Layer 1 — seed `lastRemoteApplyMs` to `Date.now()`** in
   `_openDrawingPanelWithSession`. The existing 500ms echo
   guard now actually fires at mount. Catches the typical
   case where Excalidraw's first-wave onChange events all
   land within ~100ms of the panel mount.
2. **Layer 2 — initial-scene signature** snapshot taken
   right after `_buildInitialData` in `_mountDrawingPanel`.
   In the onChange handler, if the live scene's id
   signature (`length + sorted ids`) matches the loaded
   signature, skip the save. Catches echoes that arrive
   after the 500ms window expires (e.g. slow CDN load,
   large UMD bundle).
3. **Layer 3 — empty-over-populated hard block.** When
   `session._hadNonEmptyInitialData === true` and the live
   scene has 0 elements with no `deletedIds`, refuse the
   save unconditionally and `console.warn`. The same guard
   is mirrored in `_flushPanelSession` so the pagehide /
   visibilitychange / `panel.closed` force-flush paths
   cannot bypass it. This is the strongest layer — even if
   Layers 1+2 regress, an empty scene will never overwrite
   populated data.

**Diagnostic pattern** if a "blank canvas on open" bug
returns in the future:

```js
// In the page console, on opening a panel that already has data:
const panel = document.querySelector('.excal-panel-shell');
const session = panel?.__excalSession; // if exposed
const db = await fetch('/api/...').then(r => r.json());
const live = session?.excalApi?.getSceneElements();
console.log('DB:', db?.scene?.sceneJson?.length, 'LIVE:', live?.length);
// If DB > 0 and LIVE === 0: mount-echo regression
```

Or — more pragmatically — filter the console for
`empty-over-populated` after opening a populated panel.
A `console.warn` of that form means the guard caught an
attempted data-bleach; the DB should be intact. A
`console.warn` of the form `mount-echo suppressed` is
normal and expected.

### 5.12 — The save format and the load format don't match (bug 9, v0.5.8 root cause)

This is the most expensive misdiagnosis in the v0.5.x line —
a "the canvas loads blank" symptom that was misattributed
to record matching (v0.5.7's multi-collection search and
`excalidrawing` fallback) when the actual break was one
layer down, in the scene parser.

**The save side** (`_serializeScene` → `_saveDrawingDoc`)
writes the v3 doc as:

```
{ v:3, sourceRecordGuid, updatedAt, scene: { sceneJson: "<JSON string>" } }
```

`sceneJson` is a *string* (the output of
`lib.serializeAsJSON(elements, appState, files, 'local')`).
It is stored at `doc.scene.sceneJson`, not at the top
level.

**The load side** (`_buildInitialData` + `_sceneDocHasContent`)
checked:

1. `doc.sceneJson` — top-level sceneJson. Used by the
   legacy `{ v:1, sceneJson: "..." }` flat format.
2. `doc.scene.elements` — direct array. Used when
   `serializeAsJSON` is unavailable and the scene is
   stored as `{ elements, appState, files }` directly.

**Neither branch handled the v3 format** where the
elements live inside `doc.scene.sceneJson` (a nested
JSON string). The function returned `null` on every load
of a React-mount save. Excalidraw started with an empty
canvas, `elementCount: 0`, status "Ready" instead of
"Loaded". Every saved drawing appeared blank.

**Why the misdiagnosis was so convincing:** the v0.5.7
record-matching work added a `console.warn` at the end
of the no-match path, but the warning never fired
during testing. That *felt* like "matching must be
working then" — but the correct inference was "the
warning never fires because the record IS being found,
the bug is downstream". The record-matching
enhancements were solving a real problem (the cache-null
no-re-query, the undefined `_isDrawingsCollection` typo)
but they were not the cause of the blank canvas.

**Symptom profile that should have pointed here:**

- "Desktop opens drawing → blank."
- "New shape on other instance → appears on desktop."
- "Old shapes → never appear."
- "Move old shape on other instance → moved shape
  'appears' on desktop."

That profile is a *load* bug, not a *sync* bug. WS
sync bypasses the load path (`updateScene` adds the
element directly), which is why cross-tab changes
"appear" while same-tab saved changes "don't". The
load path was the broken layer.

**Fix in v0.5.8:** added a `doc.scene.sceneJson` branch
in both `_buildInitialData` (parses the nested JSON
string through `lib.restore()` and returns the
restored elements) and `_sceneDocHasContent` (parses
the nested string and checks for non-deleted elements).
The save format was not changed — backward-compatible
with all existing saved drawings (the `doc.scene.sceneJson`
structure has been the v3 format since before v0.5.0;
the load function just never handled it).

**Three secondary defects also fixed in v0.5.8:**

1. **`_isDrawingsCollection` was undefined** (line 3437).
   The intended method is `_collectionLooksLikeDrawings`
   (line 2702). The `try/catch` at line 3439 silently
   swallowed the `TypeError`, so the "search ALL
   Excalidrawings collections" enhancement in
   `_getAllDrawingsCollections` was dead code — it
   returned only the primary collection. Renamed the
   call to the existing method.
2. **Cache-null re-query.** `if (this._drawingRecordCache.has(sourceGuid))
   return this._drawingRecordCache.get(sourceGuid) || null`
   returned `null` immediately on a cached miss, so a
   transient failure could permanently poison the
   cache for the rest of the session. Fixed by
   returning early only on a truthy cache hit; a cached
   `null` falls through to a fresh search.
3. **Backwards `excalidrawing` matcher removed** from
   `_findDrawingRecordBySourceGuid` (was lines 3372-3377).
   It checked `r.reference('excalidrawing') === sourceGuid`
   on the drawing record, but the `excalidrawing` field
   on the `Excalidrawings` collection is self-referential
   (`filter_colguid` points to itself), not
   source-pointing. The source→drawing link lives on
   the *source* collection's `excalidrawing` field,
   which is handled by the fallback at lines 3383-3398.
   The matcher was harmless but useless.

**Diagnostic pattern** if a "blank canvas" bug returns
in the future:

```js
// In the page console after opening a drawing:
const panel = document.querySelector('.excal-panel-shell');
const session = panel?.__excalSession; // if exposed
const dbScene = await fetch('/api/...').then(r => r.json());
// Compare dbScene.scene.sceneJson to what
// _buildInitialData receives. The fix is in the parser,
// not the finder.
```

Or, more pragmatically: add a `console.log` at the
top of `_buildInitialData` that dumps `JSON.stringify(doc).slice(0, 200)`.
If the dump shows `"sceneJson": "..."` (nested under
`scene`), the function is in the broken pre-v0.5.8
state and needs the `scene.sceneJson` branch added.

### 5.14 — Stale empty localStorage can override populated DB (v0.6.2)

This is the data-loss gotcha the v0.6.2 fix targets. The user
reports "A shows blank canvas; B's moves appear on A." The chain:

1. A and B share localStorage (same origin, same browser).
2. Before v0.6.1, the mount-echo bug wrote `elements:[]` to both
   the DB and localStorage. v0.6.1 prevents new bleaches, but
   existing stale empty localStorage entries persist.
3. `_loadDrawingDoc` reads three sources and picks the newest by
   `updatedAt` (line 5077, pre-v0.6.2). A stale empty localStorage
   entry with a newer `updatedAt` than the DB wins — canvas loads
   blank.
4. The WS subscription (`_handleIncomingWsMessage`, line 5409)
   filters by `session.recordGuid` (the source note), so A still
   receives B's WS deltas. Moved objects appear on A's blank
   canvas.
5. A's autosave fires, writing the partial scene (B's delta only)
   to the DB — overwriting the populated scene.

**Fix stack in v0.6.2 (five layers, defense in depth):**

1. **Fix 1 — Content-aware merge** (`_loadDrawingDoc`, line 5100).
   If the DB has non-empty elements and localStorage is empty, the
   DB wins regardless of `updatedAt`. Stops the blank-on-load at
   the source.
2. **Fix 2 — Heal poisoned localStorage** (`_mountDrawingPanel`,
   line 4613). After a successful load, write the DB doc back to
   localStorage. Clears poisoned entries for every subsequent load
   on that browser.
3. **Fix 3 — Block WS deltas when load failed**
   (`_handleIncomingWsMessage`, line 5428). If
   `session.drawingRecordGuid` is null (load returned empty),
   skip the delta and call `_reloadDrawingDoc` instead. Prevents
   partial-scene accumulation on a blank canvas.
4. **Fix 4 — DB-aware save guard** (onChange handler line 3899,
   `_flushPanelSession` line 5735). Compare live element count
   against `session._dbSceneElementCount` (tracked from the DB at
   load time). If the live scene has fewer elements and no explicit
   deletions, refuse the save. This is the strongest layer — even
   if all other layers regress, a partial scene can never overwrite
   the populated DB.
5. **Fix 5 — WS filter also matches `drawingRecordGuid`** (line
   5425). The WS filter now checks both `session.recordGuid` and
   `session.drawingRecordGuid`, ensuring cross-tab sync arrives
   in all cases.

**Diagnostic pattern** if a "blank canvas on A, B's moves appear
on A" bug returns:

```js
// In the page console on instance A, after opening a populated panel:
const key = 'excal_draw_v1_' + session.recordGuid;
const ls = JSON.parse(localStorage.getItem(key) || '{}');
const dbEls = ls?.scene?.sceneJson ? JSON.parse(ls.scene.sceneJson)?.elements?.length : 0;
console.log('localStorage elements:', dbEls, 'live elements:', excalApi.getSceneElements().length);
// If localStorage has 0 and live has >0 — DB-wins kicked in, good.
// If localStorage has 0 and live has 0 — check _reloadDrawingDoc fired.
```

Or, add a probe to `_loadDrawingDoc` just before the return:
```js
console.log(`DIAG load: fromCollection=${!!fromCollection}(${fromCollection?._countDocNonDeleted?.(fromCollection)}) fromRow=${!!fromRow} fromLocal=${!!fromLocal}(${fromLocal?._countDocNonDeleted?.(fromLocal)}) picked=${picked === fromCollection ? 'collection' : picked === fromRow ? 'row' : 'local'}`);
```

---

## 6. Worked example: debugging bug 3 end-to-end

This is the exact path the v0.5.5 round-2 fix took.

### Symptom

User reports: "On one tab the same drawing is a stroke, on the
other tab the same object is a dot."

### Step 1 — Reproduce

`tests/sync/twotab-sync.mjs`: open two tabs, draw on A, read
both. Result:

```
A: points: 26, v: 27 (the full stroke)
B: points: 2,  v: 3  (the partial captured at v=3)
divergent: [1 element]
```

### Step 2 — Check the broadcast counts

```
aBroadcasts: 1
bWSRecv:     1   (one of A's broadcasts, applied once)
```

Only **one** broadcast. Yet the user drew for 300ms with
`onChange` firing every 12ms. Should have been 4–5 broadcasts.

### Step 3 — Add a probe to `_broadcastElementDelta`

```
DIAG _broadcastElementDelta currentN=1 prevN=1 deltaN=0
  firstCurrent=id=… v=19 firstPrev=id=… v=19
```

The `deltaN=0` is the smoking gun. The current and prev
versions are equal — the snapshot has drifted to match the
current.

### Step 4 — Verify the root cause

The snapshot is stored by reference. Excalidraw mutates the
element in place when the user keeps drawing. The snapshot's
`prevEl.version` therefore follows the live `el.version`.
`prevEl.version === el.version` is always true, delta is
always empty, broadcasts are always no-ops.

### Step 5 — Fix

In `_broadcastElementDelta`, replace

```js
prev.set(el.id, el);
```

with

```js
prev.set(el.id, { ...el, points: Array.isArray(el.points) ? el.points.slice() : el.points });
```

And in `_scheduleWsBroadcast`'s initial seeding, do the same.

### Step 6 — Also fix the throttle-callback conditional

While we're here: the setTimeout in `_scheduleWsBroadcast`
only broadcast if `wsPendingBroadcast` was set. The new
code always broadcasts in the callback; the broadcast itself
short-circuits if the delta is empty.

### Step 7 — Rebuild, deploy, re-run

```
npm run build:quick
THYMER_WS_GUID=WKXP9WA3F5TCTMV5PS747QVV8H npm run push
node tests/sync/twotab-sync.mjs
```

Result: 17 broadcasts from A, 17 WS messages received on B,
`divergent: []`, both tabs `points: 26, v: 27`.

### Step 8 — Remove the diagnostic probe

Keep the `EXCAL_VERSION` log in the probe (useful canary).
Remove anything that dumps element data.

---

## 7. Quick checklist for "the plugin isn't doing what I expect"

1. Does the in-page plugin show `EXCAL_VERSION=0.5.8` in its
   console output? If not, redeploy with `THYMER_WS_GUID`
   set explicitly. See §2.4.
2. Are the broadcasts firing? Count `DIAG: broadcasting` log
   lines during a drawing. If 1 instead of 4–5, look at the
   delta in `_broadcastElementDelta` — is it always 0?
3. Is the saved scene what you expect? Use the agent's
   `thymer_get_record` to fetch it. Compare to in-memory.
4. Are there duplicate `sceneJson` keys in the saved doc? If
   so, the duplicate-key fix in `_saveDrawingDoc` was
   reverted. v0.5.5 fixed this.
5. For two-tab sync, do both tabs converge? If not, run the
   two-tab test and look at `divergent` array. The
   `currentN/prevN/deltaN` probe tells you whether the
   broadcast is firing with a non-empty delta.
6. Does `getSessionInfo().elementCount` on the panel match
   the saved scene count? If not, the autosave is delayed
   (check `setPanelStatus` for "Saving…" / "Changes saved").

---

## 8. Files & APIs quick reference

| Path | What it does |
|---|---|
| `plugin.js` | The bundle entry. `EXCAL_VERSION` at line 2429, `EXCAL_WS_THROTTLE_MS` at line 2451, `EXCAL_ECHO_GUARD_MS` at line 2453, `_cloneElementSnapshot` at line 2532, `isDegenerateElement` at line 2460. `_serializeScene` at line 4483. `_saveDrawingDoc` at line 4793. `_handleIncomingWsMessage` at line 5068. `_mergeSceneElements` at line 5198. `_broadcastElementDelta` at line 5007. `_scheduleWsBroadcast` at line 4980. |
| `plugin.json` | Plugin metadata. Version field must match `EXCAL_VERSION`. `custom.autosaveMs` controls autosave debounce. |
| `dist/plugin.js` | Build output. Bundled and minified. **This is what runs in the browser.** |
| `tests/sync/*.mjs` | Test scripts. `T1T3-baseline.mjs` is the canonical save-round-trip test. `twotab-sync.mjs` is the cross-tab sync test. |
| `tests/baseline/*.json` | Reports from the test runs. Inspect `diags.broadcasts`, `diags.onChange`, `newElements`, `dbScene` for a summary. |
| `tests/lib/cdp.mjs` | Playwright-core CDP helpers. `connectBrowser`, `getThymerTab`, `getThymerTab`-style helpers. |
| `tests/lib/harness.mjs` | `waitForExcalSession`, `readSceneElements` (walks React fiber), `openRecordBySidebarClick`, `openExcalViaCommandPalette`, `writeReport`. |
| `tests/lib/mcp-scene.mjs` | STUB. Returns `null`. Replace with a Node-side MCP call if you need DB readback in tests. |
| `scripts/deploy-plugin.mjs` | The `npm run push` script. `preview_plugin` → `update_plugin_code` → `update_plugin_json_config`. Reads `THYMER_WS_GUID` from env. |
| `scripts/verify-fixes.mjs` | Cheap smoke test on the source. `EXCAL_VERSION` is the headline. |
| `dev.js` | `node dev.js` watches plugin.js and hot-reloads via `window.refreshPlugin`. |

---

## 9. Things to NOT do

- Don't try to read the plugin's instance from the page. It's
  a closed-over closure. Use the probe.
- Don't `page.goto(?open=...)` from a test. The Chrome
  "Open Thymer?" popup will block Ctrl+P. Use
  `openRecordBySidebarClick` instead.
- Don't trust `npm run push` to deploy to the test workspace.
  Set `THYMER_WS_GUID` explicitly. Verify with a probe
  `EXCAL_VERSION` log.
- Don't use the raw JSON-RPC bridge at 13100 with `thymer_*`
  tool names. The bridge uses short names. Use the agent's
  MCP tools instead.
- Don't assume `__excalDebug.Excalidraw` exposes the full
  plugin API. It only has `getPluginGuid`, `getSessionInfo`,
  `injectWsMessage`.
- Don't store object references from Excalidraw and expect
  them to stay still. Clone.
