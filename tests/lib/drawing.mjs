// Thymer panel + drawing helpers using the live plugin API surface.
// The plugin installs window.__excalDebug[Excalidraw] and exposes
// session.excalApi. We drive both.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, LOG_DIR } from './cdp.mjs';

/**
 * Wait for the page to settle. Polls every 100ms until predicate is truthy
 * or timeout (ms) is hit. Returns the predicate's last value or null.
 */
export async function waitFor(page, predicate, { timeout = 10000, interval = 100, label = 'waitFor' } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (_) {}
    await page.waitForTimeout(interval);
  }
  return last;
}

/**
 * Wait for the main Excalidraw plugin to be available on the page.
 * Returns true when window.__excalDebug.Excalidraw exists.
 */
export async function waitForPlugin(page, timeout = 15000) {
  return waitFor(
    page,
    async () => await page.evaluate(() => !!globalThis.__excalDebug?.Excalidraw),
    { timeout, label: 'plugin' },
  );
}

/**
 * Wait for an open drawing panel (session.excalApi set) and return it.
 */
export async function waitForDrawingPanel(page, timeout = 15000) {
  return waitFor(
    page,
    async () => {
      const ok = await page.evaluate(() => {
        const dbg = globalThis.__excalDebug?.Excalidraw;
        if (!dbg) return null;
        const info = dbg.getSessionInfo?.();
        return info && info.elementCount != null ? info : null;
      });
      return ok;
    },
    { timeout, label: 'drawing-panel' },
  );
}

/**
 * Open the Excalidraw command-palette entry for the currently active record.
 * The plugin command is registered as "Excalidraw: Open drawing for this note".
 */
export async function openDrawingViaCommandPalette(page) {
  // The plugin's command is a registered custom one. We trigger it via
  // the same hook the plugin uses: __excalDebug.Excalidraw.injectWsMessage is
  // not the right entry, but we can dispatch a custom keyboard event after
  // focusing the workspace.
  //
  // The plugin installs a sidebar item as well. We try a more reliable path:
  // dispatch the command via the global registered command object that
  // ui.addCommandPaletteCommand returns. The plugin stores it on `this._cmdOpen`.
  //
  // Since we don't have direct access to the plugin instance from page context,
  // we use the sidebar fallback: click the .excal-sidebar-item if visible.
  const opened = await page.evaluate(() => {
    // Find the sidebar item the plugin mounted
    const sb = document.querySelector('.excal-sidebar-item');
    if (sb) {
      sb.click();
      return 'sidebar-click';
    }
    return null;
  });
  if (opened) return opened;

  // Fall back to keyboard palette
  await page.keyboard.press('Control+K');
  await page.waitForTimeout(300);
  await page.keyboard.type('Excalidraw');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  return 'palette';
}

/**
 * Get the current scene from the panel (if open) and return parsed.
 * Returns null if no panel.
 */
export async function getScene(page) {
  return page.evaluate(() => {
    const api = globalThis.__excalDebug?.Excalidraw?.getSessionInfo?.();
    if (!api) return null;
    // The plugin stores session on the global debug; we need access to excalApi.
    // The plugin only exposes getSessionInfo(); to read scene elements we
    // walk the React tree: the panel mounted Excalidraw which provides a
    // .excal-panel-stage; we call into excal via the same path the plugin
    // uses internally by reaching into the globalThis hook the plugin sets.
    // Strategy: read from the live window if plugin set excalApi globally,
    // otherwise from the React fiber of .excal-panel-stage.
    if (globalThis.__excalScene) return globalThis.__excalScene;
    return api;
  });
}

/**
 * Read the Excalidraw scene elements via the React fiber. The Excalidraw
 * component stores the latest elements on the internal state; we can reach
 * it by walking the fiber tree, but the more reliable path is to use the
 * plugin's own session object that it stores on globalThis via
 * __excalDebug — but it does not expose excalApi.
 *
 * The Excalidraw UMD component, when mounted, exposes a `_excalidrawAPI` ref
 * in the React tree, and we can fish it out via DOM events. Easiest:
 * the canvas DOM element's parent has the API on a __reactProps$ key.
 */
export async function readSceneElements(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.excal-panel-stage');
    if (!stage) return null;
    // The Excalidraw canvas is inside .excal-panel-stage
    const canvas = stage.querySelector('canvas');
    if (!canvas) return null;
    // Find the React fiber for the canvas's container
    const reactKey = Object.keys(canvas).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!reactKey) return { error: 'no react fiber on canvas' };
    // Walk up the fiber tree looking for stateNode with a getSceneElements method.
    let fiber = canvas[reactKey];
    let hops = 0;
    while (fiber && hops < 80) {
      const sn = fiber.stateNode;
      if (sn && typeof sn.getSceneElements === 'function') {
        try {
          const els = sn.getSceneElements() || [];
          return els.map((e) => ({
            id: e.id,
            type: e.type,
            x: e.x,
            y: e.y,
            width: e.width,
            height: e.height,
            points: e.points,
            text: e.text,
            version: e.version,
            versionNonce: e.versionNonce,
            updated: e.updated,
            isDeleted: e.isDeleted,
          }));
        } catch (e) {
          return { error: `getSceneElements threw: ${e.message}` };
        }
      }
      fiber = fiber.return;
      hops++;
    }
    return { error: `no fiber with getSceneElements after ${hops} hops` };
  });
}

/**
 * Simulate drawing a freedraw stroke on the Excalidraw canvas.
 * Uses mouse events at the canvas-local coordinates.
 *
 * path: array of {x, y} in canvas pixels (relative to the canvas top-left)
 * Each point fires pointermove with intermediate points.
 */
export async function drawFreedraw(page, path, { pauseMs = 0 } = {}) {
  if (!Array.isArray(path) || path.length < 2) throw new Error('path must be 2+ points');
  const canvas = page.locator('.excal-panel-stage canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 5000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');

  // Pick the freedraw tool. The Excalidraw toolbar has buttons; the freedraw
  // is typically index 3 in the default toolbar order. We click the keyboard
  // shortcut '5' which is freedraw in Excalidraw's default keymap.
  await canvas.click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(100);
  // Use the keyboard shortcut to switch to freedraw
  // (Excalidraw default: 5 = freedraw, 4 = line, 2 = rectangle, 3 = ellipse, 1 = selection, p = pen)
  await page.keyboard.press('5');
  await page.waitForTimeout(150);

  const start = path[0];
  const end = path[path.length - 1];

  // Press down at start
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  for (let i = 1; i < path.length; i++) {
    const p = path[i];
    await page.mouse.move(box.x + p.x, box.y + p.y, { steps: 1 });
    if (pauseMs > 0) await page.waitForTimeout(pauseMs);
  }
  await page.mouse.up();
  // Deselect
  await page.keyboard.press('1');
}

/**
 * Switch tools via Excalidraw keyboard shortcuts.
 */
export async function useTool(page, shortcut) {
  await page.keyboard.press(shortcut);
  await page.waitForTimeout(80);
}

/**
 * Draw a straight line from a to b.
 */
export async function drawLine(page, a, b) {
  const canvas = page.locator('.excal-panel-stage canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 5000 });
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(80);
  await page.keyboard.press('4'); // 4 = line
  await page.waitForTimeout(120);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  await page.mouse.move(box.x + b.x, box.y + b.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('1');
}

/**
 * Read all "DIAG:" log lines that have been captured since test start.
 */
export function diagLines(page) {
  return (page._excalLog || []).filter((l) => /\[Excalidraw\]/.test(l) && /DIAG/.test(l));
}

/**
 * Wait N ms in real time (use sparingly).
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Write a report object to tests/baseline/<name>.json
 */
export function writeReport(name, data) {
  const path = join(PROJECT_ROOT, 'tests', 'baseline', `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}
