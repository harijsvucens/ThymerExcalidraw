// Two-tab sync test: draw on tab A, verify tab B gets the same scene.
import { connectBrowser } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  openRecordBySidebarClick,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openExcal(page, label) {
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
}

async function main() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];
  // close extras
  for (let i = 1; i < ctx.pages().length; i++) {
    await ctx.pages()[i].close();
  }

  // Open the same record in two pages of the SAME context (shared cookies)
  const recordGuid = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  const homeUrl = 'https://harry.thymer.com/';

  const pageA = ctx.pages()[0];
  const pageB = await ctx.newPage();

  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    if (page.url() !== homeUrl) {
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(2000);
    await openRecordBySidebarClick(page, recordGuid);
    await page.waitForTimeout(2000);
  }

  // Capture console from both pages
  const msgsA = [];
  const msgsB = [];
  pageA.on('console', (m) => msgsA.push({ t: m.type(), text: m.text() }));
  pageB.on('console', (m) => msgsB.push({ t: m.type(), text: m.text() }));

  // Open Excalidraw on both
  await openExcal(pageA, 'A');
  await openExcal(pageB, 'B');

  const sessionA = await waitForExcalSession(pageA, 20000);
  const sessionB = await waitForExcalSession(pageB, 20000);
  console.log('A session:', sessionA);
  console.log('B session:', sessionB);

  if (!sessionA || !sessionB) {
    writeReport('twotab-sync', { ok: false, error: 'session missing', sessionA, sessionB });
    await browser.close();
    return;
  }

  // Read scenes
  const beforeA = await readSceneElements(pageA);
  const beforeB = await readSceneElements(pageB);
  console.log('A before:', beforeA.elements?.length, 'els');
  console.log('B before:', beforeB.elements?.length, 'els');

  // Get canvas box on A
  const canvasBox = await pageA.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('canvas box (A):', canvasBox);

  // Draw stroke on A
  await pageA.mouse.click(canvasBox.x + 30, canvasBox.y + 30);
  await sleep(200);
  await pageA.keyboard.press('p');
  await sleep(400);
  let sx = canvasBox.x + 400;
  let sy = canvasBox.y + 300;
  await pageA.mouse.move(sx, sy);
  await pageA.mouse.down();
  for (let i = 0; i < 25; i++) {
    await pageA.mouse.move(sx + i * 6, sy + Math.sin(i * 0.4) * 25);
    await sleep(12);
  }
  await pageA.mouse.up();
  await pageA.keyboard.press('1');
  await sleep(500);

  // Wait for sync (1.5s autosave + 0.5s buffer + 1s WS broadcast)
  await sleep(4000);

  // Read scenes again
  const afterA = await readSceneElements(pageA);
  const afterB = await readSceneElements(pageB);

  const newA = afterA.elements?.filter((e) => !beforeA.elements?.some((b) => b.id === e.id)) || [];
  const newB = afterB.elements?.filter((e) => !beforeB.elements?.some((b) => b.id === e.id)) || [];

  // Compare A and B's new elements
  const aMap = new Map(newA.map((e) => [e.id, e]));
  const bMap = new Map(newB.map((e) => [e.id, e]));
  const shared = [];
  const onlyA = [];
  const onlyB = [];
  for (const [id, ea] of aMap) {
    if (bMap.has(id)) {
      shared.push({ id, A: { points: ea.points?.length, w: ea.width, h: ea.height, v: ea.version }, B: (() => { const eb = bMap.get(id); return { points: eb.points?.length, w: eb.width, h: eb.height, v: eb.version }; })() });
    } else {
      onlyA.push({ id, points: ea.points?.length, w: ea.width, h: ea.height, v: ea.version });
    }
  }
  for (const [id, eb] of bMap) {
    if (!aMap.has(id)) {
      onlyB.push({ id, points: eb.points?.length, w: eb.width, h: eb.height, v: eb.version });
    }
  }

  const divergent = shared.filter(({ A, B }) => A.points !== B.points || Math.abs(A.w - B.w) > 1 || Math.abs(A.h - B.h) > 1);
  const aDots = newA.filter((e) => e.type === 'freedraw' && (!e.points || e.points.length < 2 || (e.width || 0) < 1));
  const bDots = newB.filter((e) => e.type === 'freedraw' && (!e.points || e.points.length < 2 || (e.width || 0) < 1));

  const report = {
    ok: true,
    beforeA: { count: beforeA.elements?.length },
    beforeB: { count: beforeB.elements?.length },
    afterA: { count: afterA.elements?.length },
    afterB: { count: afterB.elements?.length },
    newA: newA.map((e) => ({ id: e.id, type: e.type, points: e.points?.length, w: e.width, h: e.height, v: e.version })),
    newB: newB.map((e) => ({ id: e.id, type: e.type, points: e.points?.length, w: e.width, h: e.height, v: e.version })),
    onlyA, onlyB, shared, divergent,
    aDots: aDots.map((e) => ({ id: e.id, points: e.points?.length, w: e.width, h: e.height })),
    bDots: bDots.map((e) => ({ id: e.id, points: e.points?.length, w: e.width, h: e.height })),
    diags: {
      aBroadcasts: msgsA.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      bBroadcasts: msgsB.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      aWSRecv: msgsA.filter((m) => /DIAG: WS recv/.test(m.text)).length,
      bWSRecv: msgsB.filter((m) => /DIAG: WS recv/.test(m.text)).length,
    },
  };
  writeReport('twotab-sync', report);
  console.log('REPORT:', JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
