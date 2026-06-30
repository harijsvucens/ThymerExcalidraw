// Diagnose what state the workspace is in and where the plugin lives.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';

async function main() {
  const browser = await connectBrowser();
  const page = getThymerTab(browser);
  console.log('tab url:', page.url());

  // Give the workspace time to fully boot
  await page.waitForTimeout(3000);

  const diag = await page.evaluate(() => {
    const out = {
      href: location.href,
      title: document.title,
      hasExcalDebug: !!globalThis.__excalDebug,
      excalKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
      hasPluginSettings: !!globalThis.ThymerPluginSettings,
      workspaceData: null,
      sidebarItem: !!document.querySelector('.excal-sidebar-item'),
      // Sample iframe structure
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
        src: f.src,
        name: f.name,
        id: f.id,
      })),
      // Plugin global state
      pluginFlags: {
        excal: globalThis.__excalDebug?.Excalidraw ? 'yes' : 'no',
        bootCollectionGuid: globalThis.__excalDebug?.bootCollectionGuid ?? null,
      },
    };
    return out;
  });
  console.log(JSON.stringify(diag, null, 2));

  // Wait longer and re-check
  await page.waitForTimeout(8000);
  const after = await page.evaluate(() => ({
    hasExcalDebug: !!globalThis.__excalDebug,
    excalKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : null,
    hasSidebarItem: !!document.querySelector('.excal-sidebar-item'),
    bootGuid: globalThis.__excalDebug?.bootCollectionGuid,
  }));
  console.log('after 11s:', JSON.stringify(after, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
