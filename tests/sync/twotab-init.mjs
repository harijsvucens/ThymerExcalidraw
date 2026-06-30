// Open with ?open=WORKSPACE.RECORD#title URL format. Two tabs for cross-instance.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  readSceneElements,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openInContext(browser, url, label) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));
  page.on('pageerror', (e) => msgs.push({ t: 'pageerror', text: e.message, at: Date.now() }));
  page._excalMsgs = msgs;
  console.log(`[${label}] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  return { ctx, page };
}

async function main() {
  const browser = await connectBrowser();
  const ws = 'WKXP9WA3F5TCTMV5PS747QVV8H';

  // Try Tasks first (has known elements per CONTEXT.md)
  const recordGuid = '1NQQENF9Y1GRCS8YKTHC8CRBKR'; // Tasks record
  const url = `https://harry.thymer.com/?open=${ws}.${recordGuid}#Tasks`;

  // Tab A
  const a = await openInContext(browser, url, 'A');
  // Tab B (separate context = separate V8 realm)
  const b = await openInContext(browser, url, 'B');

  // Probe both tabs: do we have a record open?
  for (const [label, tab] of [['A', a], ['B', b]]) {
    const probe = await tab.page.evaluate(() => {
      const dbg = globalThis.__excalDebug?.Excalidraw;
      return {
        title: document.title,
        excalDebug: !!dbg,
        session: dbg?.getSessionInfo?.() || null,
        activeRecord: !!document.querySelector('[class*="record-body"], [class*="record-content"]'),
        panelRoot: document.querySelectorAll('.excal-panel-root').length,
      };
    });
    console.log(`[${label}]`, JSON.stringify(probe, null, 2));
  }

  // Open Excalidraw on both
  for (const [label, tab] of [['A', a], ['B', b]]) {
    await tab.page.keyboard.press('Control+p');
    await tab.page.waitForTimeout(500);
    await tab.page.keyboard.press('Control+a');
    await tab.page.keyboard.press('Delete');
    await tab.page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
    await tab.page.waitForTimeout(800);
    await tab.page.keyboard.press('Enter');
  }
  await sleep(5000);

  // Probe both
  for (const [label, tab] of [['A', a], ['B', b]]) {
    const probe = await tab.page.evaluate(() => {
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

  // Wait for both sessions to have elements
  for (const [label, tab] of [['A', a], ['B', b]]) {
    let session = null;
    for (let i = 0; i < 30; i++) {
      session = await waitForExcalSession(tab.page, 1000);
      if (session) break;
      await sleep(500);
    }
    console.log(`[${label} session wait]`, session);
  }

  // Read scenes
  for (const [label, tab] of [['A', a], ['B', b]]) {
    const scene = await readSceneElements(tab.page);
    console.log(`[${label} scene]`, JSON.stringify({
      count: scene.elements?.length,
      types: scene.elements?.map((e) => e.type).join(','),
      versions: scene.elements?.map((e) => e.version).join(','),
      dots: scene.elements?.filter((e) => e.type === 'freedraw' && (!e.points || e.points.length < 2 || (e.width || 0) < 1)).length,
    }, null, 2));
  }

  writeReport('twotab-init', {
    ok: true,
    aSession: await a.page.evaluate(() => globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.()),
    bSession: await b.page.evaluate(() => globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.()),
    aScene: await readSceneElements(a.page),
    bScene: await readSceneElements(b.page),
  });

  // Keep tabs open for follow-up tests
  console.log('twotab init done. tabs open.');
  // Don't close — leave for next test step
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
