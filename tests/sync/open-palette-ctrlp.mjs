// Open Excalidraw via Ctrl+P (user's preferred shortcut) with exact command name.
// Includes deep DOM probe to find the canvas reliably.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Open "index" record via sidebar
  const target = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  await page.locator(`[data-guid="${target}"]`).first().scrollIntoViewIfNeeded();
  await page.locator(`[data-guid="${target}"]`).first().click();
  await page.waitForTimeout(1500);

  // Ctrl+P for command palette
  await page.keyboard.press('Control+p');
  await page.waitForTimeout(600);

  // Clear and type the full command name
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 10 });
  await page.waitForTimeout(1000);

  // Look at the palette items
  const pal = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="cmdpal"]'));
    return items
      .filter((el) => /item|list|result|entry/i.test(el.className?.toString?.() || ''))
      .slice(0, 15)
      .map((el) => ({
        text: (el.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
        cls: el.className?.toString?.()?.slice(0, 60),
      }));
  });
  console.log('palette items (filtered):', JSON.stringify(pal, null, 2));

  // Also look at the raw list container
  const palList = await page.evaluate(() => {
    const lists = Array.from(document.querySelectorAll('[class*="cmdpal--list"], [class*="cmdpal-list"], .cmdpal--list, [class*="results"]'));
    return lists.slice(0, 5).map((l) => ({
      cls: l.className?.toString?.()?.slice(0, 60),
      childCount: l.children.length,
      firstChildren: Array.from(l.children).slice(0, 5).map((c) => ({
        tag: c.tagName,
        cls: c.className?.toString?.()?.slice(0, 60),
        text: (c.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
      })),
    }));
  });
  console.log('palette list:', JSON.stringify(palList, null, 2));

  // Press Enter to execute
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  // Check session + DOM
  const after = await page.evaluate(() => {
    const dbg = globalThis.__excalDebug?.Excalidraw;
    const session = dbg?.getSessionInfo?.();
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    return {
      session,
      canvasCount: allCanvases.length,
      panelRoot: document.querySelectorAll('.excal-panel-root').length,
      panelStage: document.querySelectorAll('.excal-panel-stage').length,
      excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    };
  });
  console.log('after Enter:', JSON.stringify(after, null, 2));

  console.log('--- last 20 console ---');
  for (const m of msgs.slice(-20)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
