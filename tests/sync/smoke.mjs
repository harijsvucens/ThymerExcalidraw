// Smoke test: connect to Chrome, verify plugin is loaded, open a panel.
import { connectBrowser, getThymerTab, openTab } from '../lib/cdp.mjs';
import { waitFor, waitForPlugin, writeReport } from '../lib/drawing.mjs';

async function main() {
  const browser = await connectBrowser();
  console.log('connected to browser');

  // Use existing Thymer tab (user already has one open)
  let page = getThymerTab(browser);
  if (!page) {
    page = await openTab(browser, 'https://harry.thymer.com/', 'smoke');
  }
  console.log('on tab:', page.url());

  // Capture current url state
  const urlState = await page.evaluate(() => ({
    url: location.href,
    hasPlugin: !!globalThis.__excalDebug?.Excalidraw,
    pluginKeys: globalThis.__excalDebug ? Object.keys(globalThis.__excalDebug) : [],
  }));
  console.log('plugin state:', urlState);

  // Wait for plugin
  const pluginReady = await waitForPlugin(page, 20000);
  console.log('plugin ready:', pluginReady);

  if (!pluginReady) {
    writeReport('smoke-no-plugin', { ok: false, url: page.url(), urlState });
    await browser.close();
    return;
  }

  // Read what the debug object exposes
  const sessionInfo = await page.evaluate(() => {
    const dbg = globalThis.__excalDebug?.Excalidraw;
    return {
      getSessionInfo: typeof dbg?.getSessionInfo === 'function',
      injectWsMessage: typeof dbg?.injectWsMessage === 'function',
      getPluginGuid: typeof dbg?.getPluginGuid === 'function' ? dbg.getPluginGuid() : null,
      currentSession: dbg?.getSessionInfo?.() || null,
    };
  });
  console.log('session info:', JSON.stringify(sessionInfo, null, 2));

  writeReport('smoke', {
    ok: true,
    url: page.url(),
    urlState,
    sessionInfo,
  });

  // Stay open for follow-up
  console.log('smoke test complete; browser left open for next test');
  // Don't close — let the next test reuse this connection
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
