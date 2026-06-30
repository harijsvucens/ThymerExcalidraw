// T2 baseline: idle broadcasts. Open the panel, wait 20s, count broadcasts.
import { connectBrowser, getThymerTab } from '../lib/cdp.mjs';
import {
  waitForExcalSession,
  writeReport,
} from '../lib/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await connectBrowser();
  const ctx = browser.contexts()[0];
  let page = getThymerTab(browser);
  if (!page) {
    page = await ctx.newPage();
    await page.goto('https://harry.thymer.com/', { waitUntil: 'domcontentloaded' });
  }
  const ws = 'WKXP9WA3F5TCTMV5PS747QVV8H';
  const recordGuid = '1NQQENF9Y1GRCS8YKTHC8CRBKR'; // Tasks — has the bad data
  const url = `https://harry.thymer.com/?open=${ws}.${recordGuid}#Tasks`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log('title:', await page.title());

  const msgs = [];
  page.on('console', (m) => msgs.push({ t: m.type(), text: m.text(), at: Date.now() }));

  await page.keyboard.press('Control+p');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('Excalidraw: Open drawing for this note', { delay: 8 });
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(8000);

  const session = await waitForExcalSession(page, 15000);
  console.log('session:', session);

  if (!session) {
    writeReport('T2-idle', { ok: false, error: 'no session' });
    await browser.close();
    return;
  }

  // Reset counter and idle for 20s
  const startIdx = msgs.length;
  const startAt = Date.now();
  console.log('idling 20s...');
  await sleep(20000);
  const endAt = Date.now();
  const idleMsgs = msgs.slice(startIdx);

  const idleBroadcasts = idleMsgs.filter((m) => /DIAG: broadcasting/.test(m.text));
  const idleOnChanges = idleMsgs.filter((m) => /DIAG: onChange/.test(m.text));
  const idleRecv = idleMsgs.filter((m) => /DIAG RECV/.test(m.text));

  const report = {
    ok: true,
    session,
    durationMs: endAt - startAt,
    broadcasts: idleBroadcasts.length,
    broadcastDetails: idleBroadcasts.map((m) => m.text.slice(0, 200)),
    onChanges: idleOnChanges.length,
    recv: idleRecv.length,
    sampleMsgs: idleMsgs.slice(0, 20).map((m) => m.text.slice(0, 200)),
  };
  writeReport('T2-idle', report);
  console.log('IDLE REPORT:');
  console.log(JSON.stringify(report, null, 2).slice(0, 3000));

  await browser.close();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
