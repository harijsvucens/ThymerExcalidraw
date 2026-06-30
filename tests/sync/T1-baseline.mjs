// T1 baseline: open a record, open Excalidraw, draw a stroke, read scene.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  openRecordBySidebarClick,
  openExcalViaCommandPalette,
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  // Capture console + errors from start
  const msgs = [];
  page.on('console', (m) => msgs.push({ type: m.type(), text: m.text(), at: Date.now() }));
  page.on('pageerror', (e) => msgs.push({ type: 'pageerror', text: e.message, at: Date.now() }));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Use the "index" record in Test Collection
  const targetRecord = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  console.log('opening record', targetRecord);
  await openRecordBySidebarClick(page, targetRecord);
  await page.waitForTimeout(1500);

  // Open Excalidraw via command palette
  console.log('opening Excalidraw palette');
  await openExcalViaCommandPalette(page);
  await page.waitForTimeout(3000);

  // Wait for session
  const session = await waitForExcalSession(page, 15000);
  console.log('session:', session);
  if (!session) {
    writeReport('T1-baseline', { ok: false, error: 'no excal session', msgs: msgs.slice(-20) });
    await browser.close();
    return;
  }

  // Probe for canvas — try multiple selectors
  const canvasProbe = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    const excalCanvases = allCanvases.filter((c) => {
      // Walk up to find a .excal-panel-stage or any Excalidraw indicator
      let n = c;
      for (let i = 0; i < 20 && n; i++) {
        if (n.classList?.contains('excal-panel-stage')) return true;
        if (n.classList?.contains('excal-panel-root')) return true;
        n = n.parentElement;
      }
      return false;
    });
    return {
      hasStage: !!stage,
      allCanvasCount: allCanvases.length,
      excalCanvasCount: excalCanvases.length,
      excalCanvasRects: excalCanvases.map((c) => c.getBoundingClientRect()),
    };
  });
  console.log('canvas probe:', JSON.stringify(canvasProbe, null, 2));

  // Wait for canvas if needed
  let canvasFound = canvasProbe.excalCanvasCount > 0;
  for (let i = 0; i < 30 && !canvasFound; i++) {
    await page.waitForTimeout(500);
    const p = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('canvas'));
      return all.filter((c) => {
        let n = c;
        for (let j = 0; j < 20 && n; j++) {
          if (n.classList?.contains('excal-panel-stage')) return true;
          if (n.classList?.contains('excal-panel-root')) return true;
          n = n.parentElement;
        }
        return false;
      }).length;
    });
    if (p > 0) { canvasFound = true; break; }
  }
  console.log('canvas eventually found:', canvasFound);

  // Read initial scene
  const initial = await readSceneElements(page);
  console.log('initial scene:', JSON.stringify(initial, null, 2).slice(0, 2000));

  writeReport('T1-baseline', {
    ok: true,
    session,
    canvasProbe,
    canvasFound,
    initialScene: initial,
    msgs: msgs.slice(-20),
  });

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
