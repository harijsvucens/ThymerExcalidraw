// Two tabs in the SAME context (shared cookies) using the user's record.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await connectBrowser();
  // Use the existing logged-in context
  const ctx = browser.contexts()[0];
  console.log('contexts:', browser.contexts().length);

  // Tab A: existing or new
  let pageA = getThymerTab(browser);
  if (!pageA) {
    pageA = await ctx.newPage();
    await pageA.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  }
  console.log('A url:', pageA.url());

  // Navigate A to the index record
  const ws = 'WKXP9WA3F5TCTMV5PS747QVV8H';
  const recordGuid = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  const url = `https://harry.thymer.com/?open=${ws}.${recordGuid}#index`;
  await pageA.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageA.waitForTimeout(6000);
  console.log('A title after open:', await pageA.title());

  // Tab B: new tab in same context
  const pageB = await ctx.newPage();
  await pageB.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageB.waitForTimeout(6000);
  console.log('B title after open:', await pageB.title());

  const msgsA = [];
  const msgsB = [];
  pageA.on('console', (m) => msgsA.push({ t: m.type(), text: m.text(), at: Date.now() }));
  pageB.on('console', (m) => msgsB.push({ t: m.type(), text: m.text(), at: Date.now() }));

  // Open Excalidraw on both
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    await page.keyboard.press('Control+p');
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
  }
  await sleep(5000);

  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    const probe = await page.evaluate(() => {
      const dbg = globalThis.__excalDebug?.Excalidraw;
      return {
        session: dbg?.getSessionInfo?.() || null,
        canvas: document.querySelectorAll('canvas').length,
        panelRoot: document.querySelectorAll('.excal-panel-root').length,
        panelStage: document.querySelectorAll('.excal-panel-stage').length,
      };
    });
    console.log(`[${label} after palette]`, JSON.stringify(probe, null, 2));
  }

  // Wait for sessions + scenes to load
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    for (let i = 0; i < 30; i++) {
      const s = await waitForExcalSession(page, 1000);
      if (s && s.elementCount >= 0) break;
      await sleep(500);
    }
  }

  // Read scenes
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    const scene = await readSceneElements(page);
    console.log(`[${label} scene] count=${scene.elements?.length} types=${scene.elements?.map((e) => e.type).join(',')} versions=${scene.elements?.map((e) => e.version).join(',')}`);
  }

  // Save initial state
  const aScene = await readSceneElements(pageA);
  const bScene = await readSceneElements(pageB);
  writeReport('twotab-init-index', {
    ok: true,
    aSession: await pageA.evaluate(() => globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.()),
    bSession: await pageB.evaluate(() => globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.()),
    aScene: { count: aScene.elements?.length, types: aScene.elements?.map((e) => e.type), versions: aScene.elements?.map((e) => e.version) },
    bScene: { count: bScene.elements?.length, types: bScene.elements?.map((e) => e.type), versions: bScene.elements?.map((e) => e.version) },
  });

  // Stay open
  console.log('initialization done. Tabs A and B are open and ready.');
  // Expose page handles via global for next test step
  globalThis.__pageA = pageA;
  globalThis.__pageB = pageB;
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
