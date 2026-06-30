# Testing the ThymerExcalidraw Plugin

> **Status:** Live integration tests for the Excalidraw plugin running
> inside a real Thymer workspace. Tests use Chrome DevTools Protocol
> (CDP) over `playwright-core` to drive the browser, and the Thymer
> MCP server to read/write the workspace database.
>
> **Read this first if you are an agent asked to:** add a regression
> test, reproduce a sync bug, or verify a fix. The infrastructure is
> already wired up — you only need to write a new test or run an
> existing one.
>
> **Debugging tips (probe pattern, MCP quirks, gotchas, worked
> example):** see [DEBUG.md](DEBUG.md).

---

## 1. The 30-second quickstart

```bash
# 1. Make sure a test Chrome is running with the debug port
#    (see §3 for setup; you only do this once per machine).
#    The test harness expects port 9223 by default.

# 2. Run a test
cd ThymerExcalidraw
node tests/sync/T1T3-baseline.mjs

# 3. Read the result
cat tests/baseline/T1T3-baseline.json
```

That's it. The test connects to the existing Chrome, navigates to
Thymer, opens the Excalidraw command via the palette, and runs the
scenario.

---

## 2. Architecture of the test harness

```
┌────────────────────────────────────────────────────────────┐
│ Your test (tests/sync/T*.mjs)                              │
│                                                            │
│  ┌─────────────────┐    ┌──────────────────────────────┐   │
│  │ tests/lib/      │    │ tests/lib/harness.mjs        │   │
│  │ cdp.mjs         │    │  waitForExcalSession()       │   │
│  │ (playwright-    │    │  openRecordBySidebarClick()  │   │
│  │  core CDP       │    │  openExcalViaCommandPalette()│   │
│  │  connection)    │    │  readSceneElements()         │   │
│  └────────┬────────┘    │  injectWsDelta()             │   │
│           │             │  openSecondContext()         │   │
│           ▼             └──────────┬───────────────────┘   │
│  localhost:9223 (Chrome with         │                      │
│  --remote-debugging-port)            ▼                      │
│           │             injectWsMessage via globalThis    │
│           │             ┌──────────────────────────────┐   │
│           │             │ harry.thymer.com workspace   │   │
│           │             │  __excalDebug.Excalidraw      │   │
│           ▼             │   .injectWsMessage(fakeMsg)   │   │
│     page.evaluate()     │   .getSessionInfo()           │   │
│     console listener    │   .getPluginGuid()            │   │
│                        └──────────────────────────────┘   │
│                                                            │
│  ┌────────────────────────────────────────────────────┐   │
│  │ Thymer MCP server (separate from browser)          │   │
│  │  thymer_get_record, thymer_navigate_to_record,    │   │
│  │  thymer_list_collections, etc.                     │   │
│  │  Used to read the persisted DB scene and           │   │
│  │  verify what actually landed in the database.      │   │
│  └────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**Two channels, one truth:** the browser test runs the live plugin
in a real workspace; the MCP read returns what the database actually
has. Diff the two to catch bugs where the in-memory state and the
persisted state disagree.

---

## 3. One-time machine setup

### 3.1 — Launch a dedicated test Chrome instance

The user's main Chrome usually runs **without** the remote debug
port. Tests need a separate Chrome with `--remote-debugging-port`.
Use a separate user-data-dir so the test session doesn't pollute
the user's profile.

**Windows (this machine):**
```powershell
$testProfile = "C:\Users\likkmrl\AppData\Local\Google\Chrome Dev Test"
if (-not (Test-Path -LiteralPath $testProfile)) {
  New-Item -ItemType Directory -Path $testProfile | Out-Null
}
Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -ArgumentList @(
    "--remote-debugging-port=9223",
    "--user-data-dir=$testProfile",
    "--no-first-run",
    "--no-default-browser-check",
    "https://harry.thymer.com/"
  )
```

**macOS:**
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 \
  --user-data-dir="/Users/$USER/Library/Application Support/Google Chrome Dev Test" \
  --no-first-run \
  "https://harry.thymer.com/"
```

**Confirm the port is open:**
```bash
curl http://127.0.0.1:9223/json/version
# -> {"Browser":"Chrome/149.0.7827.197",...}
```

### 3.2 — Log in to Thymer in the test Chrome

The test profile starts logged out. Log in once manually; the
session cookie persists. After that, every test reuses it.

### 3.3 — Install dependencies (already done in this repo)

```bash
cd ThymerExcalidraw
npm install    # installs playwright-core, chrome-remote-interface, esbuild, chokidar
```

`playwright-core` is the CDP wrapper (no browser download).
`chrome-remote-interface` is the lower-level CDP client used by
the deploy script.

---

## 4. The seven-line minimum test

```js
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession, readSceneElements, writeReport,
} from '../lib/harness.mjs';

const browser = await connectBrowser();
const page = getThymerTab(browser);
await page.goto('https://harry.thymer.com/?open=WS_GUID.RECORD_GUID#title');
// (open Excalidraw panel via Ctrl+P palette — see §5)
const session = await waitForExcalSession(page);
const scene = await readSceneElements(page);
console.log(scene);
writeReport('my-test', { session, scene });
await browser.close();
```

That's the entire pattern. The harness hides the brittle parts.

---

## 5. Critical gotchas (each one cost an hour to learn)

### 5.1 — The plugin only exposes `__excalDebug.Excalidraw` **after** a panel opens

Don't try to call `__excalDebug.Excalidraw.getSessionInfo()` from the
home page — it returns `null`. The plugin instance sets
`window.__excalDebug.Excalidraw` inside `_setupRealtimeListeners`
(`plugin.js:4884–4896`), which only runs when a drawing panel is
mounted.

**Wait pattern:** poll `globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.()`
every 200ms with a 15s timeout. Use `waitForExcalSession(page)`.

### 5.2 — The canvas is a red herring

Excalidraw renders shapes as **SVG**, not on the canvas. The canvas
element only handles pointer events. The 39 `<svg>` elements inside
`.excal-panel-stage` are the actual drawing.

To read scene elements, walk the React fiber from the canvas's
**parent** (the canvas itself has no React state — the fiber lives
on the wrapper). `readSceneElements()` already does this; just call
it.

### 5.3 — Ctrl+P is the command palette; Ctrl+K is also a palette but a different one

The Thymer command palette (which contains the
`Excalidraw: Open drawing for this note` entry) opens with
**Ctrl+Shift+P** *or* **Ctrl+P** — both work in current versions.
The exact key differs across releases; the test calls all three
and uses whichever opens `.cmdpal--input`.

After opening, **clear the input first** before typing the command
name — leftover text from prior runs will filter out your target.
```js
await page.keyboard.press('Control+p');
await page.waitForTimeout(600);
await page.keyboard.press('Control+a');
await page.keyboard.press('Delete');
await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
await page.waitForTimeout(800);
await page.keyboard.press('Enter');
```

### 5.4 — The record URL is `?open=WS_GUID.RECORD_GUID#title`, NOT `/record/...`

`https://harry.thymer.com/record/<guid>` redirects to a blank
"Thymer" page. The workspace's deep-link format is:
```
https://harry.thymer.com/?open=WORKSPACE_GUID.RECORD_GUID#title
```
For the test workspace + index record:
```
https://harry.thymer.com/?open=WKXP9WA3F5TCTMV5PS747QVV8H.159BTXS2GAEDEG4Z7EVRP2YK8J#index
```

The `#title` is optional but helps the page settle.

### 5.5 — Tab A and Tab B must share the same `BrowserContext`

Different contexts = different V8 realms = different cookies. The
test Chrome auto-logs in the first context; a `browser.newContext()`
starts logged out. For cross-instance sync tests, open a second
**page** (tab) in the same context, not a new context:
```js
const ctx = browser.contexts()[0];
const pageA = await ctx.newPage();
const pageB = await ctx.newPage();   // shares cookies with A
```

### 5.6 — Excalidraw's freedraw tool is the `p` key (or `6`), NOT `5`

Key `5` is the **line** tool. To get a freedraw stroke, press `p`
(pen) or `6`. The "5" → arrow confusion in the original T1 test is
a known footgun.

### 5.7 — Onchange fires ~40 times per second while idle

`DIAG: onChange N els` will log hundreds of times during any
non-trivial test. That's normal — Excalidraw fires on every render
commit, cursor move, and appState change. Filter by
`/DIAG: broadcasting/` (which is throttled to 80ms) when measuring
network activity, not by `onChange` count.

### 5.8 — The autosave is 1.5s; the bug it creates is the line→dot bug

If the user pauses mid-stroke for >1.5s, the autosave fires while
the freedraw element is in a degenerate state (1-5 points, partial
geometry). The v0.5.3 fix only filtered these at the
**broadcast** layer, not at the **save** layer — so the bad state
ends up in the database. T3 specifically reproduces this: pause
mid-stroke for 2.2s and the saved scene will have a truncated
stroke.

---

## 6. The existing test files

| File | What it does | Status |
|---|---|---|
| `T1T3-baseline.mjs` | Draw 2 freedraws (one with a 2.2s mid-stroke pause), compare in-memory scene to DB. **Reproduces bug 1 (line→dot).** | PASSES, exposes bug |
| `T1-draw.mjs` | Single stroke round-trip. Sanity check. | PASSES |
| `T2-idle.mjs` | Open panel, idle 20s, count broadcasts. **Reproduces bug 2 (version inflation).** | NEEDS to be re-run after fix |
| `T4-T8` | Two-tab sync tests. Stub-only. | TODO |
| `twotab-init.mjs` | Open same record on two tabs, both with Excalidraw open. Setup for T4-T8. | PASSES |
| `open-palette-ctrlp.mjs` | One-shot smoke test of the palette flow. | PASSES |
| `write-baseline.mjs` | Aggregates T1T3 results + MCP scene read into a single baseline JSON. | PASSES |
| `debug-canvas.mjs`, `deep-dom.mjs`, `find-rows.mjs`, `find-record.mjs`, `urls.mjs`, `probe.mjs`, `smoke.mjs`, `diag.mjs`, `deepprobe.mjs`, `palette-keys.mjs`, `click-excal.mjs`, `open-via-sidebar.mjs`, `open-record.mjs`, `find-record-els.mjs`, `palette-flow.mjs` | Throwaway probes used to discover the gotchas in §5. **Keep them as living docs of the things that didn't work and why.** | KEEP |

The most valuable files are marked **bold**; the rest are
archaeology. Don't delete the throwaways — they're the institutional
memory of which paths don't work and the comments in them document
the failed attempts.

---

## 7. Adding a new test

### 7.1 — Pick or create a test record

The current test uses the **index** record in the **Test Collection**
of the **Thymer-Cabinet sync** workspace. GUIDs:
- Workspace: `WKXP9WA3F5TCTMV5PS747QVV8H`
- Test Collection: `1H3Z8J1WYR0S4FPM967TR298GF`
- index record: `159BTXS2GAEDEG4Z7EVRP2YK8J`
- Tasks record: `1NQQENF9Y1GRCS8YKTHC8CRBKR` (known dirty data)
- Documents record: `1VQWJDWE9TR8KN4V1Y9ZC1Z4EP`

**For destructive tests, create a throwaway record** via the
`thymer_create_record` MCP tool and clean it up after.

### 7.2 — Pick or create a test drawing record

Each source note maps to a drawing record in the `Excalidrawings`
collection (GUID `1Z4RHRCF721RRBVGNWNY4NX56Z` for the test
workspace). One source note → one drawing record. To test
edge cases, create a fresh source note and let the plugin create
the drawing on first open.

### 7.3 — Write the test

```js
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  await page.goto('https://harry.thymer.com/?open=WS.RECORD#title');
  await page.waitForTimeout(8000);

  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  // Open Excalidraw
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(600);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  const session = await waitForExcalSession(page, 15000);
  if (!session) throw new Error('no session');

  // ... your scenario ...

  const scene = await readSceneElements(page);
  writeReport('my-test', { session, scene, diags: msgs.slice(-20) });

  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

### 7.4 — Verify against the DB

After the test, read the persisted scene via MCP and compare:

```
thymer_get_record(workspace=<ws>, record=<drawingGuid>)
```

Then parse the `Scene` field's `scene.sceneJson` (a string) and
check:
- Number of elements matches in-memory count
- Each element's `points.length` matches
- Each element's `width/height` matches
- No `version > 100` (a sign of version inflation)
- No `points.length < 2 && width < 1 && height < 1` (degenerate dots)

### 7.5 — Add the test to a runner script

`tests/run-all.mjs` is the future home for a single-command
"run everything" entry point. For now, just commit your test
alongside the others.

---

## 8. The harness API reference

### `connectBrowser() → Browser`
Opens a CDP connection to `http://127.0.0.1:9223` (override with
`EXCAL_TEST_CDP_URL` env var).

### `getThymerTab(browser) → Page | null`
Returns the first open tab whose URL matches `harry.thymer.com`,
or `null` if no such tab is open.

### `waitForExcalSession(page, timeoutMs = 15000) → Session | null`
Polls for `__excalDebug.Excalidraw.getSessionInfo()` to return a
non-null object. Returns the session object:
```
{ recordGuid, elementCount, wsAvailable }
```

### `openRecordBySidebarClick(page, recordGuid)`
Clicks the sidebar item with `data-guid="<guid>"` to open the
record in the active panel. Scrolls into view first.

### `openExcalViaCommandPalette(page)`
Opens the command palette, clears it, types the full command name
"Excalidraw: Open drawing for this note", and presses Enter.
Assumes a record is already open.

### `readSceneElements(page) → { ok, elements[] } | { error }`
Walks the React fiber from the Excalidraw canvas's parent to find
the Excalidraw instance, then calls `getSceneElements()`. Returns
a denormalized list of `{ id, type, x, y, width, height, points,
text, version, versionNonce, updated, isDeleted, seed }`.

### `injectWsDelta(page, { senderId, elements, deletedIds })`
Calls `__excalDebug.Excalidraw.injectWsMessage({ type:
'excal-delta', data: {...} })` to simulate a remote delta arriving.
Useful for two-tab tests where one tab drives the other.

### `writeReport(name, data)`
Writes `data` as JSON to `tests/baseline/<name>.json`. Use this
for every test so results are inspectable after the run.

---

## 9. Common patterns

### Drawing a freedraw stroke
```js
const canvasBox = await page.evaluate(() => {
  const canvas = document.querySelector('.excal-panel-stage canvas');
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

await page.mouse.click(canvasBox.x + 30, canvasBox.y + 30);  // focus
await page.keyboard.press('p');  // pen / freedraw
await sleep(200);

await page.mouse.move(canvasBox.x + 300, canvasBox.y + 300);
await page.mouse.down();
for (let i = 0; i < 25; i++) {
  await page.mouse.move(canvasBox.x + 300 + i * 6, canvasBox.y + 300 + Math.sin(i) * 25);
  await sleep(12);
}
await page.mouse.up();
await page.keyboard.press('1');  // back to selection
```

### Waiting for autosave to fire
```js
await sleep(2000);  // 1.5s autosave + 0.5s buffer
```

### Comparing in-memory vs DB
```js
const mem = await readSceneElements(page);
const db = await readPersistedSceneViaMcp(drawingGuid);
const memCount = mem.elements?.length || 0;
const dbCount = parseScene(db.properties.Scene[1]).elements.length;
console.log(`in-memory: ${memCount}, db: ${dbCount}`);
```

### Counting broadcasts in a window
```js
const start = msgs.length;
await sleep(20000);
const window = msgs.slice(start);
const broadcasts = window.filter((m) => /DIAG: broadcasting/.test(m.text));
```

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `session: null` after palette open | Palette didn't fire, or record wasn't active | Verify title is `Thymer - <name> [harry]` before opening palette; verify `Ctrl+P` opens `.cmdpal--input` |
| `canvasCount: 0` but `panelStage: 1` | Excalidraw is still loading the UMD; or the panel is in "No note selected" state | Wait longer; check `panelText` for "No note selected" |
| `readSceneElements` returns `{error: 'no fiber'}` | React version mismatch or wrong starting node | Use the harness's `readSceneElements` (which tries canvas + parent + grandparent); if it still fails, log all `Object.keys` on each candidate |
| `DIAG: broadcasting` count is 0 even after drawing | The 80ms throttle is skipping tiny batches, or all elements are degenerate and filtered | Check `diags.broadcasts` AND `diags.broadcastsSkipped` if present |
| Test passes locally but fails in CI | Test Chrome is logged in locally; CI has no cookies | Either skip login-required tests in CI, or seed the test profile's cookie store |
| Two-tab test shows A and B on different records | `openRecordBySidebarClick` was called on different records, or the sidebar click found the wrong item | Pass the same `recordGuid` to both; verify with `getSessionInfo().recordGuid` |

---

## 11. Why this matters

Before this test harness existed, all we had was:
- `dist/plugin.js` is minified — no source map to find the bug
- `CONTEXT.md` claims v0.5.3 fixed everything — but the live data
  (the Tasks record's `points:[[0,0]] width:0 height:0` dots and
  `version:94` text) tells a different story
- `npm run build:quick` only proves syntax correctness, not runtime
  behavior

With the harness, an agent can:
1. Reproduce a bug deterministically in ~30 seconds
2. Read both the in-memory scene AND the persisted DB scene in the
   same run
3. Diff the two to find bugs that only manifest in one path
4. Verify a fix by re-running the same scenario and seeing the
   in-memory and DB scenes converge

The 202 onChange events per test and the saved scene with 5 points
when the in-memory scene has 44 — that's the kind of evidence
that turns "I think v0.5.3 didn't fix it" into "v0.5.3 didn't
fix it because the save path doesn't filter degenerate freedraws
while the broadcast path does."

---

## 12. Future work

- [ ] T2 (idle broadcasts) — re-run after the fix to confirm version cap
- [ ] T3 (mid-stroke save) — already captured baseline; re-run after fix
- [ ] T4 (two-tab round-trip) — `injectWsDelta` + read both scenes
- [ ] T5 (two-tab race) — drive both tabs concurrently
- [ ] T6 (version cap under load) — draw 30 strokes, max(version) < 60
- [ ] T7 (force-apply LWW contract) — seed via MCP, edit on both
- [ ] T8 (reload preserves shape) — hard-reload, diff against saved scene
- [ ] `tests/run-all.mjs` — single command runs every T* file
- [ ] MCP wrapper module — `tests/lib/mcp-scene.mjs` is a stub right now
