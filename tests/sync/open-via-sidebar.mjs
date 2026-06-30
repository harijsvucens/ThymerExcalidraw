// Open Test Collection in sidebar, then a record, then trigger Excalidraw.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Click the Test Collection in sidebar
  const testColl = page.locator('[data-guid="1H3Z8J1WYR0S4FPM967TR298GF"]').first();
  await testColl.click();
  await page.waitForTimeout(2000);

  // Check we're now on the collection
  const collState = await page.evaluate(() => ({
    title: document.title,
    recordCount: document.querySelectorAll('[data-record-id], [data-guid]').length,
  }));
  console.log('after coll click:', collState);

  // Find a record inside Test Collection (index, Correspondence, etc.)
  // The records inside the collection should be clickable
  const rec = page.locator('[data-guid="159BTXS2GAEDEG4Z7EVRP2YK8J"]').first();
  if (await rec.count() > 0) {
    console.log('clicking record');
    await rec.click();
    await page.waitForTimeout(2000);
  } else {
    console.log('record not in sidebar — try table view');
    // Maybe records are in the main panel as a table. Let's look for any record link.
    const recordGuids = await page.evaluate(() => {
      const els = document.querySelectorAll('[data-record-id], [data-guid]');
      return Array.from(els).slice(0, 30).map((e) => ({
        guid: e.getAttribute('data-guid') || e.getAttribute('data-record-id'),
        text: (e.textContent || '').slice(0, 50).replace(/\s+/g, ' ').trim(),
        tag: e.tagName,
      }));
    });
    console.log('record-like elements:', JSON.stringify(recordGuids, null, 2));
  }

  // Try the command palette
  console.log('--- opening command palette ---');
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(1000);
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(1000);

  // See what's in the palette
  const palette = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="command"], [class*="palette"], [role="option"], [role="listbox"]'))
      .slice(0, 20)
      .map((e) => ({
        cls: e.className?.toString?.().slice(0, 80),
        text: (e.textContent || '').slice(0, 80).replace(/\s+/g, ' ').trim(),
      }));
    return items;
  });
  console.log('palette items:', JSON.stringify(palette, null, 2));

  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  const final = await page.evaluate(() => ({
    hasExcalDebug: !!globalThis.__excalDebug,
    panelRoot: document.querySelectorAll('.excal-panel-root').length,
    panelStage: document.querySelectorAll('.excal-panel-stage').length,
    canvas: document.querySelectorAll('.excal-panel-stage canvas').length,
  }));
  console.log('final:', final);

  console.log('--- last 25 console ---');
  for (const m of msgs.slice(-25)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
