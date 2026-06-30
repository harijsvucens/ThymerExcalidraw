#!/usr/bin/env node

import esbuild from "esbuild";
import fs from "node:fs";
import { resolve } from "node:path";

const MCP_URL = "http://127.0.0.1:13100";
const ROOT = resolve(import.meta.dirname, "..");
const DIST_JS = resolve(ROOT, "dist/plugin.js");
const PLUGIN_JSON = resolve(ROOT, "plugin.json");
const PLUGIN_NAME = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8")).name;

const args = process.argv.slice(2);
const previewOnly = args.includes("--preview-only");
const noPreview = args.includes("--no-preview");
const explicitWsGuid = process.env.THYMER_WS_GUID || null;

async function mcpCall(method, params) {
  const resp = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: method, arguments: params },
      id: 1,
    }),
  });
  const data = await resp.json();
  const content = data.result?.content || [];
  const text = content.map((c) => c.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function tryDiscoverWorkspace() {
  try {
    const result = await mcpCall("list_workspaces", {});
    if (result.active_workspace_guid) return result.active_workspace_guid;
    if (result.workspaces?.length) {
      const active = result.workspaces.find((w) => w.is_focused);
      if (active) return active.guid;
    }
  } catch { /* fall through */ }
  return null;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Step 1: Build
console.log("== Building plugin...");
try {
  await esbuild.build({
    entryPoints: [resolve(ROOT, "plugin.js")],
    bundle: false,
    platform: "browser",
    target: "es2020",
    legalComments: "none",
    outfile: DIST_JS,
    write: true,
    logLevel: "info",
  });
} catch (err) {
  die(`Build failed: ${err.message}`);
}
console.log("Build OK.");

// Step 2: Read output files
if (!fs.existsSync(DIST_JS)) die(`Missing ${DIST_JS}`);
const code = fs.readFileSync(DIST_JS, "utf8");
let configObj = {};
const configRaw = fs.readFileSync(PLUGIN_JSON, "utf8");
try {
  configObj = JSON.parse(configRaw);
} catch {
  die(`Invalid JSON in ${PLUGIN_JSON}`);
}

// Step 3: Discover workspace (optional — server defaults to active workspace when omitted)
console.log("== Discovering workspace...");
let wsGuid = explicitWsGuid;
if (!wsGuid) {
  try {
    wsGuid = await tryDiscoverWorkspace();
  } catch { /* ignore */ }
}
const wsArg = wsGuid ? { workspace: wsGuid } : {};
if (wsGuid) console.log(`Workspace: ${wsGuid}`);
else console.log("No workspace GUID — server will use active workspace.");

// Step 4: Preview (hot-reload, temporary) — skip with --no-preview to avoid
// preview_plugin's hot-reload window blinding the workspace to the canonical
// drawings collection (which spawns duplicate "Excalidrawings" collections).
if (!noPreview) {
  console.log("== Hot-reloading plugin...");
  try {
    await mcpCall("preview_plugin", {
      ...wsArg,
      plugin: PLUGIN_NAME,
      code,
      config: configObj,
    });
    console.log("Preview OK.");
  } catch (err) {
    die(`Preview failed: ${err.message}`);
  }
} else {
  console.log("== Skipping hot-reload (--no-preview). Plugin will be live on next manual reload.");
}

if (!previewOnly) {
  // Step 5: Persist code
  console.log("== Persisting plugin code...");
  try {
    await mcpCall("update_plugin_code", {
      ...wsArg,
      plugin: PLUGIN_NAME,
      code,
    });
    console.log("Code persisted.");
  } catch (err) {
    die(`Code persist failed: ${err.message}`);
  }

  // Step 6: Persist config
  console.log("== Persisting plugin config...");
  try {
    await mcpCall("update_plugin_json_config", {
      ...wsArg,
      plugin: PLUGIN_NAME,
      config: configRaw,
    });
    console.log("Config persisted.");
  } catch (err) {
    die(`Config persist failed: ${err.message}`);
  }

  console.log("Plugin deployed permanently.");
} else {
  console.log("Preview mode — changes are NOT persisted.");
  console.log("Re-run without --preview-only to deploy permanently.");
}
