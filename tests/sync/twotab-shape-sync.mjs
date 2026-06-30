// Two-tab shape sync test: draw rectangle/ellipse/diamond on tab A,
// verify tab B gets the shape with matching extents.
import { connectBrowser } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  openRecordBySidebarClick,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openExcal(page) {
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
}

// Tool hotkeys: 2=rectangle, 3=ellipse, 4=diamond
async function drawShape(page, canvasBox, toolKey, startX, startY, dx, dy) {
  await page.keyboard.press(toolKey);
  await sleep(300);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 8 intermediate steps so Excalidraw sees a "drag", not a click
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      startX + (dx * i) / steps,
      startY + (dy * i) / steps,
    );
    await sleep(20);
  }
  await page.mouse.up();
  await sleep(400);
  // Switch back to select tool to avoid drawing more
  await page.keyboard.press('1');
  await sleep(200);
}

async function main() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];
  for (let i = 1; i < ctx.pages().length; i++) {
    await ctx.pages()[i].close();
  }

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

  const msgsA = [];
  const msgsB = [];
  pageA.on('console', (m) => msgsA.push({ t: m.type(), text: m.text() }));
  pageB.on('console', (m) => msgsB.push({ t: m.type(), text: m.text() }));

  await openExcal(pageA);
  await openExcal(pageB);

  const sessionA = await waitForExcalSession(pageA, 20000);
  const sessionB = await waitForExcalSession(pageB, 20000);
  console.log('A session:', sessionA);
  console.log('B session:', sessionB);

  if (!sessionA || !sessionB) {
    writeReport('twotab-shape-sync', { ok: false, error: 'session missing', sessionA, sessionB });
    await browser.close();
    return;
  }

  const beforeA = await readSceneElements(pageA);
  const beforeB = await readSceneElements(pageB);
  console.log('A before:', beforeA.elements?.length, 'els');
  console.log('B before:', beforeB.elements?.length, 'els');

  const canvasBox = await pageA.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('canvas box (A):', canvasBox);

  if (!canvasBox) {
    writeReport('twotab-shape-sync', { ok: false, error: 'no canvas box' });
    await browser.close();
    return;
  }

  // Draw 3 shapes in different positions
  const shapes = [
    { tool: '2', kind: 'rectangle', dx: 120, dy: 80 },  // 2 = rectangle
    { tool: '3', kind: 'ellipse',   dx: 100, dy: 100 }, // 3 = ellipse
    { tool: '4', kind: 'diamond',   dx: 90,  dy: 90 },  // 4 = diamond
  ];
  const originX = canvasBox.x + 150;
  const originY = canvasBox.y + 150;
  const stride = 200;

  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const sx = originX + i * stride;
    const sy = originY;
    await drawShape(pageA, canvasBox, s.tool, sx, sy, s.dx, s.dy);
    await sleep(500);
  }

  // Wait for sync
  await sleep(4500);

  const afterA = await readSceneElements(pageA);
  const afterB = await readSceneElements(pageB);

  const newA = afterA.elements?.filter((e) => !beforeA.elements?.some((b) => b.id === e.id)) || [];
  const newB = afterB.elements?.filter((e) => !beforeB.elements?.some((b) => b.id === e.id)) || [];

  const aMap = new Map(newA.map((e) => [e.id, e]));
  const bMap = new Map(newB.map((e) => [e.id, e]));

  const shared = [];
  const onlyA = [];
  const onlyB = [];
  for (const [id, ea] of aMap) {
    if (bMap.has(id)) {
      const eb = bMap.get(id);
      shared.push({
        id,
        type: ea.type,
        A: { w: ea.width, h: ea.height, x: ea.x, y: ea.y, v: ea.version, vn: ea.versionNonce },
        B: { w: eb.width, h: eb.height, x: eb.x, y: eb.y, v: eb.version, vn: eb.versionNonce },
      });
    } else {
      onlyA.push({ id, type: ea.type, w: ea.width, h: ea.height, x: ea.x, y: ea.y, v: ea.version });
    }
  }
  for (const [id, eb] of bMap) {
    if (!aMap.has(id)) {
      onlyB.push({ id, type: eb.type, w: eb.width, h: eb.height, x: eb.x, y: eb.y, v: eb.version });
    }
  }

  // Shape sync success criteria
  //   shared contains one element per shape kind
  //   each shared element has w>=20, h>=20 on both sides
  //   the types match
  //   A and B width/height within 2px of each other
  const expectedKinds = ['rectangle', 'ellipse', 'diamond'];
  const kindsPresent = new Set(shared.map((s) => s.type));
  const missing = expectedKinds.filter((k) => !kindsPresent.has(k));

  const tooSmall = shared.filter((s) => (s.A.w || 0) < 20 || (s.A.h || 0) < 20
    || (s.B.w || 0) < 20 || (s.B.h || 0) < 20);
  const divergent = shared.filter((s) => Math.abs(s.A.w - s.B.w) > 2 || Math.abs(s.A.h - s.B.h) > 2);

  const report = {
    ok: missing.length === 0 && onlyB.length === 0 && tooSmall.length === 0 && divergent.length === 0,
    beforeA: { count: beforeA.elements?.length },
    beforeB: { count: beforeB.elements?.length },
    afterA: { count: afterA.elements?.length },
    afterB: { count: afterB.elements?.length },
    newA: newA.map((e) => ({ id: e.id, type: e.type, w: e.width, h: e.height, x: e.x, y: e.y, v: e.version })),
    newB: newB.map((e) => ({ id: e.id, type: e.type, w: e.width, h: e.height, x: e.x, y: e.y, v: e.version })),
    onlyA, onlyB, shared, divergent,
    missing, tooSmall,
    diags: {
      aBroadcasts: msgsA.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      bBroadcasts: msgsB.filter((m) => /DIAG: broadcasting/.test(m.text)).length,
      aWSRecv: msgsA.filter((m) => /DIAG: WS recv/.test(m.text)).length,
      bWSRecv: msgsB.filter((m) => /DIAG: WS recv/.test(m.text)).length,
    },
  };
  writeReport('twotab-shape-sync', report);
  console.log('REPORT:', JSON.stringify(report, null, 2));

  await browser.close();
  if (!report.ok) process.exit(2);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
