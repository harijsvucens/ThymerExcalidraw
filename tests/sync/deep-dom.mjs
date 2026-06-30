// Deep DOM probe for Excalidraw mount point.
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
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // Deep probe
  const probe = await page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return { error: 'no stage' };
    const html = stage.outerHTML.slice(0, 4000);
    const canvases = stage.querySelectorAll('canvas');
    return {
      stageHTML: html,
      canvasCount: canvases.length,
      // Find the actual canvas
      firstCanvas: canvases[0] ? {
        keys: Object.keys(canvases[0]),
        parentKeys: canvases[0].parentElement ? Object.keys(canvases[0].parentElement) : null,
        grandparentKeys: canvases[0].parentElement?.parentElement ? Object.keys(canvases[0].parentElement.parentElement) : null,
        // Check if there are SVG elements (Excalidraw renders mostly SVG)
        svgInStage: stage.querySelectorAll('svg').length,
        interactiveCanvas: stage.querySelectorAll('.excal-interactive, [class*="interactive"]').length,
      } : null,
    };
  });
  console.log('STAGE HTML (first 4k chars):');
  console.log(probe.stageHTML || JSON.stringify(probe.error));
  console.log('---');
  console.log('CANVAS INFO:', JSON.stringify(probe.firstCanvas, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
