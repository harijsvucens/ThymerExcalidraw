// T10: mount-echo regression test for v0.6.1
//
// Reproduces the user-reported bug from 2026-07-01:
//   "Open a panel for a note that has drawing data; the
//    autosave / pagehide flush writes elements:[] to the DB
//    and the localStorage mirror, blanking out the user's work."
//
// Pre-v0.6.1: Excalidraw's first-wave onChange events fire with
// empty elements (before initialData is applied). The plugin's
// echo guard failed to fire at mount (lastRemoteApplyMs was 0),
// so the autosave debounce or a quick pagehide flushed an empty
// scene over populated data.
//
// Post-v0.6.1: three layers of guards in the plugin —
//   1. lastRemoteApplyMs seeded to Date.now() at mount
//   2. scene-signature comparison in onChange
//   3. hard block on empty-over-populated in onChange AND
//      _flushPanelSession
//
// This test verifies the live fix end-to-end against the
// "Wed Jul 1 · Excalidrawing" record (the actual record the
// user reported on). It uses the raw JSON-RPC bridge at
// http://127.0.0.1:13100 to read the DB scene before and after
// opening the panel with no user interaction.

import http from 'node:http';
import { connectBrowser } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  openRecordBySidebarClick,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS = 'W6CDWK9CQRRWPJV2K5SM9YSW6P'; // Harry's actual workspace
const SRC_RECORD_GUID = 'S-16S1WSXAWSHVHJZ72G6J3JRTCP-P000000000-0-20260701'; // "Wed Jul 1" Journal entry
const DRAWING_RECORD_GUID = '1JC9C44WQDVD19JFXBM8PYQJ74'; // the linked Excalidrawing record
const HOME_URL = 'https://harry.thymer.com/';

const MCP_BRIDGE = 'http://127.0.0.1:13100';

function mcpCall(toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 13100,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return reject(new Error(JSON.stringify(j.error)));
            const text = j.result?.content?.[0]?.text;
            if (!text) return resolve(j.result);
            try {
              resolve(JSON.parse(text));
            } catch (_) {
              resolve(text);
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function readDbScene(workspaceGuid, drawingRecordGuid) {
  const rec = await mcpCall('get_record', {
    workspace: workspaceGuid,
    record: drawingRecordGuid,
    format: 'structured',
  });
  const sceneText = rec?.properties?.Scene?.[1];
  if (!sceneText) return { updatedAt: null, elementCount: 0, versionSignatures: [] };
  const doc = JSON.parse(sceneText);
  let inner = null;
  try {
    inner = doc?.scene?.sceneJson ? JSON.parse(doc.scene.sceneJson) : null;
  } catch (_) {
    inner = null;
  }
  const elements = Array.isArray(inner?.elements) ? inner.elements : [];
  return {
    updatedAt: doc?.updatedAt || null,
    elementCount: elements.length,
    versionSignatures: elements.map((e) => `${e.id}@v${e.version}`).sort(),
  };
}

async function openSourceRecordViaSidebar(page) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await openRecordBySidebarClick(page, SRC_RECORD_GUID);
  await page.waitForTimeout(2500);
}

async function openExcalPanel(page) {
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
}

async function run() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];

  // ----- PRE: read DB scene before opening the panel -----
  console.log('[pre] reading DB scene via MCP bridge…');
  const pre = await readDbScene(WS, DRAWING_RECORD_GUID);
  console.log('[pre] updatedAt:', pre.updatedAt, 'elements:', pre.elementCount);

  if (pre.elementCount === 0) {
    console.error(
      '[pre] FATAL: the test fixture has 0 elements. The bug has already fired and the data is gone. ' +
        'Restore the record manually before re-running.',
    );
    writeReport('T10-mount-echo', { ok: false, error: 'fixture is empty (pre-existing data loss)' });
    await browser.close();
    return;
  }

  // ----- PHASE 1: open the panel, wait, close -----
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  console.log('[phase 1] opening source record via sidebar…');
  await openSourceRecordViaSidebar(page);

  console.log('[phase 1] opening Excalidraw panel via command palette…');
  await openExcalPanel(page);

  const session = await waitForExcalSession(page, 20000);
  if (!session) {
    const diag = await page.evaluate(() => ({
      title: document.title,
      panelRoots: document.querySelectorAll('.excal-panel-root').length,
      panelStages: document.querySelectorAll('.excal-panel-stage').length,
    }));
    console.log('[phase 1] NO SESSION. diag:', JSON.stringify(diag));
    writeReport('T10-mount-echo', {
      ok: false,
      error: 'no excal session mounted',
      diag,
      recentLogs: msgs.slice(-15).map((m) => m.text),
    });
    await browser.close();
    return;
  }
  console.log('[phase 1] session:', session);

  // The bug: Excalidraw fires onChange with empty elements
  // during initial mount. If the v0.6.1 fix works, those events
  // are suppressed (echoSuppressed=true or mountEcho=true) and
  // the in-memory scene should match the loaded scene.
  console.log('[phase 1] reading in-memory scene after mount…');
  const liveAfterMount = await readSceneElements(page);
  const liveCount = liveAfterMount.elements?.length || 0;
  console.log(`[phase 1] in-memory elements after mount: ${liveCount}`);

  // The crucial wait: 3 seconds with no user input. Pre-v0.6.1
  // this would let the 400ms autosave debounce fire with the
  // empty pendingScene and write elements:[] to the DB.
  console.log('[phase 1] waiting 3s with NO user input (the bug window)…');
  await sleep(3000);

  // Re-read in-memory scene
  const liveAfterWait = await readSceneElements(page);
  const liveCountAfter = liveAfterWait.elements?.length || 0;
  console.log(`[phase 1] in-memory elements after 3s wait: ${liveCountAfter}`);

  // Close the page to trigger pagehide flush
  console.log('[phase 1] closing page to trigger pagehide flush…');
  await page.close();
  await sleep(2000);

  // ----- POST: re-read DB scene after the run -----
  console.log('[post] reading DB scene via MCP bridge…');
  const post = await readDbScene(WS, DRAWING_RECORD_GUID);
  console.log('[post] updatedAt:', post.updatedAt, 'elements:', post.elementCount);

  // ----- VERDICT -----
  // The v0.6.1 fix ensures: opening the panel does NOT write
  // an empty scene over populated data. The DB scene after the
  // test should match the DB scene before the test (modulo the
  // very narrow race of a real user edit landing in the
  // 3-second window, which the test does not perform).
  const dbUnchanged =
    post.elementCount === pre.elementCount &&
    post.updatedAt === pre.updatedAt;
  const liveHadData = liveCount > 0 && liveCountAfter > 0;

  const verdict = {
    pre: { updatedAt: pre.updatedAt, elementCount: pre.elementCount },
    post: { updatedAt: post.updatedAt, elementCount: post.elementCount },
    liveAfterMount: liveCount,
    liveAfterWait: liveCountAfter,
    dbUnchanged,
    liveHadData,
    pass: dbUnchanged && liveHadData,
  };
  console.log('[verdict]', JSON.stringify(verdict, null, 2));

  const onChangeLines = msgs.filter((m) => /DIAG: onChange/.test(m.text));
  const mountEchoLines = msgs.filter((m) => /mount-echo suppressed/.test(m.text));
  const emptyOverPopLines = msgs.filter((m) => /empty-over-populated save REFUSED/.test(m.text));
  const savingLines = msgs.filter((m) => /Saving|Changes saved|Unsaved changes/.test(m.text));

  writeReport('T10-mount-echo', {
    ok: true,
    verdict,
    diags: {
      onChangeCount: onChangeLines.length,
      mountEchoSuppressed: mountEchoLines.length,
      emptyOverPopulatedWarned: emptyOverPopLines.length,
      savingOrDirtyLines: savingLines.length,
      firstOnChangeLines: onChangeLines.slice(0, 8).map((m) => m.text),
      lastOnChangeLines: onChangeLines.slice(-5).map((m) => m.text),
    },
    excalVersionLine: msgs.find((m) => /EXCAL_VERSION/.test(m.text))?.text,
  });

  if (!verdict.pass) {
    console.error('[FAIL]', verdict);
    process.exitCode = 1;
  } else {
    console.log('[PASS] v0.6.1 mount-echo fix verified.');
  }

  await browser.close();
}

run().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
