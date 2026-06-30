// Deep probe: what plugins are loaded, what errors are in the console.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);

  // Listen to console BEFORE navigation
  const msgs = [];
  page.on('console', (m) => msgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

  await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  const state = await page.evaluate(() => {
    const out = {
      hasExcal: !!globalThis.__excalDebug?.Excalidraw,
      excal: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
      // Check if any plugin system is exposed
      hasPluginManager: !!globalThis.pluginManager,
      hasPlugins: !!globalThis.plugins,
      // Check workspace
      workspace: globalThis.workspace,
      // Look for plugin elements in the DOM
      excalEl: document.querySelectorAll('[class*="excal"]').length,
      pluginEls: document.querySelectorAll('[class*="plugin"]').length,
    };
    return out;
  });
  console.log('STATE:', JSON.stringify(state, null, 2));
  console.log('--- recent console ---');
  for (const m of msgs.slice(-80)) console.log(m);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
