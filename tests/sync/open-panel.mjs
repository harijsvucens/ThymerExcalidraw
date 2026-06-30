// Trigger the Excalidraw command and open a panel.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  // Capture console + errors
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message}`));

  // Navigate to a specific record
  const recordGuid = '159BTXS2GAEDEG4Z7EVRP2YK8J';
  const url = `https://harry.thymer.com/record/${recordGuid}`;
  console.log('navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  console.log('--- after navigation ---');
  for (const m of msgs.slice(-10)) console.log(m);

  // Try to open command palette (Ctrl+K) and run the Excalidraw command
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(800);

  // Type the command
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(800);

  // Press Enter
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => ({
    hasExcalDebug: !!globalThis.__excalDebug,
    excalKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    panelEls: document.querySelectorAll('.excal-panel-root').length,
    canvasEls: document.querySelectorAll('canvas').length,
    sidebars: document.querySelectorAll('.excal-sidebar-item').length,
  }));
  console.log('AFTER PALETTE:', JSON.stringify(after, null, 2));

  console.log('--- recent console ---');
  for (const m of msgs.slice(-30)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
