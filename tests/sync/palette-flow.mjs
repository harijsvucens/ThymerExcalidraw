// After MCP navigate_to_record opened the record, trigger the Excalidraw palette.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));

  // Focus the workspace (the MCP navigate happens in the user's session,
  // so the test Chrome needs to navigate too)
  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Use the command palette (Ctrl+Shift+P per earlier probe)
  console.log('opening command palette with Ctrl+Shift+P');
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(800);

  const palProbe = await page.evaluate(() => {
    const input = document.querySelector('input[class*="palette"], input[class*="command"], [class*="palette"] input');
    return {
      hasInput: !!input,
      inputClass: input?.className?.toString?.()?.slice(0, 80),
      activeTag: document.activeElement?.tagName,
      activeClass: document.activeElement?.className?.toString?.()?.slice(0, 80),
    };
  });
  console.log('palette probe:', palProbe);

  // Type to search
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(800);

  // Get palette items
  const items = await page.evaluate(() => {
    // Find visible palette items
    const candidates = Array.from(document.querySelectorAll('[class*="palette"] [class*="item"], [class*="command"] [class*="item"], [role="option"], [role="listbox"] > *'));
    return candidates.slice(0, 10).map((c) => ({
      text: (c.textContent || '').slice(0, 100).replace(/\s+/g, ' ').trim(),
      cls: c.className?.toString?.()?.slice(0, 60),
    }));
  });
  console.log('palette items:', JSON.stringify(items, null, 2));

  // Look for the Excalidraw command
  const excalItem = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*')).filter((el) => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t === 'Excalidraw: Open drawing for this note';
    });
    return all.length;
  });
  console.log('Excalidraw command matches:', excalItem);

  // Press Enter to select first
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);

  const after = await page.evaluate(() => ({
    excalDebugKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    panelRoot: document.querySelectorAll('.excal-panel-root').length,
    canvas: document.querySelectorAll('.excal-panel-stage canvas').length,
    hasSession: !!globalThis.__excalDebug?.Excalidraw,
    sessionInfo: globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.() || null,
    panelText: document.querySelector('.excal-panel-root')?.textContent?.slice(0, 100),
  }));
  console.log('after palette:', after);

  console.log('--- last 15 console ---');
  for (const m of msgs.slice(-15)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
