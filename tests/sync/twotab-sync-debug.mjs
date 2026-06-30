// Two-tab sync test with full broadcast log capture
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
  if (!sessionA || !sessionB) {
    console.log('sessions not ready');
    await browser.close();
    return;
  }

  const beforeA = await readSceneElements(pageA);
  const beforeB = await readSceneElements(pageB);

  const canvasBox = await pageA.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

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

  // Wait for sync
  await sleep(4000);

  const afterA = await readSceneElements(pageA);
  const afterB = await readSceneElements(pageB);

  // Capture only the relevant logs
  const aBroadcasts = msgsA.filter((m) => /DIAG: broadcasting|DIAG BROADCAST/.test(m.text));
  const aWSSends = msgsA.filter((m) => /DIAG: WS send|DIAG send/.test(m.text));
  const aAllDIAG = msgsA.filter((m) => /DIAG/.test(m.text));
  const bWSRecv = msgsB.filter((m) => /DIAG: WS recv/.test(m.text));
  const bUpdateScene = msgsB.filter((m) => /updateScene \(WS\)|DIAG updateScene/.test(m.text));

  console.log('=== A broadcasts ===');
  aBroadcasts.forEach((m) => console.log(m.text));
  console.log('=== A all DIAG (last 30) ===');
  aAllDIAG.slice(-30).forEach((m) => console.log(m.text));
  console.log('=== B WS recv ===');
  bWSRecv.forEach((m) => console.log(m.text));
  console.log('=== B updateScene (WS) ===');
  bUpdateScene.forEach((m) => console.log(m.text));

  const newA = afterA.elements?.filter((e) => !beforeA.elements?.some((b) => b.id === e.id)) || [];
  const newB = afterB.elements?.filter((e) => !beforeB.elements?.some((b) => b.id === e.id)) || [];
  console.log('A elements:', newA.map((e) => ({ id: e.id, points: e.points?.length, v: e.version })));
  console.log('B elements:', newB.map((e) => ({ id: e.id, points: e.points?.length, v: e.version })));

  writeReport('twotab-sync-debug', {
    aBroadcasts: aBroadcasts.map((m) => m.text),
    bWSRecv: bWSRecv.map((m) => m.text),
    bUpdateScene: bUpdateScene.map((m) => m.text),
    newA: newA.map((e) => ({ id: e.id, points: e.points?.length, v: e.version })),
    newB: newB.map((e) => ({ id: e.id, points: e.points?.length, v: e.version })),
  });

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
