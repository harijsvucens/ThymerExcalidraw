// Test harness: connect, open a record, open Excalidraw, run scenario.
import { connectBrowser, getThymerTab } from './cdp.mjs';
import { writeReport } from './report.mjs';

/**
 * Wait for the Excalidraw plugin to have an active session.
 */
export async function waitForExcalSession(page, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(() => {
      const dbg = globalThis.__excalDebug?.Excalidraw;
      if (!dbg) return null;
      const info = dbg.getSessionInfo?.();
      return info && info.elementCount != null ? info : null;
    });
    if (ok) return ok;
    await page.waitForTimeout(200);
  }
  return null;
}

/**
 * Open a record by clicking its sidebar item.
 */
export async function openRecordBySidebarClick(page, recordGuid) {
  const sel = `[data-guid="${recordGuid}"]`;
  const found = await page.locator(sel).count();
  if (found === 0) throw new Error(`record ${recordGuid} not in sidebar`);
  await page.locator(sel).first().scrollIntoViewIfNeeded();
  await page.locator(sel).first().click();
  await page.waitForTimeout(1500);
}

/**
 * Open the Excalidraw command via the command palette.
 * Assumes a record is currently active.
 */
export async function openExcalViaCommandPalette(page) {
  await page.keyboard.press('Control+Shift+p');
  await page.waitForTimeout(600);
  // Clear any existing text
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
}

/**
 * Read the Excalidraw scene elements via the React fiber walk.
 * Returns { elements: [...] } or { error: '...' }.
 */
export async function readSceneElements(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return { error: 'no .excal-panel-stage in DOM' };
    const canvas = stage.querySelector('canvas');
    if (!canvas) return { error: 'no canvas inside .excal-panel-stage' };
    // Excalidraw renders shapes as SVG; the canvas is just for pointer events.
    // The React fiber with the excalApi lives on a parent/grandparent of the canvas.
    // Try walking up from the canvas's parent.
    const startNodes = [
      canvas,
      canvas.parentElement,
      canvas.parentElement?.parentElement,
      canvas.parentElement?.parentElement?.parentElement,
    ].filter(Boolean);

    for (const start of startNodes) {
      const reactKey = Object.keys(start).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
      );
      if (!reactKey) continue;
      let fiber = start[reactKey];
      let hops = 0;
      while (fiber && hops < 80) {
        const sn = fiber.stateNode;
        if (sn && typeof sn.getSceneElements === 'function') {
          try {
            const els = sn.getSceneElements() || [];
            return {
              ok: true,
              elements: els.map((e) => ({
                id: e.id,
                type: e.type,
                x: e.x, y: e.y, width: e.width, height: e.height,
                points: e.points,
                text: e.text,
                version: e.version,
                versionNonce: e.versionNonce,
                updated: e.updated,
                isDeleted: e.isDeleted,
                seed: e.seed,
              })),
            };
          } catch (e) {
            return { error: `getSceneElements threw: ${e.message}` };
          }
        }
        fiber = fiber.return;
        hops++;
      }
    }
    return { error: 'no fiber with getSceneElements found walking from canvas/parent/gp' };
  });
}

/**
 * Inject a WS message into the running session (test only).
 * Mimics a remote excal-delta arriving.
 */
export async function injectWsDelta(page, { senderId, elements, deletedIds = [] }) {
  return page.evaluate(({ senderId, elements, deletedIds }) => {
    const dbg = globalThis.__excalDebug?.Excalidraw;
    if (!dbg?.injectWsMessage) return { ok: false, error: 'no injectWsMessage' };
    const session = dbg.getSessionInfo();
    dbg.injectWsMessage({
      type: 'excal-delta',
      data: {
        senderId,
        drawingGuid: session.recordGuid,
        elements,
        deletedIds,
      },
    });
    return { ok: true };
  }, { senderId, elements, deletedIds });
}

/**
 * Open a second browser context (new context = new V8 realm).
 * Used for cross-instance tests.
 */
export async function openSecondContext(browser, url) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Read the persisted scene text from the DB via the plugin's record
 * reference. The plugin exposes `data.getRecord` which we can call.
 */
export async function readPersistedScene(page, drawingGuid) {
  return page.evaluate(async (guid) => {
    // The plugin uses data.getRecord(guid).text('scene')
    // We don't have direct access to the plugin's data, but the plugin
    // also exposes __excalDebug.session — wait, it doesn't. Use the
    // injection hook: read via the same API the plugin uses.
    // The plugin's data is on this.data inside the plugin instance.
    // We can fetch the scene text from the same source the plugin uses
    // by reading from a hidden React fiber on the panel.
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return { error: 'no panel stage' };
    // No public hook for this. Fall back: parse from the active record
    // by reading what the plugin's last save wrote. Since we don't have
    // a direct read API, we use the document cache via the Thymer data
    // service worker.
    if (!globalThis.__excalDebug?._persistedScene) {
      return { error: 'no persisted scene cached. Use the postMessage bridge or run MCP test.' };
    }
    return globalThis.__excalDebug._persistedScene;
  }, drawingGuid);
}

export { writeReport };
