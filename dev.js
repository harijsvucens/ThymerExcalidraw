import esbuild from 'esbuild';
import chokidar from 'chokidar';
import CDP from 'chrome-remote-interface';
import fs from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'plugin.js');
const OUT = resolve(process.cwd(), 'dist/plugin.js');
const JSON_SRC = resolve(process.cwd(), 'plugin.json');
const DEBUG_PORT = Number(process.env.THYMER_DEBUG_PORT || '9222');
const once = process.argv.includes('--once');

const buildCtx = await esbuild.context({
  entryPoints: [SRC],
  bundle: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: once ? false : 'inline',
  minify: once,
  legalComments: 'none',
  outfile: OUT,
  write: true,
  logLevel: 'info',
});

if (once) {
  await buildCtx.rebuild();
  console.log('Built -> ' + OUT);
  process.exit(0);
}

await buildCtx.rebuild();
await buildCtx.watch();
console.log('Watching for changes...');

async function connectToThymerTarget() {
  const targets = await CDP.List({ port: DEBUG_PORT });
  for (const target of targets.filter(t => t.type === 'page')) {
    let client;
    try {
      client = await CDP({ target, port: DEBUG_PORT });
      await client.Runtime.enable();
      const { result } = await client.Runtime.evaluate({
        expression: "typeof window.refreshPlugin === 'function' ? 'ready' : null",
        returnByValue: true,
      });
      if (result.value === 'ready') return client;
      await client.close();
    } catch {
      if (client) await client.close();
    }
  }
  return null;
}

function push(jsCode, jsonConf) {
  const expr = 'window.refreshPlugin(' + JSON.stringify(jsCode) + ', ' + JSON.stringify(jsonConf) + ')';
  tab.Runtime.evaluate({ expression: expr, awaitPromise: true })
    .then((r) => {
      if (r.exceptionDetails) {
        console.error('Push failed:', r.exceptionDetails.text);
      } else if (r.result && r.result.value && r.result.value.success === false) {
        console.error('Push failed:', r.result.value.error);
      } else {
        console.log('Hot-reloaded in Thymer');
      }
    })
    .catch((e) => console.error('Push error:', e));
}

function pushCurrent() {
  try {
    const js = fs.readFileSync(SRC, 'utf8');
    const json = fs.readFileSync(JSON_SRC, 'utf8');
    push(js, json);
  } catch (e) {
    console.error('Read error:', e.message);
  }
}

let tab = await connectToThymerTarget();
if (tab) {
  console.log('Connected to Thymer - hot-reload ready');
  pushCurrent();
} else {
  console.warn('Thymer debug target not found. Run with --once to build only.');
}

if (tab) {
  let timer = null;
  chokidar.watch([SRC, JSON_SRC], { ignoreInitial: true })
    .on('change', (f) => {
      console.log('Changed: ' + f);
      clearTimeout(timer);
      timer = setTimeout(pushCurrent, 100);
    });
}
