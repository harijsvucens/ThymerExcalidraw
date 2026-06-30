// T1: draw a freedraw stroke, verify it round-trips through the panel.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

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
  const url = `https://harry.thymer.com/?open=${ws}.${recordGuid}#index`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log('title after goto:', await page.title());

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
    // Dump diagnostic state
    const diag = await page.evaluate(() => ({
      title: document.title,
      activeTag: document.activeElement?.tagName,
      activeCls: document.activeElement?.className?.toString?.()?.slice(0, 60),
      panelRoots: document.querySelectorAll('.excal-panel-root').length,
      panelStages: document.querySelectorAll('.excal-panel-stage').length,
      excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
      recentExcalLogs: (window.__excalLog || []).filter((l) => /Excalidraw/.test(l)).slice(-10),
    }));
    console.log('NO SESSION DIAG:', JSON.stringify(diag, null, 2));
    console.log('--- last 15 console ---');
    for (const m of msgs.slice(-15)) console.log(m.text);
    writeReport('T1-draw', { ok: false, error: 'no session', diag, recentLogs: msgs.slice(-15).map((m) => m.text) });
    await browser.close();
    return;
  }

  // Read scene before
  const before = await readSceneElements(page);
  console.log('before:', before.error || `count=${before.elements?.length}`);
  if (before.error) {
    writeReport('T1-draw', { ok: false, error: before.error, before });
    await browser.close();
    return;
  }
  const beforeCount = before.elements.length;
  const beforeMaxV = Math.max(0, ...before.elements.map((e) => e.version || 0));

  // Find the canvas box
  const canvasBox = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('canvas box:', canvasBox);
  if (!canvasBox) {
    writeReport('T1-draw', { ok: false, error: 'no canvas' });
    await browser.close();
    return;
  }

  // Switch to freedraw (5) and draw
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 30);
  await page.mouse.click(canvasBox.x + 30, canvasBox.y + 30);
  await sleep(100);
  await page.keyboard.press('5'); // freedraw
  await sleep(300);

  const startX = canvasBox.x + 300;
  const startY = canvasBox.y + 300;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) {
    const x = startX + i * 6;
    const y = startY + Math.sin(i * 0.4) * 25;
    await page.mouse.move(x, y);
    await sleep(15);
  }
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.press('1'); // back to selection
  await sleep(500);

  // Read scene after
  const after = await readSceneElements(page);
  console.log('after:', after.error || `count=${after.elements?.length}`);
  if (after.error) {
    writeReport('T1-draw', { ok: false, error: after.error, after });
    await browser.close();
    return;
  }
  const afterCount = after.elements.length;
  const afterMaxV = Math.max(0, ...after.elements.map((e) => e.version || 0));

  // Find new elements
  const newEls = after.elements.filter((e) => !before.elements.some((b) => b.id === e.id));

  // Wait for autosave
  await sleep(2500);

  const report = {
    ok: true,
    session,
    canvasBox,
    beforeCount,
    beforeMaxV,
    afterCount,
    afterMaxV,
    newElementCount: newEls.length,
    newElements: newEls.map((e) => ({
      id: e.id,
      type: e.type,
      points: e.points?.length || 0,
      width: e.width,
      height: e.height,
      version: e.version,
      versionNonce: e.versionNonce,
    })),
    // T1 assertions
    t1_pass: newEls.length === 1 && newEls[0].type === 'freedraw' && (newEls[0].points?.length || 0) >= 10,
    // Diag log summary
    diags: {
      broadcasts: msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      recv: msgs.filter((m) => /DIAG RECV/.test(m.text)).length,
      onChange: msgs.filter((m) => /DIAG: onChange/.test(m.text)).length,
    },
  };
  writeReport('T1-draw', report);
  console.log('REPORT:', JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
