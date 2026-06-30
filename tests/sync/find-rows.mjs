// Find dispatch=open or similar for record rows, and the right selector.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('[data-guid="1H3Z8J1WYR0S4FPM967TR298GF"]').first().click();
  await page.waitForTimeout(2000);

  // Look for elements with dispatch=openRecord or similar
  const dispatch = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[dispatch]'));
    const dispatches = {};
    for (const el of all) {
      const d = el.getAttribute('dispatch');
      dispatches[d] = (dispatches[d] || 0) + 1;
    }
    return dispatches;
  });
  console.log('dispatch attrs:', dispatch);

  // Look for the actual table view DOM
  const viewDOM = await page.evaluate(() => {
    // The Test Collection's table view
    const panels = Array.from(document.querySelectorAll('.panel-tab'));
    return panels.map((p) => ({
      tab: p.querySelector('.panel-tab--title')?.textContent || '?',
      data: p.getAttribute('data-cid') || '',
      childCount: p.querySelectorAll('*').length,
    }));
  });
  console.log('panels:', JSON.stringify(viewDOM, null, 2));

  // Find the active panel
  const activePanel = await page.evaluate(() => {
    // Active panel is usually the one without 'collapsed' class
    const tabs = Array.from(document.querySelectorAll('.panel-tab'));
    const active = tabs.find((t) => !t.classList.contains('collapsed') && /Test Coll/.test(t.textContent || ''));
    if (!active) return null;
    const contentId = active.getAttribute('data-cid');
    const content = document.querySelector(`#${contentId}`) || active.nextElementSibling;
    return {
      tabId: contentId,
      contentChildren: content ? Array.from(content.children).slice(0, 5).map((c) => ({
        tag: c.tagName,
        cls: c.className?.toString?.()?.slice(0, 60),
        childCount: c.children.length,
      })) : [],
    };
  });
  console.log('active panel:', JSON.stringify(activePanel, null, 2));

  // Try to find record rows by their typical class
  const rowsByClass = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const withData = all.filter((el) => el.hasAttribute('data-id') || el.hasAttribute('data-record-guid') || el.hasAttribute('data-row-id'));
    return withData.slice(0, 10).map((el) => ({
      tag: el.tagName,
      cls: el.className?.toString?.()?.slice(0, 60),
      attrs: Array.from(el.attributes).map((a) => `${a.name}=${a.value.slice(0, 40)}`),
      text: (el.textContent || '').slice(0, 50).replace(/\s+/g, ' ').trim(),
    }));
  });
  console.log('elements with data-id-like attrs:', JSON.stringify(rowsByClass, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
