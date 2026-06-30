// Try different command palette shortcuts and the sidebar item direct click.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Try opening a record via the sidebar collection click
  await page.locator('[data-guid="1H3Z8J1WYR0S4FPM967TR298GF"]').first().click();
  await page.waitForTimeout(2000);

  // Look for table rows in the main panel
  const tableProbe = await page.evaluate(() => {
    const rows = document.querySelectorAll('[role="row"], [class*="row"]');
    const links = document.querySelectorAll('a[href*="record"], [data-record-id]');
    const titles = Array.from(document.querySelectorAll('[class*="title"], [class*="name"]'))
      .slice(0, 30)
      .map((e) => ({
        text: (e.textContent || '').slice(0, 40).replace(/\s+/g, ' ').trim(),
        cls: e.className?.toString?.().slice(0, 60),
      }));
    return { rowCount: rows.length, linkCount: links.length, titles };
  });
  console.log('table probe:', JSON.stringify(tableProbe, null, 2));

  // Try Ctrl+J (Thymer palette)
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(800);
  const palJ = await page.evaluate(() => ({
    visible: !!document.querySelector('[class*="palette"]:not([style*="display: none"])'),
    inputFocused: document.activeElement?.tagName === 'INPUT',
    activeEl: document.activeElement?.className?.toString?.()?.slice(0, 50),
  }));
  console.log('Ctrl+J palette:', palJ);

  // Try Ctrl+Shift+P
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(800);
  const palP = await page.evaluate(() => ({
    visible: !!document.querySelector('[class*="palette"]:not([style*="display: none"])'),
    inputFocused: document.activeElement?.tagName === 'INPUT',
  }));
  console.log('Ctrl+Shift+P palette:', palP);

  // Try Ctrl+K
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(800);
  const palK = await page.evaluate(() => ({
    visible: !!document.querySelector('[class*="palette"]:not([style*="display: none"])'),
    inputFocused: document.activeElement?.tagName === 'INPUT',
    activeClass: document.activeElement?.className?.toString?.()?.slice(0, 80),
  }));
  console.log('Ctrl+K palette:', palK);

  // Get all key bindings from the page
  const bindings = await page.evaluate(() => {
    // Look for any element with data-hotkey or similar
    return {
      allHotkeys: Array.from(document.querySelectorAll('[data-hotkey], [data-kbd], [data-key]'))
        .slice(0, 20)
        .map((e) => ({
          k: e.getAttribute('data-hotkey') || e.getAttribute('data-kbd') || e.getAttribute('data-key'),
          cls: e.className?.toString?.().slice(0, 60),
        })),
    };
  });
  console.log('hotkeys:', JSON.stringify(bindings, null, 2));

  console.log('--- last 15 console ---');
  for (const m of msgs.slice(-15)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
