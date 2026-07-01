// T11: localStorage poisoning regression test for v0.6.2
//
// Reproduces the data-loss bug from the user report:
//   "Open Excalidraw on instance A -> blank canvas. Move
//    objects on instance B -> they appear on A."
//
// Pre-v0.6.2: stale empty localStorage entries from pre-v0.6.1
// mount-echo bleaches could override the populated DB on load,
// because _pickNewerDoc compared only updatedAt timestamps.
//
// Post-v0.6.2:
//   Fix 1: content-aware _pickNewerDoc (DB wins if localStorage empty)
//   Fix 2: heal poisoned localStorage on successful DB load
//
// This test:
//   1. Pre-poison localStorage with an empty scene (newer updatedAt)
//   2. Open the panel
//   3. Verify DB data loads (12 elements) — Fix 1
//   4. Verify localStorage has been healed with the DB data — Fix 2
//   5. Verify DB unchanged after pagehide flush

import http from 'node:http';
import { connectBrowser } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS = 'W6CDWK9CQRRWPJV2K5SM9YSW6P';
const SRC_RECORD_GUID = 'S-16S1WSXAWSHVHJZ72G6J3JRTCP-P000000000-0-20260701';
const DRAWING_RECORD_GUID = '1JC9C44WQDVD19JFXBM8PYQJ74';
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
            try { resolve(JSON.parse(text)); }
            catch (_) { resolve(text); }
          } catch (e) { reject(e); }
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
  if (!sceneText) return { updatedAt: null, elementCount: 0 };
  const doc = JSON.parse(sceneText);
  let inner = null;
  try {
    inner = doc?.scene?.sceneJson ? JSON.parse(doc.scene.sceneJson) : null;
  } catch (_) { inner = null; }
  const elements = Array.isArray(inner?.elements) ? inner.elements : [];
  return {
    updatedAt: doc?.updatedAt || null,
    elementCount: elements.length,
  };
}

function makeEmptyPoisonDoc(recordGuid) {
  return {
    v: 3,
    sourceRecordGuid: recordGuid,
    // Set updatedAt 1 hour in the future so _pickNewerDoc picks this
    updatedAt: new Date(Date.now() + 3600000).toISOString(),
    scene: {
      sceneJson: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'https://harry.thymer.com',
        elements: [],
        appState: { viewBackgroundColor: '#ffffff', theme: 'light' },
        files: {},
      }),
    },
  };
}

async function run() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];

  // ----- PRE: read DB scene before opening the panel -----
  console.log('[pre] reading DB scene via MCP bridge…');
  const pre = await readDbScene(WS, DRAWING_RECORD_GUID);
  console.log('[pre] updatedAt:', pre.updatedAt, 'elements:', pre.elementCount);

  if (pre.elementCount === 0) {
    console.error('[pre] FATAL: fixture has 0 elements — data already lost.');
    writeReport('T11-ls-poisoning', { ok: false, error: 'fixture is empty' });
    await browser.close();
    return;
  }

  // ----- PHASE 1: open a page, pre-poison localStorage, then open panel -----
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  // Navigate to home first so the Thymer app loads and the origin is established.
  // Then navigate in-page via evaluate (NOT page.goto with ?open=) to avoid
  // triggering the Chrome "thymer://" protocol handler prompt which blocks
  // keyboard events (DEBUG.md §5.4).
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // Pre-poison localStorage with an empty scene (newer updatedAt)
  const lsKey = 'excal_draw_v1_' + SRC_RECORD_GUID;
  await page.evaluate(({ key, doc }) => {
    localStorage.setItem(key, JSON.stringify(doc));
  }, { key: lsKey, doc: makeEmptyPoisonDoc(SRC_RECORD_GUID) });
  console.log('[phase 1] pre-poisoned localStorage with empty scene (future updatedAt)');

  // Verify poison was planted
  const poisonCheck = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return 'MISSING';
    const doc = JSON.parse(raw);
    const els = doc?.scene?.sceneJson ? JSON.parse(doc.scene.sceneJson)?.elements?.length : -1;
    return `elements=${els} updatedAt=${doc.updatedAt}`;
  }, lsKey);
  console.log('[phase 1] poison check:', poisonCheck);

  // Navigate to the source record via in-page navigation (bypasses the
  // Chrome protocol handler popup that page.goto with ?open= triggers).
  await page.evaluate((url) => { window.location.href = url; },
    HOME_URL + '?open=' + WS + '.' + SRC_RECORD_GUID + '#Wed-Jul-1');
  await page.waitForTimeout(5000);
  console.log('[phase 1] navigated to journal entry, title:', await page.title());

  // ----- PHASE 2: open Excalidraw panel -----
  console.log('[phase 2] checking for auto-mounted Excalidraw panel…');
  let session = await waitForExcalSession(page, 5000);
  if (session) {
    console.log('[phase 2] panel auto-mounted via deep-link:', JSON.stringify(session));
  } else {
    console.log('[phase 2] opening Excalidraw panel via command palette…');
    await page.mouse.click(400, 300);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+p');
    await page.waitForTimeout(1000);
    const hasPalette = await page.evaluate(() => !!document.querySelector('.cmdpal--input'));
    if (!hasPalette) {
      await page.keyboard.press('Control+Shift+p');
      await page.waitForTimeout(1000);
    }
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
    await page.waitForTimeout(1500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);
  }

  if (!session) {
    session = await waitForExcalSession(page, 15000);
  }
  if (!session) {
    const diag = await page.evaluate(() => ({
      title: document.title,
      panelRoots: document.querySelectorAll('.excal-panel-root').length,
      panelStages: document.querySelectorAll('.excal-panel-stage').length,
    }));
    console.log('[phase 2] NO SESSION. diag:', JSON.stringify(diag));
    writeReport('T11-ls-poisoning', {
      ok: false,
      error: 'no excal session mounted',
      diag,
      recentLogs: msgs.slice(-15).map((m) => m.text),
    });
    await browser.close();
    return;
  }
  console.log('[phase 2] session:', session);

  // ----- VERIFY Fix 1: DB data loaded (not poisoned localStorage) -----
  const liveAfterMount = await readSceneElements(page);
  const liveCount = liveAfterMount.elements?.length || 0;
  console.log(`[verify] live elements after mount: ${liveCount}`);
  const dbWonLoad = liveCount > 0;
  console.log('[verify] DB-wins load:', dbWonLoad);

  // Check console for DB-wins log
  const dbWinsLog = msgs.filter((m) => /DB-wins/.test(m.text));
  console.log('[verify] DB-wins log lines:', dbWinsLog.length);

  // ----- VERIFY Fix 2: localStorage healed with DB data -----
  const lsAfterLoad = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return 'MISSING';
    const doc = JSON.parse(raw);
    const els = doc?.scene?.sceneJson ? JSON.parse(doc.scene.sceneJson)?.elements?.length : -1;
    return `elements=${els} updatedAt=${doc.updatedAt}`;
  }, lsKey);
  console.log('[verify] localStorage after load:', lsAfterLoad);
  // The element count may be 12 or more (another tab may have added elements
  // between the MCP pre-read and the test). The key check: it's not 0 anymore.
  const lsHadContent = /elements=[1-9]\d*/.test(lsAfterLoad);
  console.log('[verify] localStorage healed (has content):', lsHadContent);

  // Wait 3s with no input (the bug window)
  console.log('[verify] waiting 3s with NO user input…');
  await sleep(3000);

  // Re-read in-memory scene
  const liveAfterWait = await readSceneElements(page);
  const liveCountAfter = liveAfterWait.elements?.length || 0;
  console.log(`[verify] live elements after 3s wait: ${liveCountAfter}`);

  // Check guard firing
  const dbAwareBlocked = msgs.filter((m) => /db-aware save REFUSED/.test(m.text));
  const echoSuppressed = msgs.filter((m) => /echoSuppressed=true/.test(m.text));
  console.log('[verify] dbAwareBlocked count:', dbAwareBlocked.length);
  console.log('[verify] echoSuppressed count:', echoSuppressed.length);

  // Close page to trigger pagehide flush
  console.log('[phase 2] closing page…');
  await page.close();
  await sleep(2000);

  // ----- POST: read DB scene -----
  console.log('[post] reading DB scene via MCP bridge…');
  const post = await readDbScene(WS, DRAWING_RECORD_GUID);
  console.log('[post] updatedAt:', post.updatedAt, 'elements:', post.elementCount);

  // ----- VERDICT -----
  const dbUnchanged = post.elementCount === pre.elementCount;
  const liveOk = liveCountAfter > 0;

  const verdict = {
    pre: { updatedAt: pre.updatedAt, elementCount: pre.elementCount },
    post: { updatedAt: post.updatedAt, elementCount: post.elementCount },
    liveAfterMount: liveCount,
    liveAfterWait: liveCountAfter,
    dbUnchanged,
    dbWonLoad,
    lsHealed: lsHadContent,
    liveOk,
    dbAwareBlockedCount: dbAwareBlocked.length,
    echoSuppressedCount: echoSuppressed.length,
    pass: dbUnchanged && dbWonLoad && lsHadContent && liveOk,
  };
  console.log('[verdict]', JSON.stringify(verdict, null, 2));

  writeReport('T11-ls-poisoning', {
    ok: true,
    verdict,
    diags: {
      dbWinsLog: dbWinsLog.length > 0 ? dbWinsLog[0].text : null,
      lsAfterLoad,
      recentLogs: msgs.slice(-20).map((m) => m.text),
    },
  });

  if (!verdict.pass) {
    console.error('[FAIL]', JSON.stringify(verdict, null, 2));
    process.exitCode = 1;
  } else {
    console.log('[PASS] v0.6.2 localStorage poisoning fix verified.');
  }

  await browser.close();
}

run().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});