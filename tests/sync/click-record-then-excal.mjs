// Click the index record in the sidebar to open it, then trigger Excalidraw.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Find the index record (159BTXS2GAEDEG4Z7EVRP2YK8J) in the sidebar
  const found = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-guid="159BTXS2GAEDEG4Z7EVRP2YK8J"]'));
    return all.map((el) => ({
      tag: el.tagName,
      cls: el.className?.toString?.()?.slice(0, 80),
      rect: el.getBoundingClientRect(),
      inViewport: el.getBoundingClientRect().y >= 0 && el.getBoundingClientRect().y < window.innerHeight,
    }));
  });
  console.log('index record elements:', JSON.stringify(found, null, 2));

  // Click the first one (most likely visible in current scroll)
  if (found.length > 0) {
    // Find a visible one
    const visible = found.find((f) => f.inViewport);
    if (visible) {
      console.log('clicking visible record');
      await page.locator('[data-guid="159BTXS2GAEDEG4Z7EVRP2YK8J"]').first().click();
    } else {
      // Scroll the sidebar to bring it into view
      console.log('scrolling to record');
      await page.locator('[data-guid="159BTXS2GAEDEG4Z7EVRP2YK8J"]').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.locator('[data-guid="159BTXS2GAEDEG4Z7EVRP2YK8J"]').first().click();
    }
    await page.waitForTimeout(2000);
  }

  // Check what panel is now active
  const after = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll('.panel-tab'));
    const titles = panels.map((p) => p.querySelector('.panel-tab--title')?.textContent || '?');
    return {
      panels: titles,
      activePanelHasRecord: document.title,
    };
  });
  console.log('after record click:', after);

  // Open command palette
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(800);
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(1000);

  // Check palette items
  const palItems = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.cmdpal--item, [class*="cmdpal"][class*="item"], [class*="palette"][class*="item"], [class*="cmdpal--listitem"], [class*="cmdpal--list"] > *'));
    return items.slice(0, 10).map((i) => ({
      text: (i.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
      cls: i.className?.toString?.()?.slice(0, 60),
    }));
  });
  console.log('palette items:', JSON.stringify(palItems, null, 2));

  // Look for the Excalidraw command specifically
  const excalItem = await page.evaluate(() => {
    // Try different selectors
    const sel1 = Array.from(document.querySelectorAll('.cmdpal--listitem, [class*="cmdpal--list"] > *'));
    return sel1.slice(0, 20).map((el) => ({
      text: (el.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
      cls: el.className?.toString?.().slice(0, 60),
    }));
  });
  console.log('excal palette items:', JSON.stringify(excalItem, null, 2));

  // Press Enter to select first item
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  const final = await page.evaluate(() => ({
    excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    panelRoot: document.querySelectorAll('.excal-panel-root').length,
    canvas: document.querySelectorAll('.excal-panel-stage canvas').length,
    hasSession: !!globalThis.__excalDebug?.Excalidraw,
    sessionInfo: globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.() || null,
    panelText: document.querySelector('.excal-panel-root')?.textContent?.slice(0, 100),
  }));
  console.log('final:', JSON.stringify(final, null, 2));

  console.log('--- last 12 console ---');
  for (const m of msgs.slice(-12)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
