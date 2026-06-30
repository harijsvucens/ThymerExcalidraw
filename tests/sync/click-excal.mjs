// Find the open Excalidraw panel and inspect it.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Find the Excalidraw panel-tab
  const tabProbe = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.panel-tab--title-wrapper'));
    const excalTab = tabs.find((t) => /Excali/.test(t.textContent || ''));
    if (!excalTab) return { found: false };
    return {
      found: true,
      // Walk up to find the clickable
      parent: excalTab.parentElement?.outerHTML?.slice(0, 400),
      rect: excalTab.getBoundingClientRect(),
    };
  });
  console.log('excal tab probe:', JSON.stringify(tabProbe, null, 2));

  // Click the Excalidraw tab
  if (tabProbe.found) {
    await page.locator('.panel-tab--title-wrapper').filter({ hasText: 'Excalidraw' }).first().click();
    await page.waitForTimeout(2000);
  }

  // Check for the panel
  const panelProbe = await page.evaluate(() => ({
    hasPanelRoot: !!document.querySelector('.excal-panel-root'),
    hasCanvas: !!document.querySelector('.excal-panel-stage canvas'),
    hasStatus: !!document.querySelector('.excal-panel-statusbar'),
    excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    bootGuid: globalThis.__excalDebug?.bootCollectionGuid,
  }));
  console.log('after tab click:', panelProbe);

  // Try also clicking directly on the panel-tab--title
  const tabClick = await page.evaluate(() => {
    const titles = Array.from(document.querySelectorAll('.panel-tab--title'));
    const excalTitle = titles.find((t) => /Excali/.test(t.textContent || ''));
    if (excalTitle) {
      excalTitle.click();
      return true;
    }
    return false;
  });
  console.log('clicked panel-tab--title:', tabClick);
  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => ({
    panelRoot: document.querySelectorAll('.excal-panel-root').length,
    canvas: document.querySelectorAll('.excal-panel-stage canvas').length,
    excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
  }));
  console.log('after title click:', after);

  console.log('--- last 12 console ---');
  for (const m of msgs.slice(-12)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
