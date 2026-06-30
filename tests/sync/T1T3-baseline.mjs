// T1+T3 baseline: draw with correct freedraw shortcut, then check saved DB scene.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
  openRecordBySidebarClick,
  openExcalViaCommandPalette,
} from '../lib/harness.mjs';
import { execSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];
  let page = getThymerTab(browser);
  if (!page) {
    page = await ctx.newPage();
    await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  }
  const ws = 'WKXP9WA3F5TCTMV5PS747QVV8H';
  const recordGuid = '159BTXS2GAEDEG4Z7EVRP2YK8J';

  // Open the record via the sidebar (avoids the deep-link protocol-handler popup)
  await openRecordBySidebarClick(page, recordGuid);
  await page.waitForTimeout(2000);

  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  // Open Excalidraw
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);

  const session = await waitForExcalSession(page, 15000);
  console.log('session:', session);
  if (!session) {
    writeReport('T1T3', { ok: false, error: 'no session' });
    await browser.close();
    return;
  }

  const before = await readSceneElements(page);
  console.log('before scene count:', before.elements?.length);
  if (before.error) {
    writeReport('T1T3', { ok: false, error: before.error });
    await browser.close();
    return;
  }

  const canvasBox = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('canvas box:', canvasBox);

  // Count broadcasts before drawing
  const broadcastsBefore = msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length;

  // Switch to freedraw — use '6' or 'p' (Excalidraw 0.17.6 default: p for pen)
  await page.mouse.click(canvasBox.x + 30, canvasBox.y + 30);
  await sleep(200);
  await page.keyboard.press('p');
  await sleep(400);

  // Check current tool
  const toolCheck = await page.evaluate(() => {
    // Look for active tool indicator in Excalidraw UI
    const active = document.querySelector('[class*="active"][class*="tool"]');
    return active?.getAttribute('title') || active?.getAttribute('aria-label') || 'unknown';
  });
  console.log('active tool:', toolCheck);

  // Draw stroke 1: 20 points, no pause
  console.log('drawing stroke 1 (no pause)');
  let sx = canvasBox.x + 400;
  let sy = canvasBox.y + 300;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) {
    await page.mouse.move(sx + i * 6, sy + Math.sin(i * 0.4) * 25);
    await sleep(12);
  }
  await page.mouse.up();
  await sleep(200);

  // Wait 1.5s for autosave to fire on stroke 1 (already complete)
  await sleep(2000);

  // Draw stroke 2: with 2s pause mid-stroke to trigger autosave during degenerate state
  console.log('drawing stroke 2 (with 2s pause mid-stroke)');
  sx = canvasBox.x + 400;
  sy = canvasBox.y + 500;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(sx + i * 6, sy + Math.sin(i * 0.4) * 25);
    await sleep(15);
  }
  // Pause 2s mid-stroke (longer than 1.5s autosave) — triggers save with degenerate dot
  console.log('pausing 2s mid-stroke to trigger autosave on dot state');
  await sleep(2200);
  // Continue the stroke
  for (let i = 5; i < 25; i++) {
    await page.mouse.move(sx + i * 6, sy + Math.sin(i * 0.4) * 25);
    await sleep(12);
  }
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.press('1');
  await sleep(500);

  // Wait for save
  await sleep(2500);

  // Read scene
  const after = await readSceneElements(page);
  console.log('after scene count:', after.elements?.length);
  const newEls = after.elements?.filter((e) => !before.elements?.some((b) => b.id === e.id)) || [];
  console.log('new elements:', newEls.length, newEls.map((e) => ({ type: e.type, points: e.points?.length, w: e.width, h: e.height, v: e.version })));

  // Count broadcasts and look for the degenerate one
  const broadcastsAfter = msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length;
  const totalBroadcasts = broadcastsAfter - broadcastsBefore;

  // Read the persisted scene via MCP
  console.log('reading persisted scene via MCP...');
  let dbScene = null;
  try {
    const out = execSync(
      `node -e "
        import('./tests/lib/mcp-scene.mjs').then(m => m.readScene('${ws}', '195DTS7JK11ECZXKKSP1MB6S4Z')).then(s => { console.log(JSON.stringify(s)); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
      "`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    dbScene = JSON.parse(out);
  } catch (e) {
    console.log('MCP read failed:', e.message.slice(0, 200));
  }

  const report = {
    ok: true,
    session,
    canvasBox,
    broadcastsBefore,
    broadcastsAfter,
    totalBroadcasts,
    before: { count: before.elements?.length, maxV: Math.max(0, ...before.elements?.map((e) => e.version || 0)) },
    after: { count: after.elements?.length, maxV: Math.max(0, ...after.elements?.map((e) => e.version || 0)) },
    newElements: newEls.map((e) => ({
      type: e.type, points: e.points?.length, w: e.width, h: e.height, v: e.version,
    })),
    dbScene: dbScene ? {
      elementCount: dbScene.elements?.length,
      maxV: Math.max(0, ...(dbScene.elements || []).map((e) => e.version || 0)),
      // The key question: are there dots (1-point, 0x0 freedraws) in the saved scene?
      dots: (dbScene.elements || []).filter((e) =>
        e.type === 'freedraw' && ((!e.points || e.points.length < 2) || ((e.width || 0) < 1 && (e.height || 0) < 1))
      ).map((e) => ({ id: e.id, points: e.points?.length, w: e.width, h: e.height, v: e.version })),
    } : null,
    diags: {
      broadcasts: msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      onChange: msgs.filter((m) => /DIAG: onChange/.test(m.text)).length,
      saveStatus: msgs.filter((m) => /Saving|Changes saved|Save failed/.test(m.text)).length,
      saveDoc: msgs.filter((m) => /DIAG _saveDrawingDoc/.test(m.text)).map((m) => m.text),
    },
    diagMessages: msgs
      .filter((m) => /DIAG/.test(m.text))
      .map((m) => ({ t: m.t, text: m.text })),
  };
  writeReport('T1T3-baseline', report);
  console.log('REPORT:', JSON.stringify(report, null, 2));

  // Print full DIAG log for inspection
  console.log('=== ALL DIAG MESSAGES ===');
  for (const m of msgs) {
    if (/DIAG/.test(m.text)) {
      console.log(`[${m.t}]`, m.text);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
