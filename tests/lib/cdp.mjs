// CDP connection helpers using playwright-core.
// We connect to the dedicated test Chrome instance on port 9223.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const LOG_DIR = join(PROJECT_ROOT, 'tests', 'logs');

mkdirSync(LOG_DIR, { recursive: true });

const CDP_URL = process.env.EXCAL_TEST_CDP_URL || 'http://127.0.0.1:9223';
const EXCAL_VERSION = process.env.EXCAL_VERSION || '0.5.4';

/**
 * Connect to the test Chrome instance over CDP.
 * Returns a playwright Browser object.
 */
export async function connectBrowser() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

/**
 * Return an open tab whose URL matches the predicate, or null.
 */
export function findTab(browser, predicate) {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (predicate(page)) return page;
    }
  }
  return null;
}

/**
 * Get the main Thymer tab (or null if not open).
 */
export function getThymerTab(browser) {
  return findTab(browser, (p) => {
    const url = p.url();
    return /^https?:\/\/(harry\.)?thymer\.com\//.test(url);
  });
}

/**
 * Open a new tab pointing at the given URL, with console-message capture.
 */
export async function openTab(browser, url, label = '') {
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  const logFile = join(LOG_DIR, `${label || 'tab'}-${Date.now()}.log`);
  const logLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    logLines.push(line);
  });
  page.on('pageerror', (err) => {
    logLines.push(`[pageerror] ${err.message}`);
  });
  page._excalLog = logLines;
  page._excalLogFile = logFile;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * Filter captured console log by a regex; return matched lines.
 */
export function filterLog(page, re) {
  return (page._excalLog || []).filter((l) => re.test(l));
}

/**
 * Persist captured log to disk.
 */
export async function flushLog(page) {
  if (!page || !page._excalLog) return;
  try {
    const fs = await import('node:fs/promises');
    await fs.writeFile(page._excalLogFile, page._excalLog.join('\n'));
  } catch (_) {}
}

export { EXCAL_VERSION, PROJECT_ROOT, LOG_DIR, CDP_URL };
