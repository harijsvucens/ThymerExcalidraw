#!/usr/bin/env node
import fs from 'node:fs';
import { resolve } from 'node:path';

const MCP_URL = 'http://127.0.0.1:13100';
const WORKSPACE = 'WKXP9WA3F5TCTMV5PS747QVV8H';
const COLLECTION = '1Z4RHRCF721RRBVGNWNY4NX56Z';
const RECORD = '1NVHN7RE5AB9QGEJ5S5TT6HM5S';
const FIELD_NAME = 'Scene';

const DOT_IDS = new Set(['eOlgiT2YZ1WDnEY2L_0vK', 'qsV6oaUUHd7Mtlwkdzw1Z']);
const TEXT_ID = 'ZgF7a6mT4_BgPIWbnE6Zs';
const NEW_TEXT_VERSION = 1;
const NEW_TEXT_NONCE = 540171372;

async function mcpCall(method, params) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: method, arguments: params }, id: 1 }),
  });
  const data = await resp.json();
  const text = (data.result?.content || []).map((c) => c.text).join('');
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const record = await mcpCall('get_record', { workspace: WORKSPACE, record: RECORD, format: 'structured' });
const props = record?.record?.properties || record?.properties || {};
const sceneProp = props['Scene'];

let sceneText = null;
if (Array.isArray(sceneProp) && sceneProp[0] === 'text' && typeof sceneProp[1] === 'string') {
  sceneText = sceneProp[1];
}

if (!sceneText) {
  console.error('Could not find Scene text. Available prop keys:', Object.keys(props));
  console.error('Scene prop value (first 200 chars):', JSON.stringify(sceneProp).slice(0, 200));
  process.exit(1);
}

console.log('Scene text length:', sceneText.length);
const outer = JSON.parse(sceneText);
const sceneJsonStr = outer?.scene?.sceneJson;
if (!sceneJsonStr) {
  console.error('No sceneJson found in outer. Keys:', Object.keys(outer || {}), 'scene keys:', Object.keys(outer?.scene || {}));
  process.exit(1);
}
const scene = JSON.parse(sceneJsonStr);
console.log('Elements before:', scene.elements.length);
const beforeIds = scene.elements.map((e) => e.id);
const removedDots = [];
const textReset = [];

scene.elements = scene.elements.filter((el) => {
  if (DOT_IDS.has(el.id)) {
    removedDots.push({ id: el.id, type: el.type, pointsLen: el.points?.length, width: el.width, height: el.height });
    return false;
  }
  if (el.id === TEXT_ID) {
    const oldVersion = el.version;
    el.version = NEW_TEXT_VERSION;
    el.versionNonce = NEW_TEXT_NONCE;
    el.updated = Date.now();
    textReset.push({ id: el.id, oldVersion, newVersion: el.version });
  }
  return true;
});

console.log('Elements after:', scene.elements.length);
console.log('Removed dots:', removedDots);
console.log('Text reset:', textReset);

outer.scene.sceneJson = JSON.stringify(scene);
const newSceneText = JSON.stringify(outer);

const updateResult = await mcpCall('update_record_property', {
  workspace: WORKSPACE,
  record: RECORD,
  property: FIELD_NAME,
  value: newSceneText,
});

console.log('Update result:', JSON.stringify(updateResult, null, 2));
fs.writeFileSync('cleanup-result.json', JSON.stringify({ removedDots, textReset, updateResult }, null, 2));
console.log('Done. Wrote cleanup-result.json');
