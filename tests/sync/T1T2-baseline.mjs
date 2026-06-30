// T1 + T2 baseline: draw stroke, check version, idle, count broadcasts.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  openRecordBySidebarClick,
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Use a fresh-ish record: create a new throwaway record for testing
  // so we don't pollute existing scenes. Use Untitled Test record.
  // Actually let's use a NEW record to keep tests isolated.
  const testRecordName = `__excal_sync_test_${Date.now()}`;
  console.log('test record name:', testRecordName);

  // For now, use the existing index record since we have it open
  const target = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  await openRecordBySidebarClick(page, target);
  await page.waitForTimeout(1500);

  // Open Excalidraw
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  // Wait for session + scene
  let session = null;
  for (let i = 0; i < 30; i++) {
    session = await waitForExcalSession(page, 1000);
    if (session && session.elementCount > 0) break;
    await sleep(500);
  }
  console.log('session ready:', session);
  if (!session) {
    writeReport('T1T2-baseline', { ok: false, error: 'no session' });
    await browser.close();
    return;
  }

  // Find the canvas bounding box (canvas is inside the panel-stage)
  const canvasBox = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return null;
    const canvas = stage.querySelector('canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log('canvas box:', canvasBox);
  if (!canvasBox || canvasBox.width < 50) {
    writeReport('T1T2-baseline', { ok: false, error: 'no canvas', canvasBox, session });
    await browser.close();
    return;
  }

  // Pre-test: read scene
  const beforeScene = await readSceneElements(page);
  const beforeCount = beforeScene.elements?.length || 0;
  const beforeMaxVersion = Math.max(0, ...(beforeScene.elements?.map((e) => e.version) || [0]));

  // Count broadcasts before
  const broadcastsBefore = msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length;
  const tTestStart = Date.now();

  // T1: draw a freedraw stroke
  // Use 5-key shortcut for freedraw tool
  await page.keyboard.press('Escape');
  await sleep(100);
  // Click on the canvas first to focus
  await page.mouse.click(canvasBox.x + 30, canvasBox.y + 30);
  await sleep(100);
  // Select freedraw tool (Excalidraw default: 5)
  await page.keyboard.press('5');
  await sleep(200);

  // Draw a stroke
  const startX = canvasBox.x + 200;
  const startY = canvasBox.y + 200;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const points = [];
  for (let i = 0; i < 20; i++) {
    const x = startX + (i * 8);
    const y = startY + Math.sin(i * 0.3) * 30;
    points.push({ x, y });
    await page.mouse.move(x, y);
    await sleep(15);
  }
  await page.mouse.up();
  await sleep(200);
  // Switch back to selection
  await page.keyboard.press('1');
  await sleep(300);

  // Post-stroke scene
  const afterStroke = await readSceneElements(page);
  const afterCount = afterStroke.elements?.length || 0;
  const afterMaxVersion = Math.max(0, ...(afterStroke.elements?.map((e) => e.version) || [0]));
  const newElements = (afterStroke.elements || []).filter(
    (e) => !beforeScene.elements?.some((b) => b.id === e.id),
  );

  // Wait for autosave (1.5s) + a buffer
  await sleep(2500);

  // T2: count idle broadcasts. Wait 15s (reduced from 60s to fit budget).
  // Clear the log marker
  const idleStartIdx = msgs.length;
  await sleep(15000);
  const idleMsgs = msgs.slice(idleStartIdx);
  const idleBroadcasts = idleMsgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length;
  const idleOnChanges = idleMsgs.filter((m) => /DIAG: onChange/.test(m.text)).length;
  const idleApply = idleMsgs.filter((m) => /applying remote|applyingRemote=true/.test(m.text)).length;

  const report = {
    ok: true,
    session,
    canvasBox,
    beforeCount,
    beforeMaxVersion,
    afterCount,
    afterMaxVersion,
    newElements: newElements.map((e) => ({
      id: e.id,
      type: e.type,
      points: e.points?.length || 0,
      width: e.width,
      height: e.height,
      version: e.version,
      versionNonce: e.versionNonce,
    })),
    drawsMs: 20 * 15,
    broadcastsAfterDraw: msgs.filter((m) => /DIAG: broadcasting/.test(m.text)).length - broadcastsBefore,
    // T2
    idle: {
      durationMs: 15000,
      broadcasts: idleBroadcasts,
      onChanges: idleOnChanges,
      applyEvents: idleApply,
    },
    // Diagnostics
    diags: {
      totalLogs: msgs.length,
      draws: msgs.filter((m) => /DIAG RECV pre-restore|DIAG BROADCAST/.test(m.text)).length,
      recv: msgs.filter((m) => /DIAG RECV/.test(m.text)).length,
    },
  };
  writeReport('T1T2-baseline', report);
  console.log('REPORT:', JSON.stringify(report, null, 2));

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
