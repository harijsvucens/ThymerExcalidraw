// Find the right selector for table rows in the Test Collection table view.
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

  // Deeper probe of the table
  const probe = await page.evaluate(() => {
    // Look for table cells with record data
    const cells = Array.from(document.querySelectorAll('td, [role="cell"]'));
    const cellData = cells.slice(0, 20).map((c) => ({
      text: (c.textContent || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
      cls: c.className?.toString?.()?.slice(0, 60),
      parent: c.parentElement?.className?.toString?.()?.slice(0, 60),
      grandparent: c.parentElement?.parentElement?.className?.toString?.()?.slice(0, 60),
    }));

    // Look for any clickable rows
    const tables = Array.from(document.querySelectorAll('[role="grid"], [role="table"], [class*="table"]'));
    const tableInfo = tables.slice(0, 5).map((t) => ({
      cls: t.className?.toString?.()?.slice(0, 60),
      childCount: t.children.length,
      childTags: Array.from(t.children).slice(0, 5).map((c) => c.tagName + '.' + (c.className?.toString?.()?.slice(0, 30) || '')),
    }));

    // Look for "id-data-record" or similar
    const dataRows = Array.from(document.querySelectorAll('[data-id], [class*="record-"], [class*="row-"]'));
    const dataInfo = dataRows.slice(0, 10).map((r) => ({
      tag: r.tagName,
      cls: r.className?.toString?.()?.slice(0, 80),
      attrs: Array.from(r.attributes).map((a) => `${a.name}=${a.value.slice(0, 30)}`),
      text: (r.textContent || '').slice(0, 50).replace(/\s+/g, ' ').trim(),
    }));

    return { cellData, tableInfo, dataInfo };
  });
  console.log(JSON.stringify(probe, null, 2));

  console.log('--- last 5 console ---');
  for (const m of msgs.slice(-5)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
