# Excalidraw (Thymer global plugin)

Side-panel Excalidraw sketches tied to the **currently open note**. One drawing per note; data lives in the **Excalidrawings** collection with bidirectional note links.

## Install

1. In Thymer: **Command Palette → Plugins → Create Plugin** (Global / App plugin), or open an existing global plugin slot.
2. Paste [`plugin.json`](plugin.json) into **Configuration**.
3. Paste the full [`plugin.js`](plugin.js) into **Custom Code** and save.
4. Reload Thymer.

On first use the plugin creates an **Excalidrawings** collection (if missing) and, on first save from a note, adds an **Excalidrawing** property to that note's collection when the schema allows it.

## Use

1. Open any note.
2. **Command Palette → `Excalidraw: Open drawing for this note`**
3. A new panel opens with the canvas. Edits **auto-save** after ~1.5s idle.
4. Close the panel when done — a final save runs on close.

Each note has its own drawing record titled **`<note title> · Excalidrawing`**. Reopen the command on the same note to continue editing.

## Storage

| What | Where |
|------|--------|
| Scene JSON | **Excalidrawings** → **Scene** property on each drawing record |
| Back-link | **Source note** on the drawing record |
| Forward link | **Excalidrawing** on the source note (auto-added to collection schema when possible) |

Legacy drawings in **Plugin Backend** (`record_kind` = `drawing`) are still **read** for migration; new saves go to **Excalidrawings** only.

## Performance notes

- Excalidraw loads via **classic UMD script tags** (unpkg/jsDelivr) — works in Thymer's plugin sandbox where ES modules hang.
- If UMD fails, falls back to an **excalidraw.com iframe** (draw immediately; persist via Share link button).
- Nothing runs on idle pages beyond the lightweight plugin bootstrap.

## Troubleshooting

- **Stuck on "Loading editor…"** — re-paste latest `plugin.js`. Status should advance through "Loading React…", "Loading Excalidraw…", then show the canvas or excalidraw.com iframe.
- **Iframe mode** — full Excalidraw site embedded. After drawing: Menu → Share → Get link, then click **Save share link to note** in the toolbar.
- **Excalidrawing property not added** — some collection plugins lock schema (`managed.fields`). Add a record field named **Excalidrawing** manually, filtered to **Excalidrawings**.

## Config (`plugin.json` → `custom`)

| Key | Default | Purpose |
|-----|---------|---------|
| `cdnVersion` | `0.17.6` | Pin `@excalidraw/excalidraw` UMD version |
| `autosaveMs` | `1500` | Debounced save delay (minimum 800) |
