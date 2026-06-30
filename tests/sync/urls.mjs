// Probe different URL patterns to find the record open path.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  const probe = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const s = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      hasActiveRecord: !!document.querySelector('[class*="record"]'),
      hasPanel: !!document.querySelector('[class*="panel"]'),
      bodyChildren: document.body.children.length,
    }));
    return s;
  };

  const urls = [
    'https://harry.thymer.com/',
    'https://harry.thymer.com/?ws=WKXP9WA3F5TCTMV5PS747QVV8H',
    'https://harry.thymer.com/record/159BTXS2GAEDEG4Z7EVRP2YK8J',
    'https://harry.thymer.com/r/159BTXS2GAEDEG4Z7EVRP2YK8J',
    'https://harry.thymer.com/note/159BTXS2GAEDEG4Z7EVRP2YK8J',
    'https://harry.thymer.com/p/159BTXS2GAEDEG4Z7EVRP2YK8J',
  ];
  for (const u of urls) {
    try {
      const s = await probe(u);
      console.log(u, '->', JSON.stringify(s));
    } catch (e) {
      console.log(u, '-> ERR', e.message);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
