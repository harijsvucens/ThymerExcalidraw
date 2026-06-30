// Click a record row to open the record, then trigger Excalidraw.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Open Test Collection
  await page.locator('[data-guid="1H3Z8J1WYR0S4FPM967TR298GF"]').first().click();
  await page.waitForTimeout(2000);

  // Look for table rows
  const rowProbe = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    return rows.slice(0, 5).map((r) => ({
      text: (r.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
      cls: r.className?.toString?.().slice(0, 60),
      rect: r.getBoundingClientRect ? { x: r.getBoundingClientRect().x, y: r.getBoundingClientRect().y, w: r.getBoundingClientRect().width } : null,
    }));
  });
  console.log('rows:', JSON.stringify(rowProbe, null, 2));

  // Try clicking the first row that's actually a record (has more text content)
  const clickedRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[role="row"]'));
    // Find a row with substantial text content
    for (const r of rows) {
      const text = (r.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 5 && !/^Test Coll/.test(text) && !/^Table/.test(text) && !/^Collection/.test(text)) {
        // Find a clickable child or the row itself
        const cell = r.querySelector('[role="cell"], td, [class*="cell"]');
        if (cell) {
          cell.click();
          return { ok: true, text: text.slice(0, 60) };
        }
        r.click();
        return { ok: true, text: text.slice(0, 60) };
      }
    }
    return { ok: false };
  });
  console.log('clicked row:', clickedRow);
  await page.waitForTimeout(2000);

  // Check active record
  const activeCheck = await page.evaluate(() => ({
    activeRecordGuid: globalThis.__excalDebug?.activeRecordGuid,
    hasPanel: !!document.querySelector('.excal-panel-root'),
    panelText: document.querySelector('.excal-panel-root')?.textContent?.slice(0, 100),
  }));
  console.log('after click:', activeCheck);

  // Try the command palette
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(800);
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  const final = await page.evaluate(() => ({
    excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    panelRoot: document.querySelectorAll('.excal-panel-root').length,
    canvas: document.querySelectorAll('.excal-panel-stage canvas').length,
    hasSession: !!globalThis.__excalDebug?.Excalidraw,
    sessionInfo: globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.() || null,
  }));
  console.log('final:', final);

  console.log('--- last 15 console ---');
  for (const m of msgs.slice(-15)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
