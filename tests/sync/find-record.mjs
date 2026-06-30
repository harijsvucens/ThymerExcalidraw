// Find how to open a record from the workspace home.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Look for collection/record links
  const probe = await page.evaluate(() => {
    const out = {
      allLinks: Array.from(document.querySelectorAll('a, [role="link"], [data-record-id], [data-guid]'))
        .slice(0, 30)
        .map((el) => ({
          tag: el.tagName,
          cls: el.className?.toString?.().slice(0, 80) || '',
          href: el.getAttribute?.('href') || '',
          guid: el.getAttribute?.('data-guid') || el.getAttribute?.('data-record-id') || '',
          text: (el.textContent || '').slice(0, 50),
        })),
      // Look for the Test Collection which holds the records
      testCollectionLink: !!document.querySelector('[href*="Test"], [data-name*="Test"]'),
      recordTitles: Array.from(document.querySelectorAll('[class*="title"], [class*="name"]'))
        .slice(0, 20)
        .map((el) => (el.textContent || '').slice(0, 50)),
    };
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
