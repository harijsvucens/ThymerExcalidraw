// Debug: find the right way to get the Excalidraw scene.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

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
  await page.waitForTimeout(5000);

  // Open Excalidraw
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // Debug: list all keys on the canvas
  const debug = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return { error: 'no stage' };
    const canvas = stage.querySelector('canvas');
    if (!canvas) return { error: 'no canvas' };
    const keys = Object.keys(canvas);
    const reactKeys = keys.filter((k) => /react|fiber|internal/i.test(k));
    const result = {
      allKeys: keys,
      reactKeys,
      hasOwnProp: Object.keys(canvas).length,
    };
    // Try to walk the fiber
    if (reactKeys.length > 0) {
      const k = reactKeys[0];
      let fiber = canvas[k];
      const walks = [];
      let hops = 0;
      while (fiber && hops < 30) {
        const sn = fiber.stateNode;
        walks.push({
          hops,
          hasSN: !!sn,
          snType: sn?.constructor?.name || typeof sn,
          hasGetScene: !!(sn && typeof sn.getSceneElements === 'function'),
          hasGetApp: !!(sn && typeof sn.getAppState === 'function'),
          hasUpdate: !!(sn && typeof sn.updateScene === 'function'),
        });
        fiber = fiber.return;
        hops++;
      }
      result.walks = walks;
    }
    return result;
  });
  console.log(JSON.stringify(debug, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
