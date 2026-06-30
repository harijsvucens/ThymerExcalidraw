// Probe multiple URLs to see where the plugin activates.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function probe(browser, label, url) {
  const page = getThymerTab(browser);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const out = await page.evaluate(() => ({
    href: location.href,
    hasExcalDebug: !!globalThis.__excalDebug,
    hasSidebarItem: !!document.querySelector('.excal-sidebar-item'),
    bootGuid: globalThis.__excalDebug?.bootCollectionGuid,
    excalInstance: !!globalThis.__excalDebug?.Excalidraw,
  }));
  console.log(`[${label}] ${url} ->`, JSON.stringify(out));
}

async function main() {
  const browser = await connectBrowser();
  await probe(browser, 'home', 'https://harry.thymer.com/');
  await probe(browser, 'testcoll', 'https://harry.thymer.com/collection/1H3Z8J1WYR0S4FPM967TR298GF');
  await probe(browser, 'testrec', 'https://harry.thymer.com/record/159BTXS2GAEDEG4Z7EVRP2YK8J');
  await probe(browser, 'journal', 'https://harry.thymer.com/journal/');
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
