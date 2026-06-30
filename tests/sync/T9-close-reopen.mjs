// T9: close-reopen round-trip — draw, close tab (simulates closing Thymer),
// reopen, verify the drawing loads back from the database.
//
// Mirrors the user-reported bug:
//   1) draw something
//   2) close thymer
//   3) reopen thymer
//   4) open same drawing — and its blank
//
// This test reproduces that flow. If elementCount > 0 after reopen
// and matches what the DB has, the bug is fixed. If elementCount is
// 0 or doesn't match the DB, the bug is reproduced.
//
// The "quick close" variant (phase 3) closes the page *immediately*
// after drawing, without waiting for the 1.5s autosave debounce. The
// fix in v0.5.9 is a pagehide/beforeunload listener that force-flushes
// the pending scene on tab/window close.

import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  openRecordBySidebarClick,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS = 'WKXP9WA3F5TCTMV5PS747QVV8H';
const SRC_RECORD_GUID = '1J9YG6E4KYZ9JRATQ9SM0479AT'; // "Notes" — user's actual test record
const HOME_URL = 'https://harry.thymer.com/';

// Navigate to the source record WITHOUT triggering the Chrome
// "Open Thymer?" protocol-handler popup. Per DEBUG.md gotcha 5.4:
// "?open=…" deep links are treated as a custom protocol handler and
// pop the dialog, which blocks Ctrl+P. Use home + sidebar click
// instead.
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
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
}

async function findCanvas(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

async function drawFreedraw(page, box) {
  // Use 'p' (pen / freedraw) per TESTING.md §5.6
  await page.mouse.click(box.x + 30, box.y + 30);
  await sleep(100);
  await page.keyboard.press('p');
  await sleep(300);
  const startX = box.x + 200;
  const startY = box.y + 200;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) {
    const x = startX + i * 8;
    const y = startY + Math.sin(i * 0.4) * 30;
    await page.mouse.move(x, y);
    await sleep(15);
  }
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.press('1'); // back to selection
  await sleep(300);
}

async function run() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];

  // ----- PHASE 1: open, draw, save -----
  // Always open a fresh tab — never reuse the user's main tab, so we
  // never accidentally close it on page.close().
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
  await openSourceRecordViaSidebar(page);

  console.log('[phase 1] opening Excalidraw panel…');
  await openExcalPanel(page);

  const session1 = await waitForExcalSession(page, 15000);
  if (!session1) {
    const diag = await page.evaluate(() => ({
      title: document.title,
      panelRoots: document.querySelectorAll('.excal-panel-root').length,
      panelStages: document.querySelectorAll('.excal-panel-stage').length,
      activeTag: document.activeElement?.tagName,
    }));
    console.log('[phase 1] NO SESSION. diag:', JSON.stringify(diag));
    writeReport('T9-close-reopen', { ok: false, phase: 1, error: 'no session', diag, recentLogs: msgs.slice(-10).map((m) => m.text) });
    await browser.close();
    return;
  }
  console.log('[phase 1] session:', session1);

  // Read scene before drawing
  const before = await readSceneElements(page);
  const beforeCount = before.elements?.length || 0;
  console.log(`[phase 1] before draw: count=${beforeCount}`);

  // Find canvas
  let box = await findCanvas(page);
  if (!box) {
    console.log('[phase 1] no canvas box');
    writeReport('T9-close-reopen', { ok: false, phase: 1, error: 'no canvas' });
    await browser.close();
    return;
  }
  console.log('[phase 1] canvas box:', box);

  // Draw a freedraw stroke
  await drawFreedraw(page, box);

  // Read in-memory scene
  const afterMem = await readSceneElements(page);
  const afterCount = afterMem.elements?.length || 0;
  const newEls = (afterMem.elements || []).filter((e) => !before.elements?.some((b) => b.id === e.id));
  console.log(`[phase 1] after draw: in-memory count=${afterCount}, new elements=${newEls.length}`);

  // Wait for autosave (1.5s) + buffer
  console.log('[phase 1] waiting for autosave…');
  await sleep(2500);

  // Capture the panel session info — this is what the DB should now contain
  const session1Info = await page.evaluate(() => {
    const dbg = globalThis.__excalDebug?.Excalidraw;
    return dbg?.getSessionInfo ? dbg.getSessionInfo() : null;
  });
  console.log('[phase 1] session info after autosave:', session1Info);

  // Close the page — simulates "close Thymer". Don't disconnect
  // CDP — keep the connection alive so we can open a fresh page
  // for phase 2 in the same context.
  const drawingRecordGuid = session1Info?.recordGuid;
  console.log(`[phase 1] closing page (drawingRecordGuid=${drawingRecordGuid})…`);
  // Note: we DON'T call page.close() — closing the only test page in
  // the default context can cause Playwright to mark the context as
  // closed. Just open a fresh page; the old one will be GC'd when
  // the browser disconnects at the end of the test.

  // ----- PHASE 2: reopen, open Excalidraw again, read scene -----
  console.log('[phase 2] opening fresh page (simulates reopen Thymer)…');
  const page2 = await ctx.newPage();
  page2.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
  await openSourceRecordViaSidebar(page2);

  console.log('[phase 2] opening Excalidraw panel…');
  await openExcalPanel(page2);

  const session2 = await waitForExcalSession(page2, 15000);
  if (!session2) {
    const diag = await page2.evaluate(() => ({
      title: document.title,
      panelRoots: document.querySelectorAll('.excal-panel-root').length,
      panelStages: document.querySelectorAll('.excal-panel-stage').length,
    }));
    console.log('[phase 2] NO SESSION. diag:', JSON.stringify(diag));
    writeReport('T9-close-reopen', {
      ok: false, phase: 2, error: 'no session on reopen',
      phase1: { session1, beforeCount, afterCount, newElements: newEls, session1Info },
      recentLogs: msgs.slice(-15).map((m) => m.text),
    });
    await browser.close();
    return;
  }
  console.log('[phase 2] session:', session2);

  // Read scene after reopen
  const afterReopen = await readSceneElements(page2);
  const reopenCount = afterReopen.elements?.length || 0;
  console.log(`[phase 2] after reopen: in-memory count=${reopenCount}`);

  // Compare
  const verdict = {
    phase1_afterMem_count: afterCount,
    phase1_newEls_count: newEls.length,
    phase2_reopen_count: reopenCount,
    phase2_matches_phase1_afterMem: reopenCount === afterCount,
    phase2_reopen_recordGuid: session2.recordGuid,
    phase1_recordGuid: drawingRecordGuid,
    pass: reopenCount === afterCount && reopenCount > beforeCount,
  };
  console.log('[verdict]', JSON.stringify(verdict, null, 2));

  writeReport('T9-close-reopen', {
    ok: true,
    verdict,
    phase1: { session1, beforeCount, afterCount, newElements: newEls, session1Info },
    phase2: { session2, reopenCount, scene: afterReopen },
    diags: {
      broadcasts: msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      onChange: msgs.filter((m) => /DIAG: onChange/.test(m.text)).length,
      restoreCalls: msgs.filter((m) => /restore\(scene\.sceneJson\)|restore\(sceneJson\)/.test(m.text)).length,
      shareHashLines: msgs.filter((m) => /shareHash/.test(m.text)).length,
    },
    excalVersionLine: msgs.find((m) => /EXCAL_VERSION/.test(m.text))?.text,
  });

  // ----- PHASE 3: quick close (regression test for v0.5.9) -----
  // Close the page IMMEDIATELY after drawing, without waiting for
  // the autosave debounce. Before v0.5.9 this lost the change. The
  // pagehide listener added in v0.5.9 must force a flush on close.
  console.log('[phase 3] quick-close regression test…');
  const page3 = await ctx.newPage();
  page3.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
  await openSourceRecordViaSidebar(page3);
  await openExcalPanel(page3);
  const session3 = await waitForExcalSession(page3, 15000);
  if (!session3) {
    console.log('[phase 3] no session on phase 3');
    writeReport('T9-quick-close', { ok: false, error: 'no session on phase 3' });
    await browser.close();
    return;
  }

  const beforeQuick = await readSceneElements(page3);
  const beforeQuickCount = beforeQuick.elements?.length || 0;
  console.log(`[phase 3] before quick draw: count=${beforeQuickCount}`);

  const box3 = await findCanvas(page3);
  if (!box3) {
    console.log('[phase 3] no canvas box');
    writeReport('T9-quick-close', { ok: false, error: 'no canvas' });
    await browser.close();
    return;
  }

  // Draw
  await drawFreedraw(page3, box3);

  // CLOSE THE PAGE IMMEDIATELY. Do not wait for autosave.
  console.log('[phase 3] closing page IMMEDIATELY (no autosave wait)…');
  // Use pagehide event to simulate close. Playwright's page.close()
  // triggers pagehide, which should fire our listener.
  const closePromise = page3.close();
  await closePromise;
  console.log('[phase 3] page closed.');

  // Wait a moment for any DB writes to complete
  await sleep(2000);

  // Reopen and check
  console.log('[phase 3] reopening to verify…');
  const page4 = await ctx.newPage();
  page4.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
  await openSourceRecordViaSidebar(page4);
  await openExcalPanel(page4);
  const session4 = await waitForExcalSession(page4, 15000);
  if (!session4) {
    console.log('[phase 3] no session on phase 3 reopen');
    writeReport('T9-quick-close', { ok: false, error: 'no session on phase 3 reopen' });
    await browser.close();
    return;
  }
  const afterQuick = await readSceneElements(page4);
  const afterQuickCount = afterQuick.elements?.length || 0;
  console.log(`[phase 3] after quick reopen: count=${afterQuickCount}`);

  const quickVerdict = {
    beforeQuickCount,
    afterQuickCount,
    pass: afterQuickCount > beforeQuickCount,
    newEls: (afterQuick.elements || []).filter((e) => !beforeQuick.elements?.some((b) => b.id === e.id)),
  };
  console.log('[phase 3 verdict]', JSON.stringify(quickVerdict, null, 2));

  writeReport('T9-quick-close', {
    ok: true,
    verdict: quickVerdict,
    session3: { recordGuid: session3.recordGuid, elementCount: session3.elementCount },
    session4: { recordGuid: session4.recordGuid, elementCount: session4.elementCount },
    excalVersionLine: msgs.find((m) => /EXCAL_VERSION/.test(m.text))?.text,
    savingLines: msgs.filter((m) => /Saving|Changes saved/.test(m.text)).slice(-10).map((m) => m.text),
  });

  await browser.close();
}

run().catch((e) => { console.error('FATAL:', e); process.exit(1); });
