# Deployment — ThymerExcalidraw

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Watch mode + CDP hot-reload (development only) |
| `npm run deploy:preview` | Build + MCP hot-reload (no persist — safe to test) |
| `npm run deploy` | Build + MCP hot-reload + persist code + config permanently |
| `npm run push` | Alias for `deploy` |

## MCP deploy (recommended for production)

The `deploy` script uses Thymer Desktop's MCP server (port `13100`) to push the plugin:

1. Builds `plugin.js` with esbuild — **no minification, no module format** (must preserve `class Plugin extends AppPlugin` as a global)
2. Calls `preview_plugin` — hot-reloads into the active workspace
3. Calls `update_plugin_code` — persists the code permanently
4. Calls `update_plugin_json_config` — persists `plugin.json` permanently

### Targeting a specific workspace

By default, the script deploys to whatever workspace the MCP server considers active. To deploy to a specific workspace:

```bash
# Thymer-Cabinet sync
$env:THYMER_WS_GUID="WKXP9WA3F5TCTMV5PS747QVV8H"; npm run deploy

# Harry's Workspace
$env:THYMER_WS_GUID="W6CDWK9CQRRWPJV2K5SM9YSW6P"; npm run deploy
```

## CDP hot-reload (development)

`npm run dev` watches source files and pushes changes via Chrome DevTools Protocol (port `9222`). It pushes the **source** `plugin.js` directly — not the built `dist/plugin.js`.

**Prerequisites:**
1. Chrome running with `--remote-debugging-port=9222`
2. Thymer open in that Chrome session
3. Plugin Hot Reload enabled (Plugins > Edit Code > Developer Tools > Enable Plugin Hot Reload)

## Build vs deploy — critical distinction

Do NOT use `dist/plugin.js` from `npm run build:quick` (or `dev.js --once`) as production paste into Thymer. The `dev.js` build uses `format: 'esm'` + `minify: true`, which causes esbuild's minifier to rename `class Plugin` to a shorter identifier (since it's not exported). Thymer's plugin loader then fails with:

```
TypeError: Failed to construct 'Plugin': Illegal constructor
```

The deployment script (`scripts/deploy-plugin.mjs`) avoids this by building without a module format and without minification.

## Verification

After deploying:

1. **Hard-reload Thymer** (`Ctrl+Shift+R` or `Cmd+Shift+R`) to clear any cached broken state
2. Open a note and click the Excalidraw icon — the side panel should load
3. Check the browser console for errors (`F12` > Console tab)
4. If the plugin fails to load, run `npm run deploy:preview` with the debug fix and check console errors

## If the plugin crashes on load

If a bad deploy causes "Failed to construct 'Plugin'" or similar:

1. Use Safe Mode: append `?safe=1` to the Thymer URL to disable all plugins
2. Deploy the fix: `npm run deploy` with the corrected code
3. Reload without Safe Mode
