// Find the actual table content and the right way to click a record.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('[data-guid="1H3Z8J1WYR0S4FPM967TR298GF"]').first().click();
  await page.waitForTimeout(2500);

  // Find elements containing record titles
  const recordEls = await page.evaluate(() => {
    const titles = ['index', 'Correspondence', 'Some other record', 'Untitled Test record', 'Tasks'];
    const found = [];
    for (const t of titles) {
      const els = Array.from(document.querySelectorAll('*')).filter((el) => {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return txt === t && el.children.length < 5; // leaf-ish element
      });
      for (const el of els.slice(0, 3)) {
        found.push({
          title: t,
          tag: el.tagName,
          cls: el.className?.toString?.()?.slice(0, 80),
          parentCls: el.parentElement?.className?.toString?.()?.slice(0, 80),
          grandparentCls: el.parentElement?.parentElement?.className?.toString?.()?.slice(0, 80),
          attrs: Array.from(el.attributes).map((a) => `${a.name}=${a.value.slice(0, 40)}`),
          rect: el.getBoundingClientRect(),
        });
      }
    }
    return found;
  });
  console.log('record title elements:', JSON.stringify(recordEls, null, 2));

  // Also dump the body structure summary
  const body = await page.evaluate(() => {
    function dump(el, depth = 0, max = 4) {
      if (depth > max) return null;
      const children = Array.from(el.children).map((c) => dump(c, depth + 1, max)).filter(Boolean);
      return {
        tag: el.tagName,
        cls: el.className?.toString?.()?.slice(0, 60) || '',
        id: el.id || '',
        cid: el.getAttribute('data-cid') || '',
        childCount: el.children.length,
        text: el.children.length === 0 ? (el.textContent || '').slice(0, 40).replace(/\s+/g, ' ').trim() : '',
        children: children.length ? children : undefined,
      };
    }
    return dump(document.body);
  });
  console.log('body structure:', JSON.stringify(body, null, 2).slice(0, 4000));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
