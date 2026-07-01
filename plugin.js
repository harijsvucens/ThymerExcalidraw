// ==Plugin==
// name: Excalidraw
// description: Side-panel sketches synced per note (Excalidrawings collection + note links)
// icon: ti-palette
// ==/Plugin==

// @generated BEGIN thymer-plugin-settings (source: plugins/public repo/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Create dedupe: Web Locks + **per-workspace** localStorage lease/recent-create keys (workspaceGuid from
 * `data.getActiveUsers()[0]`), plus abort if an exact-named Plugin Backend collection already exists.
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** In-flight dedupe: parallel plugin `init()` calls share one `getAllCollections()` snapshot. */
  const DATA_GET_ALL_P = '__thymerExtGetAllCollectionsInflight';

  function preferDeferredHeavyWork() {
    try {
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
    } catch (_) {}
    try {
      return Number(navigator?.maxTouchPoints) > 0;
    } catch (_) {}
    return false;
  }

  const MOBILE_GRACE_UNTIL_KEY = '__thymerExtMobileGraceUntil';
  const MOBILE_HIDDEN_AT_KEY = '__thymerExtMobileHiddenAt';
  const MOBILE_INTERACT_THROTTLE_AT_KEY = '__thymerExtMobileInteractThrottleAt';
  /** Brief host-bootstrap window — long grace periods stacked with per-plugin cold-start timers and blocked panel mounts felt like ~2 min to “fully ready”. */
  const MOBILE_GRACE_MS = 15000;
  const MOBILE_RESUME_GRACE_MS = 10000;
  const MOBILE_RESUME_AWAY_MS = 15000;
  /** Interaction only pauses the heavy-work queue briefly — do not extend MOBILE_GRACE. */
  const MOBILE_HEAVY_PAUSE_ON_INTERACT_MS = 6000;
  const MOBILE_INTERACTION_THROTTLE_MS = 2500;
  const HEAVY_QUEUE_PAUSED_UNTIL_KEY = '__thymerExtHeavyQueuePausedUntil';

  // Heavy work scheduler: many plugins "wake up" together after mobile grace ends.
  // Running them concurrently causes long-task storms that block navigation.
  const HEAVY_Q_KEY = '__thymerExtHeavyWorkQueue';
  const HEAVY_BUSY_KEY = '__thymerExtHeavyWorkBusy';

  function ensureMobileLoadGraceStarted(extraMs) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (extraMs > 0 ? extraMs : MOBILE_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function inMobileLoadGrace() {
    if (!preferDeferredHeavyWork()) return false;
    try {
      return Date.now() < (g[MOBILE_GRACE_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  function bumpMobileLoadGrace(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_RESUME_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function installMobileResumeGraceListener() {
    if (g.__thymerExtMobileGraceListenerInstalled) return;
    g.__thymerExtMobileGraceListenerInstalled = true;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener(
      'visibilitychange',
      () => {
        try {
          if (document.visibilityState === 'hidden') {
            g[MOBILE_HIDDEN_AT_KEY] = Date.now();
          } else if (document.visibilityState === 'visible') {
            const hiddenAt = g[MOBILE_HIDDEN_AT_KEY] || 0;
            const away = hiddenAt ? Date.now() - hiddenAt : 0;
            if (away >= MOBILE_RESUME_AWAY_MS) bumpMobileLoadGrace(MOBILE_RESUME_GRACE_MS);
          }
        } catch (_) {}
      },
      { passive: true }
    );
  }

  function pauseHeavyWorkQueue(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
    try {
      if (!g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] < until) {
        g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function isHeavyWorkQueuePaused() {
    try {
      return Date.now() < (g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  /**
   * True during the brief startup window — use only to skip *background* sync scans,
   * not user-initiated panel.navigated mounts (those should still schedule with debounce).
   */
  function shouldDeferPanelFooterWork() {
    return inMobileLoadGrace();
  }

  /** Run `fn` now, or poll until mobile load grace ends (for one-shot startup scans that must not be dropped). */
  function scheduleAfterMobileLoadGrace(run, opts) {
    if (typeof run !== 'function') return;
    if (!preferDeferredHeavyWork() || !inMobileLoadGrace()) {
      try {
        run();
      } catch (_) {}
      return;
    }
    const pollMs = Math.max(120, Number(opts?.pollMs) || 350);
    const maxWaitMs = Math.max(pollMs, Number(opts?.maxWaitMs) || 90000);
    const started = Date.now();
    const tick = () => {
      if (!inMobileLoadGrace() || Date.now() - started >= maxWaitMs) {
        try {
          run();
        } catch (_) {}
        return;
      }
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  }

  function installMobileInteractionGraceListener() {
    if (g.__thymerExtMobileInteractGraceInstalled) return;
    g.__thymerExtMobileInteractGraceInstalled = true;
    if (!preferDeferredHeavyWork()) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

    const onInteract = () => {
      try {
        const now = Date.now();
        const prev = g[MOBILE_INTERACT_THROTTLE_AT_KEY] || 0;
        if (now - prev < MOBILE_INTERACTION_THROTTLE_MS) return;
        g[MOBILE_INTERACT_THROTTLE_AT_KEY] = now;
        pauseHeavyWorkQueue(MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
      } catch (_) {}
    };

    for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
      try {
        document.addEventListener(ev, onInteract, { passive: true, capture: true });
      } catch (_) {}
    }
  }

  async function yieldToHostOneTick() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        setTimeout(r, 0);
      }
    });
  }

  async function runNextHeavyWork() {
    if (g[HEAVY_BUSY_KEY]) return;
    const q = g[HEAVY_Q_KEY];
    if (!Array.isArray(q) || q.length === 0) return;
    g[HEAVY_BUSY_KEY] = true;
    try {
      while (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        if (inMobileLoadGrace() || isHeavyWorkQueuePaused()) break;
        const job = g[HEAVY_Q_KEY].shift();
        if (!job || typeof job.run !== 'function') continue;
        try {
          await yieldToHostOneTick();
        } catch (_) {}
        // Prefer running during idle; fallback is still serialized.
        try {
          if (typeof requestIdleCallback === 'function') {
            await new Promise((resolve) => requestIdleCallback(resolve, { timeout: 1200 }));
          }
        } catch (_) {}
        try {
          await job.run();
        } catch (_) {}
        // Yield after each heavy job so navigation events can be processed.
        try {
          await yieldToHostOneTick();
        } catch (_) {}
      }
    } finally {
      g[HEAVY_BUSY_KEY] = false;
      // If we stopped due to grace, try again later.
      if (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        setTimeout(() => runNextHeavyWork(), inMobileLoadGrace() ? 450 : 200);
      }
    }
  }

  function enqueueHeavyWork(run, opts) {
    if (typeof run !== 'function') return;
    if (!g[HEAVY_Q_KEY]) g[HEAVY_Q_KEY] = [];
    const delayMs = Math.max(0, Number(opts?.delayMs) || 0);
    const push = () => {
      try {
        g[HEAVY_Q_KEY].push({ run });
      } catch (_) {}
      setTimeout(() => runNextHeavyWork(), 0);
    };
    if (delayMs > 0) setTimeout(push, delayMs);
    else push();
  }

  async function yieldToHostBeforePathB() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        r();
      }
    });
    await new Promise((resolve) => {
      try {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(), {
            timeout: preferDeferredHeavyWork() ? 8000 : 1500,
          });
        } else {
          setTimeout(resolve, preferDeferredHeavyWork() ? 48 : 16);
        }
      } catch (_) {
        setTimeout(resolve, 32);
      }
    });
  }

  async function getAllCollectionsDeduped(data) {
    if (!data || typeof data.getAllCollections !== 'function') return [];
    const inflight = data[DATA_GET_ALL_P];
    if (inflight && typeof inflight.then === 'function') {
      try {
        return await inflight;
      } catch (_) {
        // fall through to fresh fetch
      }
    }
    const p = Promise.resolve()
      .then(() => data.getAllCollections())
      .then((all) => (Array.isArray(all) ? all : []))
      .finally(() => {
        try {
          if (data[DATA_GET_ALL_P] === p) delete data[DATA_GET_ALL_P];
        } catch (_) {}
      });
    data[DATA_GET_ALL_P] = p;
    return p;
  }

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    let slugRegisterSavedOk = false;
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
        else slugRegisterSavedOk = true;
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    if (slugRegisterSavedOk) await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/public repo/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      if (changed) await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  /** Parse ISO-ish timestamps for vault row scoring (duplicates: pick freshest, not first in list). */
  function parseVaultIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function vaultRowFreshnessScore(r) {
    let score = 0;
    let raw = '';
    try {
      raw = rowField(r, 'settings_json');
    } catch (_) {}
    if (raw && String(raw).trim()) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.updatedAt === 'string') {
          const ms = parseVaultIsoMs(j.updatedAt);
          if (ms > score) score = ms;
        }
      } catch (_) {}
    }
    try {
      const ua = rowField(r, 'updated_at');
      if (ua) {
        const ms = parseVaultIsoMs(ua);
        if (ms > score) score = ms;
      }
    } catch (_) {}
    return score;
  }

  function settingsJsonPayloadLen(r) {
    try {
      return String(rowField(r, 'settings_json') || '').length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Prefer the **newest** vault row when duplicates exist (same `plugin_id`, multiple vault-shaped rows).
   * Previously the first list match could be stale while a newer row held the real payload.
   */
  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    let best = null;
    let bestScore = -1;
    for (const x of records) {
      if (!isVaultRow(x, pluginId)) continue;
      const sc = vaultRowFreshnessScore(x);
      if (sc > bestScore) {
        bestScore = sc;
        best = x;
      } else if (sc === bestScore && best) {
        const lenX = settingsJsonPayloadLen(x);
        const lenB = settingsJsonPayloadLen(best);
        if (lenX > lenB) best = x;
      }
    }
    return best;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  /** Unscoped keys (legacy); runtime uses {@link scopedPbLsKey} per workspace. */
  const LS_CREATE_LEASE_BASE = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_BASE = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_BASE = 'thymerext_plugin_backend_recent_create_attempt_v1';

  function workspaceSlugFromData(data) {
    try {
      const u = data && typeof data.getActiveUsers === 'function' ? data.getActiveUsers() : null;
      const g = u && u[0] && u[0].workspaceGuid;
      const s = g != null ? String(g).trim() : '';
      if (s) return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120);
    } catch (_) {}
    return '_unknown_ws';
  }

  function scopedPbLsKey(base, data) {
    return `${base}__${workspaceSlugFromData(data)}`;
  }

  /** Count collections whose sidebar/title name is exactly Plugin Backend (or legacy). */
  async function countExactPluginBackendNamedCollections(data) {
    let all;
    try {
      all = await getAllCollectionsDeduped(data);
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const c of all) {
      try {
        const nm = collectionDisplayName(c);
        if (nm === COL_NAME || nm === COL_NAME_LEGACY) n += 1;
      } catch (_) {}
    }
    return n;
  }

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * Lease keys are **per workspace** so switching workspaces does not inherit another vault’s lease / cooldown.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs, data) {
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) {
      if (locksOk) return noop;
      if (DEBUG_COLLECTIONS) {
        dlogPathB('lease_denied_no_localstorage_no_locks', { ws: workspaceSlugFromData(data) });
      }
      return { denied: true, release() {} };
    }
    const leaseKey = scopedPbLsKey(LS_CREATE_LEASE_BASE, data);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(leaseKey, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(leaseKey) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention, leaseKey });
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention, leaseKey });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(leaseKey);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  function pickCollFromAll(all) {
    try {
      const pick = (allIn) => {
        const list = Array.isArray(allIn) ? allIn : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  function hasPluginBackendInAll(all) {
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  async function findColl(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return pickCollFromAll(all);
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return hasPluginBackendInAll(all);
    } catch (_) {
      return false;
    }
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';
  /** Per-workspace: Plugin Backend already ensured — skip repeat bodies (avoids getAllCollections / lock storms). */
  const WS_ENSURE_OK_MAP = '__thymerExtPbWorkspaceEnsureOkMap_v1';

  function markWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      if (!h[WS_ENSURE_OK_MAP] || typeof h[WS_ENSURE_OK_MAP] !== 'object') h[WS_ENSURE_OK_MAP] = Object.create(null);
      h[WS_ENSURE_OK_MAP][slug] = true;
    } catch (_) {}
  }

  function isWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      const m = h[WS_ENSURE_OK_MAP];
      return !!(m && m[slug]);
    } catch (_) {
      return false;
    }
  }

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (data && isWorkspacePluginBackendEnsureDone(data)) return;
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await getAllCollectionsDeduped(data);
          const list = Array.isArray(a) ? a : [];
          const collNames = list.map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
          const dupExact = list.filter((c) => {
            try {
              const nm = collectionDisplayName(c);
              return nm === COL_NAME || nm === COL_NAME_LEGACY;
            } catch (__) {
              return false;
            }
          });
          if (dupExact.length > 1) {
            dlogPathB('duplicate_plugin_backend_named_collections', {
              count: dupExact.length,
              guids: dupExact.map((c) => {
                try {
                  return c.getGuid?.() || null;
                } catch (__) {
                  return null;
                }
              }),
              doc: 'docs/PLUGIN_BACKEND_DUPLICATE_HYGIENE.md',
            });
          }
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      const markPbOk = () => markWorkspacePluginBackendEnsureDone(data);
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let allAttempt;
        try {
          allAttempt = await getAllCollectionsDeduped(data);
        } catch (_) {
          allAttempt = null;
        }
        if (allAttempt != null) {
          existing = pickCollFromAll(allAttempt);
          if (existing) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allAttempt)) {
            markPbOk();
            return;
          }
        } else {
          existing = await findColl(data);
          if (existing) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      let allPost;
      try {
        allPost = await getAllCollectionsDeduped(data);
      } catch (_) {
        allPost = null;
      }
      if (allPost != null) {
        existing = pickCollFromAll(allPost);
        if (existing) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allPost)) {
          markPbOk();
          return;
        }
      } else {
        existing = await findColl(data);
        if (existing) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      let allAfterWait;
      try {
        allAfterWait = await getAllCollectionsDeduped(data);
      } catch (_) {
        allAfterWait = null;
      }
      if (allAfterWait != null) {
        if (pickCollFromAll(allAfterWait)) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allAfterWait)) {
          markPbOk();
          return;
        }
      } else {
        if (await findColl(data)) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await getAllCollectionsDeduped(data);
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await getAllCollectionsDeduped(data);
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          let allPre;
          try {
            allPre = await getAllCollectionsDeduped(data);
          } catch (_) {
            allPre = null;
          }
          if (allPre != null) {
            if (pickCollFromAll(allPre)) {
              markPbOk();
              return;
            }
            if (hasPluginBackendInAll(allPre)) {
              markPbOk();
              return;
            }
          } else {
            if (await findColl(data)) {
              markPbOk();
              return;
            }
            if (await hasPluginBackendOnWorkspace(data)) {
              markPbOk();
              return;
            }
          }
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000, data);
      if (lease.denied) return;
      try {
        let allLease;
        try {
          allLease = await getAllCollectionsDeduped(data);
        } catch (_) {
          allLease = null;
        }
        if (allLease != null) {
          if (pickCollFromAll(allLease)) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allLease)) {
            markPbOk();
            return;
          }
        } else {
          if (await findColl(data)) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs(data);
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            let allCont;
            try {
              allCont = await getAllCollectionsDeduped(data);
            } catch (_) {
              allCont = null;
            }
            if (allCont != null) {
              if (pickCollFromAll(allCont)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allCont)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs(data);
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            let allSettle;
            try {
              allSettle = await getAllCollectionsDeduped(data);
            } catch (_) {
              allSettle = null;
            }
            if (allSettle != null) {
              if (pickCollFromAll(allSettle)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allSettle)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
        }
        noteRecentPluginBackendCreateAttempt(data);
        const exactN = await countExactPluginBackendNamedCollections(data);
        if (exactN >= 1) {
          if (DEBUG_COLLECTIONS) {
            dlogPathB('abort_create_exact_backend_name_exists', { exactN, ws: workspaceSlugFromData(data) });
          }
          markPbOk();
          return;
        }
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate(data);
        markPbOk();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    if (isWorkspacePluginBackendEnsureDone(data)) {
      return Promise.resolve();
    }
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = findVaultRecord(records, pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  const LOCAL_MIRROR_META_PREFIX = 'thymerext_ps_local_meta_v1:';

  function localMirrorMetaKey(pluginId) {
    return LOCAL_MIRROR_META_PREFIX + encodeURIComponent(String(pluginId || 'unknown'));
  }

  function parseIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function readLocalMirrorMeta(pluginId) {
    try {
      const raw = localStorage.getItem(localMirrorMetaKey(pluginId));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
    return {};
  }

  function writeLocalMirrorMeta(pluginId, meta) {
    try {
      localStorage.setItem(localMirrorMetaKey(pluginId), JSON.stringify(meta || {}));
    } catch (_) {}
  }

  function markLocalMirrorKeys(pluginId, keys, updatedAt) {
    if (!pluginId || !Array.isArray(keys)) return;
    const meta = readLocalMirrorMeta(pluginId);
    const ts = updatedAt || new Date().toISOString();
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      let exists = false;
      try {
        exists = localStorage.getItem(k) !== null;
      } catch (_) {}
      if (!exists) continue;
      meta[k] = { updatedAt: ts };
      changed = true;
    }
    if (changed) writeLocalMirrorMeta(pluginId, meta);
  }

  function collectLocalMirrorPayload(keys) {
    const payload = {};
    if (!Array.isArray(keys)) return payload;
    for (const k of keys) {
      if (!k) continue;
      try {
        const v = localStorage.getItem(k);
        if (v !== null) payload[k] = v;
      } catch (_) {}
    }
    return payload;
  }

  function localPayloadMatchesRemote(keys, remote) {
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return false;
    if (!Array.isArray(keys)) return true;
    for (const k of keys) {
      if (!k) continue;
      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}
      const remoteValue = remote.payload[k];
      if (localValue === null && typeof remoteValue !== 'string') continue;
      if (localValue !== remoteValue) return false;
    }
    return true;
  }

  function applyRemoteMirrorPayload(pluginId, keys, remote) {
    const result = { needsFlush: false };
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return result;
    const meta = readLocalMirrorMeta(pluginId);
    const remoteUpdatedAt = String(remote.updatedAt || '');
    const remoteMs = parseIsoMs(remoteUpdatedAt);
    let metaChanged = false;
    for (const k of keys) {
      if (!k) continue;
      const remoteValue = remote.payload[k];
      if (typeof remoteValue !== 'string') continue;

      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}

      if (localValue === remoteValue) {
        if (remoteUpdatedAt && (!meta[k] || !meta[k].updatedAt)) {
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        }
        continue;
      }

      if (localValue === null) {
        try {
          localStorage.setItem(k, remoteValue);
          if (remoteUpdatedAt) {
            meta[k] = { updatedAt: remoteUpdatedAt };
            metaChanged = true;
          }
        } catch (_) {}
        continue;
      }

      const localMs = parseIsoMs(meta[k]?.updatedAt);
      if (localMs && remoteMs && remoteMs > localMs + 1000) {
        try {
          localStorage.setItem(k, remoteValue);
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        } catch (_) {}
        continue;
      }

      // When freshness is ambiguous, preserve the browser's current settings and let flushNow repair the vault row.
      result.needsFlush = true;
      if (!localMs) {
        meta[k] = { updatedAt: new Date().toISOString() };
        metaChanged = true;
      }
      console.warn('[ThymerPluginSettings] Kept local settings instead of overwriting with older/ambiguous synced payload', {
        pluginId,
        key: k,
        localUpdatedAt: meta[k]?.updatedAt || null,
        remoteUpdatedAt: remoteUpdatedAt || null,
      });
    }
    if (metaChanged) writeLocalMirrorMeta(pluginId, meta);
    return result;
  }

  function shouldFlushMirrorOnInit(keys, remote, applyResult) {
    if (applyResult?.needsFlush) return true;
    if (remote && remote.payload && typeof remote.payload === 'object') {
      return !localPayloadMatchesRemote(keys, remote);
    }
    return Object.keys(collectLocalMirrorPayload(keys)).length > 0;
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,
    preferDeferredHeavyWork,
    yieldToHostBeforePathB,
    ensureMobileLoadGraceStarted,
    inMobileLoadGrace,
    bumpMobileLoadGrace,
    installMobileResumeGraceListener,

    async init(opts) {
      ensureMobileLoadGraceStarted();
      installMobileResumeGraceListener();
      installMobileInteractionGraceListener();
      await yieldToHostBeforePathB();
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      let initFlushNeeded = false;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        const applyResult = applyRemoteMirrorPayload(pluginId, keys, remote);
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, applyResult);
      } else if (plugin._pluginSettingsSyncMode === 'synced') {
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, null);
      }

      if (plugin._pluginSettingsSyncMode === 'synced' && initFlushNeeded) {
        try {
          markLocalMirrorKeys(pluginId, keys);
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      markLocalMirrorKeys(plugin._pluginSettingsPluginId, keys);
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') {
        markLocalMirrorKeys(pluginId, keyList);
        await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      }
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };

  g.thymerExtEnsureMobileLoadGrace = ensureMobileLoadGraceStarted;
  g.thymerExtInMobileLoadGrace = inMobileLoadGrace;
  g.thymerExtPreferDeferredHeavyWork = preferDeferredHeavyWork;
  g.thymerExtShouldDeferPanelFooterWork = shouldDeferPanelFooterWork;
  g.thymerExtBumpMobileLoadGrace = bumpMobileLoadGrace;
  g.thymerExtPauseHeavyWorkQueue = pauseHeavyWorkQueue;
  g.thymerExtInstallMobileResumeGrace = installMobileResumeGraceListener;
  g.thymerExtInstallMobileInteractionGrace = installMobileInteractionGraceListener;
  g.thymerExtEnqueueHeavyWork = enqueueHeavyWork;
  g.thymerExtScheduleAfterMobileLoadGrace = scheduleAfterMobileLoadGrace;
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings

const EXCAL_PLUGIN_NAME = 'Excalidraw';
const EXCAL_PLUGIN_SLUG = 'excalidraw';
const EXCAL_PLUGIN_ID = 'excalidraw';
const EXCAL_MODE_KEY = 'thymerext_ps_mode_excalidraw';
const EXCAL_DRAW_PREFIX = 'excal_draw_v1_';
const EXCAL_PANEL_TYPE = 'excalidraw-editor';
const EXCAL_VERSION = '0.6.0';
const EXCAL_ICON = 'ti-palette';
const EXCAL_FRAME_PAD_X = 12;
const EXCAL_FRAME_PAD_TOP = 28;
const EXCAL_FRAME_PAD_BOTTOM = 12;
const EXCAL_FRAME_RADIUS = 14;
const EXCAL_INNER_RADIUS = 10;
const EXCAL_UMD_VERSION = '0.17.6';
const EXCAL_DRAWINGS_COLL_NAME = 'Excalidrawings';
const EXCAL_DRAWINGS_COLL_GUID_KEY = 'excal_drawings_coll_guid_v1';
const EXCAL_DRAWINGS_COLL_MARKER = 'excalidraw_drawings_coll_v1';
const EXCAL_DRAWINGS_CREATE_LEASE_LS = 'thymerext_excal_drawings_create_lease_v1';
const EXCAL_DRAWINGS_CREATE_RECENT_LS = 'thymerext_excal_drawings_create_recent_v1';
const EXCAL_DRAWINGS_CREATE_ATTEMPT_LS = 'thymerext_excal_drawings_create_attempt_v1';
const EXCAL_DRAWINGS_ENSURE_GLOBAL_P = '__thymerExcalDrawingsEnsureP';
const EXCAL_DRAWINGS_CREATE_Q = '__thymerExcalDrawingsCreateQ_v1';
const EXCAL_FIELD_SCENE = 'scene';
const EXCAL_FIELD_SOURCE_NOTE = 'source_note';
/** Legacy lookup only — no longer added to new collections. */
const EXCAL_FIELD_SOURCE_GUID = 'source_record_guid';
const EXCAL_SOURCE_FIELD_ID = 'excalidrawing';
const EXCAL_SOURCE_FIELD_LABEL = 'Excalidrawing';
const EXCAL_WS_THROTTLE_MS = 80;
const EXCAL_WS_MSG_TYPE = 'excal-delta';
const EXCAL_ECHO_GUARD_MS = 500;

// Returns true if the element has no rendered extent yet — i.e. the user
// is mid-drag (pointer-down without pointer-up) and any snapshot we
// persist/broadcast would be invisible. Excalidraw finalizes the
// dimensions on pointer-up, so dropping these in-flight elements is safe:
// the next onChange will carry the finalized version.
function isDegenerateElement(el) {
  if (!el || el.isDeleted) return true;
  // Freedraw: a single point is the initial pointer-down state.
  if (el.type === 'freedraw') {
    if (!Array.isArray(el.points) || el.points.length < 2) return true;
    const w = Math.abs(el.width || 0);
    const h = Math.abs(el.height || 0);
    if (w < 1 && h < 1) return true;
    return false;
  }
  // Shapes (rectangle / ellipse / diamond / line / arrow) report width/height
  // of 0 only between pointer-down and pointer-up. Threshold of 1 px is
  // well below any human-drawn shape.
  if (el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond'
      || el.type === 'line' || el.type === 'arrow') {
    const w = Math.abs(el.width || 0);
    const h = Math.abs(el.height || 0);
    if (w < 1 && h < 1) return true;
  }
  return false;
}

function excalDrawingsCollectionShape() {
  return {
    ver: 1,
    name: EXCAL_DRAWINGS_COLL_NAME,
    icon: EXCAL_ICON,
    color: null,
    home: false,
    item_name: 'Drawing',
    description: 'Excalidraw sketches linked to notes.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    views: [],
    fields: [
      {
        icon: 'ti-link',
        id: EXCAL_FIELD_SOURCE_NOTE,
        label: 'Source note',
        type: 'record',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-brush',
        id: EXCAL_FIELD_SCENE,
        label: 'Scene',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
    ],
    page_field_ids: [EXCAL_FIELD_SOURCE_NOTE],
    sidebar_record_sort_field_id: 'updated_at',
    sidebar_record_sort_dir: 'desc',
    managed: { fields: false, views: false, sidebar: false },
    custom: {
      [EXCAL_DRAWINGS_COLL_MARKER]: true,
      plugin_id: EXCAL_PLUGIN_ID,
      first_seen_at_ms: Date.now(),
    },
  };
}

// v0.5.6: shallow-clone an element for use as a delta-filter snapshot.
// Excalidraw mutates element objects in place; storing the live reference
// causes the delta filter to always see prevEl.version === el.version
// (same object) and emit an empty delta. Cloning the array-valued fields
// (points, boundElements, groupIds) and the containerId reference fully
// decouples the snapshot from the live element.
function _cloneElementSnapshot(el) {
  if (!el) return el;
  return {
    ...el,
    points: Array.isArray(el.points) ? el.points.slice() : el.points,
    boundElements: Array.isArray(el.boundElements) ? el.boundElements.slice() : el.boundElements,
    groupIds: Array.isArray(el.groupIds) ? el.groupIds.slice() : el.groupIds,
    containerId: el.containerId ?? null,
  };
}

class Plugin extends AppPlugin {
  onLoad() {
    if (typeof super.onLoad === 'function') super.onLoad();

    this._instanceTag = `excal-i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this._version = EXCAL_VERSION;
    this._eventIds = [];
    this._panelSession = null;
    this._drawingRecordCache = new Map();
    this._drawingsCollEnsurePromise = null;
    this._cssInjected = false;
    this._navChromeTimer = null;
    this._navChromeRetryTimer = null;
    this._navInterceptBusy = false;
    this._excalStatusItem = null;
    this._excalSidebarItem = null;
    this._myUserGuid = null;
    this._realtimeUnsubs = [];
    this._pagehideUnsub = null;
    this._showDataPanelIds = new Set();

    // v0.5.9: page-hide flush. When the user closes the tab/window
    // or backgrounds the tab, force a flush of any pending scene.
    // The autosave debounce is 1500ms; without this, a user who
    // closes Thymer within 1.5s of drawing loses the change. The
    // panel.closed event only fires for panel close, not for the
    // whole page going away. pagehide + beforeunload + visibility
    // cover tab close, window close, and tab backgrounding.
    this._installPageHideFlush();

    const custom = this.getConfiguration()?.custom || {};
    this._cdnVersion = String(custom.cdnVersion || EXCAL_UMD_VERSION).trim() || EXCAL_UMD_VERSION;
    // v0.5.9: lowered the autosave debounce floor from 800ms to
    // 300ms. The save is cheap (one prop set + one localStorage
    // write), and a tighter debounce means the pagehide flush
    // rarely has to fight a 1.5s gap between the last edit and
    // a quick close.
    this._autosaveMs = Math.max(200, Number(custom.autosaveMs) || 400);

    this._injectCSS();
    this.ui.registerCustomPanelType(EXCAL_PANEL_TYPE, (panel) => this._mountDrawingPanel(panel));

    this._cmdOpen = this.ui.addCommandPaletteCommand({
      label: `${EXCAL_PLUGIN_NAME}: Open drawing for this note`,
      icon: EXCAL_ICON,
      onSelected: () => {
        setTimeout(() => { void this._openDrawingPanel(); }, 80);
      },
    });

    this._mountExcalSidebarItem();
    this._mountExcalStatusBar();

    if (this.events?.on) {
      const onPanelChange = (ev) => {
        this._schedulePanelChrome(ev?.panel);
      };
      this._eventIds.push(this.events.on('panel.navigated', onPanelChange));
      this._eventIds.push(this.events.on('panel.focused', onPanelChange));
      this._eventIds.push(this.events.on('record.updated', () => {
        this._schedulePanelChrome(this.ui.getActivePanel?.());
      }));
      this._eventIds.push(this.events.on('panel.closed', (ev) => {
        const session = this._panelSession;
        const closedId = ev?.panel?.getId?.();
        if (session?.panelId && closedId && session.panelId !== closedId) return;
        try { session?._resizeObs?.disconnect?.(); } catch (_) {}
        this._teardownRealtimeListeners(session);
        void this._flushPanelSession(true);
        try { session?.reactRoot?.unmount?.(); } catch (_) {}
        if (session && (!closedId || session.panelId === closedId)) {
          this._panelSession = null;
        }
      }));
    } else {
      console.warn(`[${EXCAL_PLUGIN_NAME}] events API unavailable — property intercept and status bar sync disabled`);
    }

    void this._bootDrawingsCollection().then((coll) => {
      if (typeof globalThis !== 'undefined' && globalThis.__excalDebug) {
        globalThis.__excalDebug.bootCollectionGuid = coll ? this._getCollectionGuid(coll) : null;
      }
    });
    setTimeout(() => this._schedulePanelChrome(this.ui.getActivePanel?.()), 600);
  }

  onUnload() {
    for (const id of this._eventIds || []) {
      try { this.events.off(id); } catch (_) {}
    }
    this._eventIds = [];
    this._teardownRealtimeListeners(this._panelSession);
    for (const unsub of this._realtimeUnsubs || []) {
      try { unsub(); } catch (_) {}
    }
    this._realtimeUnsubs = [];
    void this._flushPanelSession(true);
    this._panelSession = null;
    this._drawingRecordCache?.clear?.();
    try { this._cmdOpen?.remove?.(); } catch (_) {}
    try { this._excalStatusItem?.remove?.(); } catch (_) {}
    try { this._excalSidebarItem?.remove?.(); } catch (_) {}
    this._excalStatusItem = null;
    this._excalSidebarItem = null;
    if (this._navChromeTimer) clearTimeout(this._navChromeTimer);
    if (this._navChromeRetryTimer) clearTimeout(this._navChromeRetryTimer);
  }

  _excalSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  _wsSlug() {
    try {
      const users = this.data?.getActiveUsers?.();
      if (Array.isArray(users) && users[0]?.guid) return String(users[0].guid).slice(0, 16);
    } catch (_) {}
    return 'default';
  }

  _drawingsCollGuidLsKey() {
    return `${EXCAL_DRAWINGS_COLL_GUID_KEY}_${this._wsSlug()}`;
  }

  _getCollectionGuid(coll) {
    try {
      const g = coll?.getGuid?.();
      if (g) return String(g).trim();
    } catch (_) {}
    return '';
  }

  _collectionDisplayName(coll) {
    try {
      const n = String(coll?.getName?.() || '').trim();
      if (n && n !== 'New Collection') return n;
    } catch (_) {}
    try {
      return String(coll?.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return '';
  }

  _excalSharedWin() {
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        return window.top;
      }
    } catch (_) {}
    return typeof globalThis !== 'undefined' ? globalThis : window;
  }

  _excalScopedLsKey(base) {
    return `${base}__${this._wsSlug()}`;
  }

  _collectionHasDrawingsMarker(coll) {
    try {
      const custom = coll?.getConfiguration?.()?.custom || {};
      if (custom[EXCAL_DRAWINGS_COLL_MARKER] === true) return true;
      if (custom.plugin_id === EXCAL_PLUGIN_ID && custom[EXCAL_DRAWINGS_COLL_MARKER]) return true;
    } catch (_) {}
    return false;
  }

  _getCollectionCreatedAt(coll) {
    if (!coll) return Number.MAX_SAFE_INTEGER;
    try {
      const ts = coll.getConfiguration?.()?.custom?.first_seen_at_ms;
      if (typeof ts === 'number') return ts;
    } catch (_) {}
    return Number.MAX_SAFE_INTEGER;
  }

  _collectionLooksLikeDrawings(coll) {
    if (!coll) return false;
    if (this._collectionHasDrawingsMarker(coll)) return true;
    const name = this._collectionDisplayName(coll);
    if (name === EXCAL_DRAWINGS_COLL_NAME) return true;
    if (/^excalidraw/i.test(name)) return true;
    return false;
  }

  _findDrawingsCollectionsInList(all) {
    if (!Array.isArray(all)) return [];
    const out = [];
    for (const c of all) {
      if (this._collectionLooksLikeDrawings(c)) out.push(c);
    }
    return out;
  }

  _pickCanonicalDrawingsCollection(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const marked = candidates.filter((c) => this._collectionHasDrawingsMarker(c));
    if (marked.length) {
      // Among marked candidates, prefer the OLDEST (canonical was created
      // first; dupes from hot-reload races are always later). Stored GUID
      // is intentionally NOT used here — if the stored points to a dupe
      // (perpetuating the dupe race), we want to break the chain and
      // adopt the real canonical. The stored GUID is set as a side-effect
      // of adoptDrawingsCollection, so it gets corrected on the next boot.
      const sorted = marked.slice().sort((a, b) => this._getCollectionCreatedAt(a) - this._getCollectionCreatedAt(b));
      const picked = sorted[0];
      if (marked.length > 1) {
        const guids = marked.map((c) => this._getCollectionGuid(c) || '?').join(', ');
        console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] ${marked.length} marked drawings collections — picked oldest (${this._getCollectionGuid(picked)}) from: [${guids}]`);
        try {
          if (typeof globalThis !== 'undefined' && globalThis.__excalDebug !== undefined) {
            globalThis.__excalDebug.duplicateDrawingsCollections = marked.map((c) => this._getCollectionGuid(c));
          }
        } catch (_) {}
      }
      return picked;
    }
    const exact = candidates.find((c) => this._collectionDisplayName(c) === EXCAL_DRAWINGS_COLL_NAME);
    if (exact) return exact;
    if (candidates.length > 1) {
      const guids = candidates.map((c) => this._getCollectionGuid(c) || '?').join(', ');
      console.warn(
        `[${EXCAL_PLUGIN_NAME}] ${candidates.length} "${EXCAL_DRAWINGS_COLL_NAME}" collections found (no markers) — using first; delete extras in Thymer sidebar. GUIDs: [${guids}]`,
      );
      try {
        if (typeof globalThis !== 'undefined' && globalThis.__excalDebug !== undefined) {
          globalThis.__excalDebug.duplicateDrawingsCollections = candidates.map((c) => this._getCollectionGuid(c));
        }
      } catch (_) {}
    }
    return candidates[0];
  }

  _findDrawingsCollectionInList(all) {
    return this._pickCanonicalDrawingsCollection(this._findDrawingsCollectionsInList(all));
  }

  async _listCollectionsWithRetry(maxAttempts) {
    const tries = Math.max(1, Number(maxAttempts) || 4);
    for (let i = 0; i < tries; i++) {
      try {
        const all = await this.data.getAllCollections();
        if (Array.isArray(all)) return all;
      } catch (_) {}
      if (i < tries - 1) await this._excalSleep(50 + i * 50);
    }
    return [];
  }

  async _discoverDrawingsCollection() {
    const all = await this._listCollectionsWithRetry(5);
    return this._pickCanonicalDrawingsCollection(this._findDrawingsCollectionsInList(all));
  }

  _markDrawingsCreateAttempt() {
    try {
      localStorage.setItem(this._excalScopedLsKey(EXCAL_DRAWINGS_CREATE_ATTEMPT_LS), String(Date.now()));
    } catch (_) {}
  }

  _markDrawingsCreateDone() {
    try {
      localStorage.setItem(this._excalScopedLsKey(EXCAL_DRAWINGS_CREATE_RECENT_LS), String(Date.now()));
    } catch (_) {}
  }

  _getDrawingsCreateAttemptAgeMs() {
    try {
      const raw = localStorage.getItem(this._excalScopedLsKey(EXCAL_DRAWINGS_CREATE_ATTEMPT_LS));
      if (!raw) return null;
      const t = Number(raw);
      if (!Number.isFinite(t)) return null;
      return Date.now() - t;
    } catch (_) {
      return null;
    }
  }

  async _acquireDrawingsCreateLease(maxWaitMs) {
    const ls = (() => {
      try { return window.localStorage; } catch (_) { return null; }
    })();
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    if (!ls) return locksOk ? noop : { denied: true, release() {} };

    const leaseKey = this._excalScopedLsKey(EXCAL_DRAWINGS_CREATE_LEASE_LS);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let heldPayload = '';

    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try { j = JSON.parse(raw); } catch (_) { j = null; }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          await this._excalSleep(40 + Math.floor(Math.random() * 50));
          continue;
        }
        heldPayload = JSON.stringify({ h: holder, exp: Date.now() + 45000 });
        ls.setItem(leaseKey, heldPayload);
        await this._excalSleep(0);
        if (ls.getItem(leaseKey) === heldPayload) {
          acquired = true;
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await this._excalSleep(30 + Math.floor(Math.random() * 40));
    }

    if (!acquired) return { denied: true, release() {} };
    return {
      denied: false,
      release() {
        try {
          if (heldPayload && ls.getItem(leaseKey) === heldPayload) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  _queueDrawingsCreate(factory) {
    const host = this._excalSharedWin();
    try {
      if (!host[EXCAL_DRAWINGS_CREATE_Q] || typeof host[EXCAL_DRAWINGS_CREATE_Q].then !== 'function') {
        host[EXCAL_DRAWINGS_CREATE_Q] = Promise.resolve();
      }
      return (host[EXCAL_DRAWINGS_CREATE_Q] = host[EXCAL_DRAWINGS_CREATE_Q].catch(() => {}).then(factory));
    } catch (_) {
      return factory();
    }
  }

  async _adoptDrawingsCollection(coll) {
    if (!coll) return null;
    const g = this._getCollectionGuid(coll);
    if (g) this._setStoredDrawingsCollGuid(g);
    this._drawingsCollectionRef = coll;
    await this._mergeDrawingsCollectionSchema(coll);
    return coll;
  }

  _getStoredDrawingsCollGuid() {
    try {
      return localStorage.getItem(this._drawingsCollGuidLsKey()) || '';
    } catch (_) {
      return '';
    }
  }

  _setStoredDrawingsCollGuid(guid) {
    if (!guid) return;
    try {
      localStorage.setItem(this._drawingsCollGuidLsKey(), guid);
    } catch (_) {}
  }

  async _mergeDrawingsCollectionSchema(coll) {
    if (!coll?.getConfiguration || !coll.saveConfiguration) return;
    const desired = excalDrawingsCollectionShape();
    let base = {};
    try {
      base = coll.getConfiguration() || {};
    } catch (_) {
      base = {};
    }
    const curFields = Array.isArray(base.fields) ? [...base.fields] : [];
    const curIds = new Set(curFields.map((f) => (f && f.id ? String(f.id) : '')).filter(Boolean));
    let changed = false;
    for (const f of desired.fields || []) {
      if (f && f.id && !curIds.has(String(f.id))) {
        try {
          curFields.push(JSON.parse(JSON.stringify(f)));
        } catch (_) {
          curFields.push({ ...f });
        }
        curIds.add(String(f.id));
        changed = true;
      }
    }
    const wantPages = desired.page_field_ids || [];
    const pageIds = Array.isArray(base.page_field_ids) ? [...base.page_field_ids] : [];
    for (const pid of wantPages) {
      if (pid && !pageIds.includes(pid)) {
        pageIds.push(pid);
        changed = true;
      }
    }
    const custom = { ...(base.custom || {}) };
    if (custom[EXCAL_DRAWINGS_COLL_MARKER] !== true) {
      custom[EXCAL_DRAWINGS_COLL_MARKER] = true;
      changed = true;
    }
    if (custom.plugin_id !== EXCAL_PLUGIN_ID) {
      custom.plugin_id = EXCAL_PLUGIN_ID;
      changed = true;
    }
    if (typeof custom.first_seen_at_ms !== 'number') {
      // Backfill: derive a stable age signal from the collection's records.
      // The earliest record's created timestamp is a reliable proxy for
      // "this collection was created first" (dupes are always newer than
      // the canonical they were cloned from). When multiple collections
      // exist and the plugin has to pick the canonical, this signal
      // disambiguates them — Date.now() on both would be a coin flip.
      let derivedTs = Date.now();
      try {
        const records = await coll.getAllRecords?.();
        if (Array.isArray(records) && records.length) {
          let earliest = Infinity;
          for (const r of records) {
            const c = Number(r?.created);
            if (Number.isFinite(c) && c > 0 && c < earliest) earliest = c;
          }
          if (Number.isFinite(earliest) && earliest < derivedTs) {
            derivedTs = Math.floor(earliest * 1000);
          }
        }
      } catch (_) { /* keep Date.now() fallback */ }
      custom.first_seen_at_ms = derivedTs;
      changed = true;
    }
    const wantIcon = desired.icon || EXCAL_ICON;
    if (base.icon !== wantIcon) changed = true;
    if (!changed) return;
    const merged = {
      ...base,
      name: EXCAL_DRAWINGS_COLL_NAME,
      icon: wantIcon,
      fields: curFields,
      page_field_ids: pageIds,
      managed: { fields: false, views: false, sidebar: false },
      custom,
    };
    try {
      await coll.saveConfiguration(merged);
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] drawings schema merge`, e);
    }
  }

  async _invokeCreateCollectionOnce() {
    const data = this.data;
    if (!data || typeof data.createCollection !== 'function') return null;
    try {
      const existing = await this._discoverDrawingsCollection();
      if (existing) return existing;
    } catch (_) {}
    try {
      const raw = data.createCollection();
      const coll = raw != null && typeof raw.then === 'function' ? await raw : raw;
      if (coll && typeof coll.getConfiguration === 'function' && typeof coll.saveConfiguration === 'function') {
        const winner = await this._discoverDrawingsCollection();
        if (winner && winner !== coll && this._collectionLooksLikeDrawings(winner)) {
          console.error(`[${EXCAL_PLUGIN_NAME}] ORPHAN CREATED: ${this._getCollectionGuid(coll) || '?'} is an orphan (canonical is ${this._getCollectionGuid(winner) || '?'}). The plugin cannot delete collections — trash the orphan in the Thymer sidebar.`);
          if (typeof globalThis !== 'undefined' && globalThis.__excalDebug !== undefined) {
            globalThis.__excalDebug.lastOrphanDrawingsCollection = this._getCollectionGuid(coll);
          }
          return winner;
        }
        return coll;
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] createCollection`, e);
    }
    return null;
  }

  async _ensureDrawingsCollectionCore() {
    const stored = this._getStoredDrawingsCollGuid();
    console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG ensure start: storedGuid=${stored || '(empty)'} data.getCollection=${typeof this.data.getCollection} data.getAllCollections=${typeof this.data.getAllCollections}`);
    if (stored) {
      // data.getCollection does NOT exist on the SDK — use getAllCollections
      // and filter by GUID. Retry to handle workspace blindness (browser
      // reload after preview_plugin can leave the workspace blind for 10s+;
      // 2.5s was insufficient and produced dupes on every reload).
      let c = null;
      for (let i = 0; i < 30; i++) {
        try {
          const all = await this.data.getAllCollections();
          c = (Array.isArray(all) ? all : []).find((x) => this._getCollectionGuid(x) === stored) || null;
        } catch (e) { c = null; }
        if (c) {
          console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG getAllCollections→stored=${stored} attempt ${i + 1}/30 → FOUND`);
          break;
        }
        if (i === 0 || i === 4 || i === 9 || i === 19 || i === 29) {
          console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG getAllCollections→stored=${stored} attempt ${i + 1}/30 → null`);
        }
        if (i < 29) await this._excalSleep(150 + i * 100);
      }
      if (c) return await this._adoptDrawingsCollection(c);
      console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG getAllCollections→stored=${stored} exhausted (30 attempts, ~15s) — stale/invalid, clearing cache`);
      try {
        localStorage.removeItem(this._drawingsCollGuidLsKey());
      } catch (_) {}
      // Stored GUID is unreachable — fall through to discover.
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this._discoverDrawingsCollection();
      if (existing) {
        console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG pre-lease discover attempt ${attempt + 1}/8 → ${this._getCollectionGuid(existing)} (FOUND)`);
        return await this._adoptDrawingsCollection(existing);
      }
      if (attempt === 0 || attempt === 3 || attempt === 7) {
        console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG pre-lease discover attempt ${attempt + 1}/8 → null`);
      }
      if (attempt < 7) await this._excalSleep(200 + attempt * 100);
    }

    const attemptAge = this._getDrawingsCreateAttemptAgeMs();
    if (attemptAge != null && attemptAge >= 0 && attemptAge < 120000) {
      for (let i = 0; i < 10; i++) {
        await this._excalSleep(130 + i * 70);
        const existing = await this._discoverDrawingsCollection();
        if (existing) return await this._adoptDrawingsCollection(existing);
      }
      return await this._discoverDrawingsCollection().then((c) => (c ? this._adoptDrawingsCollection(c) : null));
    }

    const lease = await this._acquireDrawingsCreateLease(14000);
    if (lease.denied) {
      await this._excalSleep(400);
      const existing = await this._discoverDrawingsCollection();
      return existing ? await this._adoptDrawingsCollection(existing) : null;
    }

    try {
      this._markDrawingsCreateAttempt();

      // Post-lease multi-attempt discover. After the lease is acquired,
      // another tab/instance may have just created the canonical and the
      // workspace getAllCollections() can briefly return stale data. Retry
      // with backoff to give it time to settle before we create a dupe.
      let existing = null;
      for (let i = 0; i < 6; i++) {
        existing = await this._discoverDrawingsCollection();
        console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG post-lease discover attempt ${i + 1}/6 → ${existing ? this._getCollectionGuid(existing) : 'null'}`);
        if (existing) break;
        if (i < 5) await this._excalSleep(120 + i * 80);
      }
      if (existing) return await this._adoptDrawingsCollection(existing);
      console.log(`[${EXCAL_PLUGIN_NAME}] [${this._instanceTag}] DIAG post-lease discover exhausted — proceeding to create`);

      if (typeof this.data.createCollection !== 'function') return null;

      let coll = await this._queueDrawingsCreate(() => this._invokeCreateCollectionOnce());
      if (!coll) {
        await this._excalSleep(400);
        coll = await this._queueDrawingsCreate(() => this._invokeCreateCollectionOnce());
      }
      if (!coll) {
        existing = await this._discoverDrawingsCollection();
        return existing ? await this._adoptDrawingsCollection(existing) : null;
      }

      const shape = excalDrawingsCollectionShape();
      let base = {};
      try {
        base = coll.getConfiguration() || {};
      } catch (_) {
        base = {};
      }
      if (base && typeof base.ver === 'number') shape.ver = base.ver;
      const payload = { ...shape, managed: { fields: false, views: false, sidebar: false } };
      let ok = await coll.saveConfiguration(payload);
      if (ok === false) {
        await this._excalSleep(180);
        ok = await coll.saveConfiguration(payload);
      }
      if (ok === false) {
        console.error(`[${EXCAL_PLUGIN_NAME}] could not configure ${EXCAL_DRAWINGS_COLL_NAME} collection`);
        existing = await this._discoverDrawingsCollection();
        return existing ? await this._adoptDrawingsCollection(existing) : null;
      }

      this._markDrawingsCreateDone();
      await this._excalSleep(80);
      existing = await this._discoverDrawingsCollection();
      if (existing) coll = existing;
      return await this._adoptDrawingsCollection(coll);
    } finally {
      lease.release();
    }
  }

  async _ensureDrawingsCollection() {
    if (!this.data || typeof this.data.getAllCollections !== 'function') return null;
    if (this._drawingsCollectionRef) return this._drawingsCollectionRef;
    const host = this._excalSharedWin();
    const gKey = `${EXCAL_DRAWINGS_ENSURE_GLOBAL_P}_${this._wsSlug()}`;
    if (host[gKey] && typeof host[gKey].then === 'function') return host[gKey];
    const p = (async () => {
      try {
        return await this._ensureDrawingsCollectionCore();
      } finally {
        try {
          if (host[gKey] === p) delete host[gKey];
        } catch (_) {
          host[gKey] = null;
        }
      }
    })();
    host[gKey] = p;
    return p;
  }

  async _bootDrawingsCollection() {
    try {
      const coll = await this._ensureDrawingsCollection();
      if (!coll) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] ${EXCAL_DRAWINGS_COLL_NAME} collection not available yet`);
      }
      try {
        const all = await this._listCollectionsWithRetry(5);
        const dupes = this._findDrawingsCollectionsInList(all);
        if (dupes.length > 1) {
          const guids = dupes.map((c) => this._getCollectionGuid(c) || '?').join(', ');
          console.warn(`[${EXCAL_PLUGIN_NAME}] ${dupes.length} "${EXCAL_DRAWINGS_COLL_NAME}" collections found at boot — delete extras in Thymer sidebar. GUIDs: [${guids}]`);
          if (typeof globalThis !== 'undefined' && globalThis.__excalDebug !== undefined) {
            globalThis.__excalDebug.duplicateDrawingsCollections = dupes.map((c) => this._getCollectionGuid(c));
          }
        }
      } catch (_) {}
    } catch (e) {
      console.error(`[${EXCAL_PLUGIN_NAME}] boot drawings collection`, e);
    }
  }

  _drawingTitleForNote(noteTitle) {
    const base = String(noteTitle || 'Untitled').trim() || 'Untitled';
    const suffix = ' · Excalidrawing';
    if (base.endsWith(suffix)) return base;
    return `${base}${suffix}`;
  }

  _linkRecordProperty(prop, targetGuid, fieldId, hostRecord) {
    const guid = String(targetGuid || '').trim();
    if (!prop || !guid) return false;
    if (hostRecord && typeof hostRecord.reference === 'function') {
      try {
        const existing = String(hostRecord.reference(fieldId) || '').trim();
        if (existing === guid) return true;
      } catch (_) {}
    }
    const live = this.data?.getRecord?.(guid);
    const attempts = [];
    if (live && typeof prop.linkRecord === 'function') attempts.push(() => prop.linkRecord(live));
    if (live && typeof prop.link === 'function') attempts.push(() => prop.link(live));
    if (live && typeof prop.setRecord === 'function') attempts.push(() => prop.setRecord(live));
    if (typeof prop.set === 'function') attempts.push(() => prop.set(guid));
    for (const fn of attempts) {
      try {
        fn();
      } catch (_) {
        continue;
      }
      if (hostRecord && typeof hostRecord.reference === 'function') {
        try {
          const got = hostRecord.reference(fieldId);
          if (got && String(got).trim() === guid) return true;
        } catch (_) {}
      }
      return true;
    }
    return false;
  }

  async _ensureExcalidrawingFieldOnCollection(sourceColl, drawingsCollGuid) {
    if (!sourceColl?.getConfiguration || !sourceColl.saveConfiguration || !drawingsCollGuid) return false;
    let base = {};
    try {
      base = sourceColl.getConfiguration() || {};
    } catch (_) {
      return false;
    }
    const fields = Array.isArray(base.fields) ? [...base.fields] : [];
    const hasField = fields.some(
      (f) => f && (String(f.id) === EXCAL_SOURCE_FIELD_ID || String(f.label || '').trim() === EXCAL_SOURCE_FIELD_LABEL),
    );
    if (hasField) return true;

    fields.push({
      icon: EXCAL_ICON,
      id: EXCAL_SOURCE_FIELD_ID,
      label: EXCAL_SOURCE_FIELD_LABEL,
      type: 'record',
      read_only: false,
      active: true,
      many: false,
      filter_colguid: drawingsCollGuid,
    });
    const pageIds = Array.isArray(base.page_field_ids) ? [...base.page_field_ids] : [];
    if (!pageIds.includes(EXCAL_SOURCE_FIELD_ID)) pageIds.push(EXCAL_SOURCE_FIELD_ID);

    const merged = {
      ...base,
      fields,
      page_field_ids: pageIds,
      managed: {
        fields: false,
        views: false,
        sidebar: false,
        ...(base.managed && typeof base.managed === 'object' ? base.managed : {}),
      },
    };
    try {
      const ok = await sourceColl.saveConfiguration(merged);
      if (ok === false) {
        this.ui.addToaster?.({
          title: EXCAL_PLUGIN_NAME,
          message: 'Could not add Excalidrawing property to this collection (schema locked?).',
          dismissible: true,
          autoDestroyTime: 6000,
        });
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] merge Excalidrawing field`, e);
      return false;
    }
  }

  async _waitForRecord(guid, coll) {
    if (!guid || !coll?.getAllRecords) return null;
    for (let i = 0; i < 30; i++) {
      await this._excalSleep(i < 8 ? 100 : 200);
      try {
        const all = await coll.getAllRecords();
        const hit = (all || []).find((x) => x.guid === guid);
        if (hit) return hit;
      } catch (_) {}
    }
    return null;
  }

  _readRecordTextField(record, fieldId) {
    if (!record || !fieldId) return '';
    try {
      const t = record.text?.(fieldId);
      if (t != null && String(t).trim()) return String(t);
    } catch (_) {}
    try {
      const p = record.prop?.(fieldId);
      const v = p?.get?.();
      if (v != null && String(v).trim()) return String(v);
    } catch (_) {}
    return '';
  }

  _parseSceneDoc(raw) {
    if (!raw || !String(raw).trim()) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.sceneJson || parsed.scene || parsed.shareHash) return parsed;
      if (parsed.elements) return { v: 1, updatedAt: new Date().toISOString(), scene: parsed };
      return parsed;
    } catch (_) {
      return null;
    }
  }

  _docFromDrawingRecord(record) {
    const raw = this._readRecordTextField(record, EXCAL_FIELD_SCENE);
    const doc = this._parseSceneDoc(raw);
    if (!doc) return null;
    try {
      const ref = record.reference?.(EXCAL_FIELD_SOURCE_NOTE);
      if (ref && !doc.sourceRecordGuid) doc.sourceRecordGuid = String(ref).trim();
    } catch (_) {}
    return doc;
  }

  async _findDrawingRecordBySourceGuid(drawingsColl, sourceGuid, noteTitle) {
    if (!sourceGuid) return null;
    if (this._drawingRecordCache.has(sourceGuid)) {
      const cached = this._drawingRecordCache.get(sourceGuid);
      if (cached) return cached;
    }

    const session = this._panelSession;
    if (session?.drawingRecordGuid && session.recordGuid === sourceGuid) {
      try {
        const colls = await this._getAllDrawingsCollections();
        for (const coll of colls) {
          try {
            const all = await coll.getAllRecords();
            const pinned = (all || []).find((x) => x.guid === session.drawingRecordGuid);
            if (pinned) {
              this._drawingRecordCache.set(sourceGuid, pinned);
              return pinned;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    const colls = drawingsColl ? [drawingsColl] : [];
    try {
      const all = await this._getAllDrawingsCollections();
      for (const c of all) {
        if (!colls.find((x) => this._getCollectionGuid(x) === this._getCollectionGuid(c))) {
          colls.push(c);
        }
      }
    } catch (_) {}

    const titleNeedle = noteTitle ? this._drawingTitleForNote(noteTitle) : '';
    const matches = [];
    let totalScanned = 0;

    for (const coll of colls) {
      let records = [];
      try {
        records = await coll.getAllRecords();
      } catch (_) { continue; }
      totalScanned += (records || []).length;

      for (const r of records || []) {
        let matched = false;
        try {
          const ref = r.reference?.(EXCAL_FIELD_SOURCE_NOTE);
          if (ref && String(ref).trim() === sourceGuid) matched = true;
        } catch (_) {}
        if (!matched) {
          const stored = this._readRecordTextField(r, EXCAL_FIELD_SOURCE_GUID);
          if (stored === sourceGuid) matched = true;
        }
        if (!matched && titleNeedle) {
          try {
            const nm = String(r.getName?.() || '').trim();
            if (nm === titleNeedle) matched = true;
          } catch (_) {}
        }
        if (matched) matches.push(r);
      }
    }

    if (!matches.length) {
      try {
        const srcRec = await this._resolveSourceRecord(sourceGuid);
        if (srcRec) {
          const directGuid = this._readRecordRef(srcRec, 'excalidrawing');
          if (directGuid) {
            for (const coll of colls) {
              try {
                const all = await coll.getAllRecords();
                const direct = (all || []).find((x) => x.guid === directGuid);
                if (direct) {
                  this._drawingRecordCache.set(sourceGuid, direct);
                  return direct;
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
      this._drawingRecordCache.set(sourceGuid, null);
      console.warn(`[${EXCAL_PLUGIN_NAME}] _findDrawingRecordBySourceGuid: no match for sourceGuid=${sourceGuid} titleNeedle=${JSON.stringify(titleNeedle)} scanned=${totalScanned} collections=${colls.length}`);
      return null;
    }

    let best = matches[0];
    for (const r of matches) {
      if (this._readRecordTextField(r, EXCAL_FIELD_SCENE)) {
        best = r;
        break;
      }
    }

    this._drawingRecordCache.set(sourceGuid, best);
    return best;
  }

  async _getAllDrawingsCollections() {
    const out = [];
    const seen = new Set();
    const add = (c) => {
      if (!c) return;
      const g = this._getCollectionGuid(c);
      if (g) {
        if (seen.has(g)) return;
        seen.add(g);
      }
      out.push(c);
    };
    try {
      const primary = await this._ensureDrawingsCollection();
      add(primary);
    } catch (_) {}
    try {
      const all = await this.data?.getAllCollections?.();
      for (const c of all || []) {
        if (this._collectionLooksLikeDrawings(c)) add(c);
      }
    } catch (_) {}
    return out;
  }

  async _resolveSourceRecord(sourceGuid) {
    try {
      const r = this.data?.getRecord?.(sourceGuid);
      if (r) return r;
    } catch (_) {}
    try {
      const active = this.ui.getActivePanel()?.getActiveRecord?.();
      if (active?.guid === sourceGuid) return active;
    } catch (_) {}
    return null;
  }

  _setPanelTitle(panel, session) {
    const title = this._drawingTitleForNote(session?.recordName || 'Untitled');
    try {
      panel?.setTitle?.(title);
    } catch (_) {}
  }

  _setPanelStatus(session, statusText) {
    const status = String(statusText || '').trim();
    const el = session?.statusEl;
    if (!el) return;
    if (session?.statusTextEl) {
      session.statusTextEl.textContent = status || '';
    } else {
      el.textContent = status || '';
    }
    el.classList.remove(
      'excal-status--idle',
      'excal-status--dirty',
      'excal-status--saving',
      'excal-status--saved',
      'excal-status--error',
    );
    const lower = status.toLowerCase();
    if (lower.includes('fail')) el.classList.add('excal-status--error');
    else if (lower.includes('unsaved')) el.classList.add('excal-status--dirty');
    else if (lower.includes('saving')) el.classList.add('excal-status--saving');
    else if (lower.includes('saved')) el.classList.add('excal-status--saved');
    else if (status) el.classList.add('excal-status--idle');
  }

  _ensureStageChrome(stage, session) {
    if (!stage || !session?.statusEl) return;
    if (!stage.contains(session.statusEl)) stage.appendChild(session.statusEl);
  }

  _isExcalScriptLoadError(err) {
    const msg = String(err?.message || err || '');
    return /UMD globals|Script (failed|timed out)|load failed/i.test(msg);
  }

  _stretchPanelAncestors(el) {
    if (!el) return;
    let node = el;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      node.classList.add('excal-panel-host');
      node.style.minWidth = '0';
      node = node.parentElement;
    }
  }

  /**
   * Width: smallest visible column (avoids iframe-wide clipping).
   * Height: largest credible panel height (avoids sliver collapse).
   */
  _measureEditorSlot(session) {
    const stage = session?.stageEl;
    const panelEl = session?.panel?.getElement?.();
    const widths = [];
    const heights = [];
    for (const el of [stage, panelEl]) {
      if (!el) continue;
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0) widths.push(r.width);
        if (r.height >= 40) heights.push(r.height);
      } catch (_) {}
      if (el.clientWidth > 0) widths.push(el.clientWidth);
      if (el.clientHeight >= 40) heights.push(el.clientHeight);
      if (el.offsetHeight >= 40) heights.push(el.offsetHeight);
    }

    let node = panelEl?.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      if (node.clientHeight >= 40) heights.push(node.clientHeight);
      try {
        const r = node.getBoundingClientRect();
        if (r.height >= 40) heights.push(r.height);
      } catch (_) {}
      node = node.parentElement;
    }

    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    let w = widths.length ? Math.min(...widths) : 0;
    let h = heights.length ? Math.max(...heights) : 0;
    if (h < 200 && vh > 0) h = Math.max(h, Math.round(vh * 0.72));
    if (w < 80 && vw > 0 && panelEl) {
      try {
        const pr = panelEl.getBoundingClientRect();
        if (pr.width > 0) w = pr.width;
      } catch (_) {}
    }

    const host = session?.hostEl;
    if (host) {
      try {
        const hr = host.getBoundingClientRect();
        if (hr.width >= 40 && hr.height >= 40) {
          return {
            w: Math.max(1, Math.round(hr.width)),
            h: Math.max(200, Math.round(hr.height)),
          };
        }
      } catch (_) {}
      if (host.clientWidth >= 40 && host.clientHeight >= 40) {
        return {
          w: Math.max(1, host.clientWidth),
          h: Math.max(200, host.clientHeight),
        };
      }
    }

    const padW = EXCAL_FRAME_PAD_X * 2;
    const padH = EXCAL_FRAME_PAD_TOP + EXCAL_FRAME_PAD_BOTTOM;
    return {
      w: Math.max(1, Math.round(w) - padW),
      h: Math.max(200, Math.round(h) - padH),
    };
  }

  _hostFrameInset() {
    return {
      top: `${EXCAL_FRAME_PAD_TOP}px`,
      right: `${EXCAL_FRAME_PAD_X}px`,
      bottom: `${EXCAL_FRAME_PAD_BOTTOM}px`,
      left: `${EXCAL_FRAME_PAD_X}px`,
    };
  }

  _preparePanelShell(el, root, stage, session) {
    el.classList.add('excal-panel-shell');
    el.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;min-height:0;min-width:0;width:100%;max-width:100%;overflow:hidden;padding:0;margin:0;background:transparent;box-sizing:border-box;';
    root.style.cssText =
      'flex:1 1 auto;display:flex;flex-direction:column;min-height:0;min-width:0;width:100%;max-width:100%;height:100%;overflow:hidden;background:transparent;box-sizing:border-box;';
    stage.style.cssText =
      `flex:1 1 auto;min-height:200px;min-width:0;width:100%;max-width:100%;height:100%;position:relative;overflow:hidden;box-sizing:border-box;border-radius:${EXCAL_FRAME_RADIUS}px;`;
    session.rootEl = root;
    session.stageEl = stage;
    session.shellEl = el;
    const panelEl = session?.panel?.getElement?.();
    if (panelEl && !panelEl.style.position) panelEl.style.position = 'relative';
    this._stretchPanelAncestors(el);
  }

  _syncPanelLayout(session) {
    const panelEl = session?.panel?.getElement?.();
    const stage = session?.stageEl;
    const host = session?.hostEl;
    const shell = session?.shellEl;
    const root = session?.rootEl;
    if (!panelEl || !stage) return;

    if (shell) this._stretchPanelAncestors(shell);

    const { h } = this._measureEditorSlot(session);

    for (const el of [shell, root, stage]) {
      if (!el) continue;
      el.style.width = '100%';
      el.style.maxWidth = '100%';
      el.style.minWidth = '0';
      el.style.margin = '0';
      el.style.left = '';
      el.style.right = '';
      el.style.transform = '';
    }

    stage.style.minHeight = `${h}px`;
    stage.style.height = '100%';

    if (host) {
      const inset = this._hostFrameInset();
      host.style.position = 'absolute';
      host.style.inset = `${inset.top} ${inset.right} ${inset.bottom} ${inset.left}`;
      host.style.top = inset.top;
      host.style.right = inset.right;
      host.style.bottom = inset.bottom;
      host.style.left = inset.left;
      host.style.width = 'auto';
      host.style.height = 'auto';
      host.style.maxWidth = 'none';
      host.style.margin = '0';
      host.style.overflow = 'hidden';
      host.style.borderRadius = `${EXCAL_INNER_RADIUS}px`;
    }

    try {
      session._excalResizeTick?.();
    } catch (_) {}
  }

  _markPanelAncestorsTransparent(el) {
    this._stretchPanelAncestors(el);
  }

  _installPageHideFlush() {
    if (this._pagehideUnsub) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const flushOnHide = () => {
      try {
        if (typeof document !== 'undefined' && document.visibilityState
          && document.visibilityState !== 'hidden' && document.visibilityState !== 'unloaded') {
          // For visibilitychange only — we only flush on hidden, not visible
          // (avoids spurious flushes when refocusing the tab).
        }
        void this._flushPanelSession(true);
      } catch (_) {}
    };
    const onVisChange = () => {
      try {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          flushOnHide();
        }
      } catch (_) {}
    };
    window.addEventListener('pagehide', flushOnHide);
    window.addEventListener('beforeunload', flushOnHide);
    document.addEventListener('visibilitychange', onVisChange);
    this._pagehideUnsub = () => {
      try { window.removeEventListener('pagehide', flushOnHide); } catch (_) {}
      try { window.removeEventListener('beforeunload', flushOnHide); } catch (_) {}
      try { document.removeEventListener('visibilitychange', onVisChange); } catch (_) {}
    };
  }

  _installContextMenuGuard(shellEl, session) {
    if (!shellEl || session?._contextMenuGuardInstalled) return;
    const onContextMenu = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    shellEl.addEventListener('contextmenu', onContextMenu);
    session._contextMenuGuardInstalled = true;
    session._contextMenuGuardDispose = () => {
      try { shellEl.removeEventListener('contextmenu', onContextMenu); } catch (_) {}
      session._contextMenuGuardInstalled = false;
      session._contextMenuGuardDispose = null;
    };
  }

  _excalThemeValue(theme) {
    return theme === 'dark' || theme === 'light' ? theme : null;
  }

  _patchSceneJsonForStorage(sceneJson, appState) {
    const theme = this._excalThemeValue(appState?.theme);
    if (!theme || !sceneJson) return sceneJson;
    try {
      const parsed = typeof sceneJson === 'string' ? JSON.parse(sceneJson) : sceneJson;
      if (!parsed || typeof parsed !== 'object') return sceneJson;
      parsed.appState = { ...(parsed.appState || {}), theme };
      return JSON.stringify(parsed);
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] patch scene theme`, e);
      return sceneJson;
    }
  }

  _syncStageTheme(session, theme) {
    const value = this._excalThemeValue(theme);
    if (!session?.stageEl) return;
    if (value) session.stageEl.dataset.excalTheme = value;
    else delete session.stageEl.dataset.excalTheme;
  }

  _createExcalidrawMountElement(React, Excalidraw, session, plugin, initialData) {
    const measureSlot = () => plugin._measureEditorSlot(session);

    const ExcalidrawAutoSize = function ExcalidrawAutoSize(props) {
      const [dims, setDims] = React.useState(() => measureSlot());

      const measure = React.useCallback(() => {
        const next = measureSlot();
        setDims((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
      }, []);

      React.useLayoutEffect(() => {
        measure();
        let ro = null;
        const stage = session.stageEl;
        const host = session.hostEl;
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(() => measure());
          if (stage) ro.observe(stage);
          if (host) ro.observe(host);
        }
        session._excalResizeTick = measure;
        return () => {
          session._excalResizeTick = null;
          try { ro?.disconnect(); } catch (_) {}
        };
      }, [measure]);

      const { w, h } = dims.w > 0 && dims.h > 0 ? dims : measureSlot();

      return React.createElement(
        'div',
        {
          className: 'excal-autosize',
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            maxWidth: '100%',
            overflow: 'hidden',
            margin: 0,
          },
        },
        React.createElement(Excalidraw, {
          ...props,
          width: w,
          height: h,
        }),
      );
    };

    const savedTheme = plugin._excalThemeValue(initialData?.appState?.theme);

    return React.createElement(ExcalidrawAutoSize, {
      initialData: initialData || undefined,
      theme: savedTheme || undefined,
      UIOptions: {
        getFormFactor: () => 'desktop',
      },
      excalidrawAPI: (api) => {
        session.excalApi = api;
        if (savedTheme) {
          plugin._syncStageTheme(session, savedTheme);
          try {
            api.updateScene({ appState: { theme: savedTheme } });
          } catch (_) {}
        }
      },
      onChange: (elements, appState, files) => {
        plugin._syncStageTheme(session, appState?.theme);
        const echoSuppressed = session.applyingRemoteUpdate || (Date.now() - (session.lastRemoteApplyMs || 0) < EXCAL_ECHO_GUARD_MS);
        if (!echoSuppressed) {
          session.pendingScene = plugin._serializeScene(session.excalLib, elements, appState, files);
          session.dirty = true;
          plugin._setPanelStatus(session, 'Unsaved changes');
          clearTimeout(session.saveTimer);
          session.saveTimer = setTimeout(() => {
            void plugin._flushPanelSession(false);
          }, plugin._autosaveMs);
        }
        console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: onChange ${elements.length} els, applyingRemote=${session.applyingRemoteUpdate} echoSuppressed=${echoSuppressed}`);
        if (!echoSuppressed) {
          plugin._scheduleWsBroadcast(session, elements);
        }
      },
    });
  }

  _localDrawKey(recordGuid) {
    return `${EXCAL_DRAW_PREFIX}${recordGuid}`;
  }

  async _waitForHostLayout(session) {
    const host = session?.hostEl;
    const stage = session?.stageEl;
    if (!host && !stage) return false;
    for (let i = 0; i < 12; i++) {
      this._syncPanelLayout(session);
      const h = Math.max(host?.offsetHeight || 0, stage?.offsetHeight || 0);
      const w = Math.max(host?.offsetWidth || 0, stage?.offsetWidth || 0);
      if (h >= 80 && w >= 120) return true;
      await this._excalSleep(i < 4 ? 40 : 80);
    }
    return Math.max(host?.offsetHeight || 0, stage?.offsetHeight || 0) >= 40;
  }

  _injectCSS() {
    if (this._cssInjected) return;
    this._cssInjected = true;
    this.ui.injectCSS?.(`
      .excal-panel-host {
        background: transparent !important;
        background-color: transparent !important;
        align-items: stretch !important;
        min-width: 0 !important;
      }
      .excal-panel-shell {
        position: absolute !important;
        inset: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        min-height: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        overflow: hidden !important;
        margin: 0 !important;
      }
      .excal-panel-root {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        height: 100%;
        width: 100%;
        max-width: 100%;
        min-height: 0;
        box-sizing: border-box;
        background: transparent;
        color: inherit;
        overflow: hidden;
      }
      .excal-panel-stage > .excal-panel-statusbar {
        position: absolute;
        top: auto;
        bottom: ${EXCAL_FRAME_PAD_BOTTOM + 14}px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 20;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 9px 20px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
        opacity: 1;
        background: #0f172a !important;
        color: #f8fafc !important;
        border: 2px solid rgba(255, 255, 255, 0.45) !important;
        border-radius: 10px;
        pointer-events: none;
        max-width: calc(100% - ${EXCAL_FRAME_PAD_X * 2 + 24}px);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55) !important;
        -webkit-font-smoothing: antialiased;
      }
      .excal-panel-stage > .excal-panel-statusbar.excal-status--dirty {
        background: #ea580c !important;
        color: #ffffff !important;
        border-color: #fed7aa !important;
        box-shadow: 0 0 0 3px rgba(234, 88, 12, 0.55), 0 6px 24px rgba(0, 0, 0, 0.55) !important;
      }
      .excal-panel-stage[data-excal-theme="dark"] > .excal-panel-statusbar.excal-status--dirty {
        background: #fff7ed !important;
        color: #9a3412 !important;
        border-color: #fdba74 !important;
        box-shadow: 0 0 0 3px rgba(255, 237, 213, 0.35), 0 6px 24px rgba(0, 0, 0, 0.65) !important;
      }
      .excal-panel-stage > .excal-panel-statusbar.excal-status--saving {
        background: #2563eb !important;
        color: #ffffff !important;
        border-color: #bfdbfe !important;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.45), 0 6px 24px rgba(0, 0, 0, 0.55) !important;
      }
      .excal-panel-stage > .excal-panel-statusbar.excal-status--saved {
        background: #16a34a !important;
        color: #ffffff !important;
        border-color: #bbf7d0 !important;
        box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.4), 0 6px 24px rgba(0, 0, 0, 0.55) !important;
      }
      .excal-panel-stage[data-excal-theme="dark"] > .excal-panel-statusbar.excal-status--saved {
        background: #dcfce7 !important;
        color: #14532d !important;
        border-color: #86efac !important;
      }
      .excal-panel-stage > .excal-panel-statusbar.excal-status--error {
        background: #dc2626 !important;
        color: #ffffff !important;
        border-color: #fecaca !important;
        box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.45), 0 6px 24px rgba(0, 0, 0, 0.55) !important;
      }
      .excal-panel-stage > .excal-panel-statusbar.excal-status--idle {
        background: #1e293b !important;
        color: #f1f5f9 !important;
        border-color: rgba(255, 255, 255, 0.35) !important;
      }
      .excal-panel-stage {
        flex: 1 1 auto;
        min-height: 200px;
        min-width: 0;
        height: 100%;
        width: 100%;
        max-width: 100%;
        position: relative;
        margin: 0;
        padding: 0;
        border-radius: ${EXCAL_FRAME_RADIUS}px;
        overflow: hidden;
        background: transparent;
        box-sizing: border-box;
      }
      .excal-autosize {
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        height: 100%;
        max-width: 100%;
        overflow: hidden;
        margin: 0;
      }
      .excal-panel-stage > .excal-host {
        position: absolute;
        inset: ${EXCAL_FRAME_PAD_TOP}px ${EXCAL_FRAME_PAD_X}px ${EXCAL_FRAME_PAD_BOTTOM}px ${EXCAL_FRAME_PAD_X}px;
        width: auto;
        height: auto;
        max-width: none;
        min-width: 0;
        overflow: hidden;
        border-radius: ${EXCAL_INNER_RADIUS}px;
        background: #fff;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
      }
      .excal-host .excalidraw,
      .excal-host .excalidraw-container,
      .excal-host .excalidraw-wrapper {
        max-width: 100% !important;
        overflow: hidden !important;
      }
      .excal-host .excalidraw.theme--dark,
      .excal-host .excalidraw.theme--light {
        --max-width: none !important;
      }
      .excal-host .excalidraw .App-menu_top {
        max-width: 100% !important;
      }
      .excal-panel-loading {
        position: absolute;
        inset: ${EXCAL_FRAME_PAD_TOP}px ${EXCAL_FRAME_PAD_X}px ${EXCAL_FRAME_PAD_BOTTOM}px ${EXCAL_FRAME_PAD_X}px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        opacity: 0.8;
        background: rgba(0, 0, 0, 0.2);
        z-index: 2;
        border-radius: ${EXCAL_INNER_RADIUS}px;
      }
      .excal-panel-statusbar > .excal-data-btn {
        pointer-events: auto;
        display: inline-block;
        width: 22px;
        height: 22px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font-size: 13px;
        line-height: 22px;
        text-align: center;
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 0.15s;
        flex-shrink: 0;
      }
      .excal-panel-statusbar > .excal-data-btn:hover {
        opacity: 1;
        background: rgba(255, 255, 255, 0.15);
      }
    `);
  }

  _readRecordRef(record, fieldId) {
    if (!record || !fieldId) return '';
    const ids = [fieldId];
    if (fieldId === EXCAL_SOURCE_FIELD_ID) ids.push(EXCAL_SOURCE_FIELD_LABEL);
    for (const id of ids) {
      try {
        const ref = record.reference?.(id);
        if (ref) return String(ref).trim();
      } catch (_) {}
      try {
        const p = record.prop?.(id);
        if (p?.linkedRecord) {
          const lr = p.linkedRecord();
          if (lr?.guid) return String(lr.guid).trim();
        }
        const v = p?.get?.();
        if (v && typeof v === 'object' && v.guid) return String(v.guid).trim();
        if (v != null && String(v).trim()) return String(v).trim();
      } catch (_) {}
    }
    return '';
  }

  _noteHasDrawingHint(record) {
    if (!record?.guid) return false;
    if (this._readRecordRef(record, EXCAL_SOURCE_FIELD_ID)) return true;
    if (this._drawingRecordCache.get(record.guid)) return true;
    try {
      const raw = localStorage.getItem(this._localDrawKey(record.guid));
      if (raw && String(raw).trim()) return true;
    } catch (_) {}
    return false;
  }

  async _noteHasDrawing(record) {
    if (!record?.guid) return false;
    if (this._noteHasDrawingHint(record)) return true;
    const coll = await this._ensureDrawingsCollection();
    if (!coll) return false;
    const hit = await this._findDrawingRecordBySourceGuid(coll, record.guid, record.getName?.());
    return !!hit;
  }

  _isDrawingBackendRecord(record) {
    if (!record?.guid) return false;
    let coll = null;
    try {
      coll = record.getCollection?.() || null;
    } catch (_) {}
    if (coll && this._collectionLooksLikeDrawings(coll)) return true;
    if (this._readRecordTextField(record, EXCAL_FIELD_SCENE)) return true;
    const nm = String(record.getName?.() || '').trim();
    return nm.includes('Excalidrawing');
  }

  async _sourceGuidForDrawingRecord(drawingRecord) {
    const direct = this._sourceGuidFromDrawingRecord(drawingRecord);
    if (direct) return direct;
    const dg = drawingRecord?.guid;
    if (!dg) return '';
    for (const [srcGuid, dr] of this._drawingRecordCache.entries()) {
      if (dr?.guid === dg) return srcGuid;
    }
    const coll = await this._ensureDrawingsCollection();
    if (!coll) return '';
    try {
      const all = await coll.getAllRecords();
      for (const r of all || []) {
        if (r.guid !== dg) continue;
        const src = this._sourceGuidFromDrawingRecord(r);
        if (src) return src;
      }
    } catch (_) {}
    return '';
  }

  _sourceGuidFromDrawingRecord(record) {
    if (!record) return '';
    const fromRef = this._readRecordRef(record, EXCAL_FIELD_SOURCE_NOTE);
    if (fromRef) return fromRef;
    return this._readRecordTextField(record, EXCAL_FIELD_SOURCE_GUID);
  }

  _mountExcalSidebarItem() {
    if (typeof this.ui?.addSidebarItem !== 'function') return;
    try {
      this._excalSidebarItem = this.ui.addSidebarItem({
        icon: EXCAL_ICON,
        label: 'Excalidrawing',
        tooltip: 'Open or create a drawing for the current note',
        onClick: () => {
          setTimeout(() => { void this._openDrawingPanel(); }, 40);
        },
      });
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] sidebar item`, e);
      this._excalSidebarItem = null;
    }
  }

  _mountExcalStatusBar() {
    if (typeof this.ui?.addStatusBarItem !== 'function') return;
    try {
      this._excalStatusItem = this.ui.addStatusBarItem({
        icon: EXCAL_ICON,
        label: 'Excalidrawing',
        tooltip: 'Open or create a drawing for the current note',
        onClick: () => {
          setTimeout(() => { void this._openDrawingPanel(); }, 40);
        },
      });
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] status bar`, e);
      this._excalStatusItem = null;
    }
  }

  async _resolveDrawingRecordGuid(record, sourceColl) {
    if (!record?.guid) return null;

    const fromProp = this._readRecordRef(record, EXCAL_SOURCE_FIELD_ID);
    if (fromProp) return fromProp;

    const drawingsColl = await this._ensureDrawingsCollection();
    if (!drawingsColl) return null;

    const recordGuid = record.guid;
    const recordName = record.getName?.() || 'Untitled';
    const existing = await this._findDrawingRecordBySourceGuid(drawingsColl, recordGuid, recordName);
    if (existing?.guid) {
      try {
        const excProp = record.prop?.(EXCAL_SOURCE_FIELD_ID);
        if (excProp) this._linkRecordProperty(excProp, existing.guid, EXCAL_SOURCE_FIELD_ID, record);
      } catch (_) {}
      return existing.guid;
    }

    if (sourceColl) {
      const drawingsCollGuid = this._getCollectionGuid(drawingsColl);
      if (drawingsCollGuid) await this._ensureExcalidrawingFieldOnCollection(sourceColl, drawingsCollGuid);
    }

    const emptyScene = {
      sceneJson: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: EXCAL_PLUGIN_NAME,
        elements: [],
        appState: { gridSize: null },
        files: {},
      }),
    };

    try {
      await this._saveDrawingDoc(recordGuid, recordName, emptyScene);
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] ensure drawing record`, e);
      return null;
    }

    const created = await this._findDrawingRecordBySourceGuid(drawingsColl, recordGuid, recordName);
    return created?.guid || this._readRecordRef(record, EXCAL_SOURCE_FIELD_ID) || null;
  }

  async _openDrawingPanel() {
    const record = this._getActiveRecord();
    if (!record?.guid) {
      this.ui.addToaster?.({
        title: EXCAL_PLUGIN_NAME,
        message: 'Open a note first, then try Excalidrawing again.',
        dismissible: true,
        autoDestroyTime: 4500,
      });
      return;
    }

    if (this._isDrawingBackendRecord(record)) {
      const sourceGuid = await this._sourceGuidForDrawingRecord(record);
      if (sourceGuid) {
        await this._openDrawingFromDrawingRecord(record, this.ui.getActivePanel?.(), sourceGuid);
        return;
      }
    }

    const sourcePanel = this.ui.getActivePanel?.();
    const sourceColl = sourcePanel?.getActiveCollection?.() || null;
    const drawingRecordGuid = await this._resolveDrawingRecordGuid(record, sourceColl);

    await this._openDrawingPanelWithSession({
      recordGuid: record.guid,
      recordName: record.getName?.() || 'Untitled',
      sourceColl,
      drawingRecordGuid,
      sourcePanel,
    });
  }

  _schedulePanelChrome(panel) {
    if (this._navChromeTimer) clearTimeout(this._navChromeTimer);
    if (this._navChromeRetryTimer) clearTimeout(this._navChromeRetryTimer);
    this._navChromeTimer = setTimeout(() => {
      this._navChromeTimer = null;
      void this._refreshPanelChrome(panel);
    }, 200);
    this._navChromeRetryTimer = setTimeout(() => {
      this._navChromeRetryTimer = null;
      void this._refreshPanelChrome(panel, true);
    }, 520);
  }

  async _refreshPanelChrome(panel, isRetry) {
    panel = panel || this.ui.getActivePanel?.();
    if (!panel) return;

    const navType = panel?.getNavigation?.()?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') return;

    const record = panel?.getActiveRecord?.();

    if (this._showDataPanelIds?.has(panel?.getId?.())) return;

    if (this._navInterceptBusy || !record) return;
    if (!this._isDrawingBackendRecord(record)) return;

    let sourceGuid = await this._sourceGuidForDrawingRecord(record);
    if (!sourceGuid && isRetry) {
      await this._excalSleep(250);
      sourceGuid = await this._sourceGuidForDrawingRecord(record);
    }
    if (!sourceGuid) return;

    this._navInterceptBusy = true;
    try {
      await this._openDrawingFromDrawingRecord(record, panel, sourceGuid);
    } finally {
      this._navInterceptBusy = false;
    }
  }

  _findPanelShowingRecord(recordGuid, exceptPanel) {
    const guid = String(recordGuid || '').trim();
    if (!guid) return null;
    let panels = [];
    try {
      panels = this.ui.getPanels?.() || [];
    } catch (_) {
      return null;
    }
    for (const p of panels) {
      if (!p) continue;
      if (exceptPanel?.getId && p.getId?.() === exceptPanel.getId()) continue;
      const r = p.getActiveRecord?.();
      if (r?.guid === guid) return p;
    }
    return null;
  }

  async _openDrawingFromDrawingRecord(drawingRecord, panel, sourceGuid) {
    const sourceRecord = await this._resolveSourceRecord(sourceGuid);
    if (!sourceRecord) return;

    let sourceColl = null;
    try {
      sourceColl = sourceRecord.getCollection?.() || null;
    } catch (_) {}

    const noteAlreadyOpen = this._findPanelShowingRecord(sourceGuid, panel);

    if (noteAlreadyOpen) {
      await this._openDrawingPanelWithSession({
        recordGuid: sourceGuid,
        recordName: sourceRecord.getName?.() || 'Untitled',
        sourceColl,
        drawingRecordGuid: drawingRecord.guid,
        sourcePanel: panel,
        useCurrentPanel: true,
      });
      return;
    }

    if (panel?.navigateTo) {
      try {
        panel.navigateTo({
          type: 'edit_panel',
          rootId: sourceGuid,
          subId: sourceColl ? this._getCollectionGuid(sourceColl) : null,
          workspaceGuid: this.getWorkspaceGuid?.() || null,
        });
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] navigate to source note`, e);
      }
    }

    await this._openDrawingPanelWithSession({
      recordGuid: sourceGuid,
      recordName: sourceRecord.getName?.() || 'Untitled',
      sourceColl,
      drawingRecordGuid: drawingRecord.guid,
      sourcePanel: panel,
    });
  }

  async _openDrawingPanelWithSession({
    recordGuid,
    recordName,
    sourceColl,
    drawingRecordGuid,
    sourcePanel,
    useCurrentPanel,
  }) {
    this._panelSession = {
      recordGuid,
      recordName: recordName || 'Untitled',
      sourceColl: sourceColl || null,
      drawingRecordGuid: drawingRecordGuid || null,
      _instanceTag: this._instanceTag,
      senderId: `excal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      saveTimer: null,
      pendingScene: null,
      dirty: false,
      reactRoot: null,
      hostEl: null,
      panel: null,
      statusEl: null,
      saveInFlight: false,
      excalApi: null,
      applyingRemoteUpdate: false,
      lastRemoteApplyMs: 0,
      wsUnsub: null,
      recordUpdateEventId: null,
      reloadEventId: null,
      lastBroadcastElements: null,
      wsThrottleTimer: null,
      wsPendingBroadcast: false,
    };

    let targetPanel = sourcePanel;
    if (!useCurrentPanel) {
      try {
        const created = await this.ui.createPanel?.({ afterPanel: sourcePanel || undefined });
        if (created) targetPanel = created;
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] createPanel`, e);
      }
    }

    if (!targetPanel?.navigateToCustomType) {
      this.ui.addToaster?.({
        title: EXCAL_PLUGIN_NAME,
        message: 'Could not open a drawing panel.',
        dismissible: true,
        autoDestroyTime: 5000,
      });
      return;
    }
    targetPanel.navigateToCustomType(EXCAL_PANEL_TYPE);
  }

  _getActiveRecord() {
    const panel = this.ui.getActivePanel?.();
    return panel?.getActiveRecord?.() || null;
  }

  async _mountDrawingPanel(panel) {
    const el = panel.getElement?.();
    if (!el) return;

    const session = this._panelSession;
    if (!session?.recordGuid) {
      el.innerHTML = '<div class="excal-panel-root"><div class="excal-panel-loading">No note selected. Close this panel and use the command from an open note.</div></div>';
      panel.setTitle?.(`${EXCAL_PLUGIN_NAME}`);
      return;
    }

    session.panelId = panel.getId?.() || null;
    session.panel = panel;
    this._setPanelTitle(panel, session);
    el.innerHTML = '';
    this._markPanelAncestorsTransparent(el);

    const root = document.createElement('div');
    root.className = 'excal-panel-root';

    const stage = document.createElement('div');
    stage.className = 'excal-panel-stage';

    const statusBar = document.createElement('div');
    statusBar.className = 'excal-panel-statusbar';
    const statusText = document.createElement('span');
    statusText.textContent = 'Loading…';
    statusBar.appendChild(statusText);
    session.statusEl = statusBar;
    session.statusTextEl = statusText;

    const loading = document.createElement('div');
    loading.className = 'excal-panel-loading';
    loading.textContent = 'Loading Excalidraw…';
    stage.appendChild(loading);
    stage.appendChild(statusBar);

    if (session.drawingRecordGuid) {
      const dataBtn = document.createElement('button');
      dataBtn.className = 'excal-data-btn';
      dataBtn.title = 'Show raw drawing record (version history)';
      dataBtn.textContent = '\u{1F4CB}';
      dataBtn.addEventListener('click', async () => {
        const dg = session.drawingRecordGuid;
        if (!dg) return;
        try {
          const np = await this.ui.createPanel?.({ afterPanel: session.panel || undefined });
          if (np) {
            if (np?.getId) this._showDataPanelIds?.add(np.getId());
            np.navigateTo({
              type: 'edit_panel',
              rootId: dg,
              workspaceGuid: this.getWorkspaceGuid?.() || null,
            });
          }
        } catch (e) {
          console.warn(`[${EXCAL_PLUGIN_NAME}] Show data`, e);
        }
      });
      statusBar.appendChild(dataBtn);
    }

    root.appendChild(stage);
    el.appendChild(root);
    this._preparePanelShell(el, root, stage, session);
    this._syncPanelLayout(session);

    const setProgress = (msg) => {
      this._setPanelStatus(session, msg);
      loading.textContent = msg;
    };

    try {
      setProgress('Loading editor…');
      const bundle = await this._loadExcalidrawBundle(setProgress);

      if (bundle.mode === 'iframe') {
        loading.remove();
        await this._mountIframeEditor(stage, panel, session, setProgress, null);
        return;
      }

      setProgress('Loading saved drawing…');
      const doc = await this._withTimeout(
        this._loadDrawingDoc(session.recordGuid),
        12000,
        'Drawing storage read',
      ).catch((e) => {
        console.warn(`[${EXCAL_PLUGIN_NAME}] drawing doc`, e);
        return null;
      });

      loading.remove();

      const host = document.createElement('div');
      host.className = 'excal-host';
      stage.appendChild(host);
      session.hostEl = host;
      this._syncPanelLayout(session);

      const rawScene = doc?.scene || null;
      const initialData = this._buildInitialData(doc, bundle.lib);
      this._syncStageTheme(session, initialData?.appState?.theme);
      const hasContent = this._sceneDocHasContent(doc);

      const { React, createRoot, Excalidraw } = bundle;
      const rootEl = createRoot(host);
      session.reactRoot = rootEl;
      session.excalLib = bundle.lib;

      rootEl.render(
        this._createExcalidrawMountElement(React, Excalidraw, session, this, initialData),
      );

      this._installContextMenuGuard(session.shellEl, session);
      this._attachResizeObserver(stage, session);

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      this._syncPanelLayout(session);
      await this._waitForHostLayout(session);
      this._syncPanelLayout(session);

      this._setupRealtimeListeners(session);
      this._setPanelStatus(session, hasContent ? 'Loaded' : 'Ready');
      requestAnimationFrame(() => this._syncPanelLayout(session));
    } catch (e) {
      console.error(`[${EXCAL_PLUGIN_NAME}] mount`, e);
      try { session?.reactRoot?.unmount?.(); } catch (_) {}
      session.reactRoot = null;
      try { loading.remove(); } catch (_) {}

      if (this._isExcalScriptLoadError(e)) {
        stage.innerHTML = '';
        session.hostEl = null;
        this._ensureStageChrome(stage, session);
        this._syncPanelLayout(session);
        await this._mountIframeEditor(stage, panel, session, setProgress, null);
        this.ui.addToaster?.({
          title: EXCAL_PLUGIN_NAME,
          message: 'Embedded editor unavailable — using excalidraw.com instead.',
          dismissible: true,
          autoDestroyTime: 5000,
        });
        return;
      }

      this._ensureStageChrome(stage, session);
      this._syncPanelLayout(session);
      for (let i = 0; i < 10; i++) {
        await this._excalSleep(80);
        this._syncPanelLayout(session);
        try { session.excalApi?.refresh?.(); } catch (_) {}
        const hostH = session.hostEl?.offsetHeight || session.stageEl?.offsetHeight || 0;
        if (session.excalApi && hostH >= 80) break;
      }

      if (session.excalApi) {
        this._setPanelStatus(session, 'Ready');
        return;
      }

      if (!stage.querySelector('.excal-mount-error')) {
        const errBox = document.createElement('div');
        errBox.className = 'excal-mount-error excal-panel-loading';
        errBox.textContent = 'Could not mount Excalidraw. Close this panel and run the command again.';
        stage.appendChild(errBox);
      }
      this._setPanelStatus(session, 'Mount failed');
      this.ui.addToaster?.({
        title: EXCAL_PLUGIN_NAME,
        message: 'Editor mount failed — close the panel and try again (not switching to excalidraw.com).',
        dismissible: true,
        autoDestroyTime: 6000,
      });
    }
  }

  async _mountIframeEditor(stage, panel, session, setProgress, existingWrap) {
    setProgress('Using excalidraw.com embed');
    const doc = await this._loadDrawingDoc(session.recordGuid).catch(() => null);

    const hash = doc?.shareHash || doc?.scene?.shareHash;
    const iframe = existingWrap?.querySelector('iframe') || null;
    if (iframe && hash && typeof hash === 'string') {
      iframe.src = `https://excalidraw.com/#${hash.replace(/^#/, '')}`;
    }
    if (!existingWrap) {
      const iframeWrap = document.createElement('div');
      iframeWrap.className = 'excal-host';
      iframeWrap.style.background = '#fff';
      const f = document.createElement('iframe');
      f.src = hash ? `https://excalidraw.com/#${hash.replace(/^#/, '')}` : 'https://excalidraw.com/';
      f.title = 'Excalidraw';
      f.setAttribute('allow', 'clipboard-write');
      f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
      iframeWrap.appendChild(f);
      stage.appendChild(iframeWrap);
    }

    if (stage.querySelector('.excal-iframe-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'excal-iframe-actions';
    actions.style.cssText = `position:absolute;left:${EXCAL_FRAME_PAD_X + 8}px;right:${EXCAL_FRAME_PAD_X + 8}px;bottom:${EXCAL_FRAME_PAD_BOTTOM + 8}px;z-index:3;padding:6px 8px;display:flex;gap:8px;align-items:center;font-size:11px;background:rgba(0,0,0,0.55);color:#fff;border-radius:8px;`;

    const hint = document.createElement('span');
    hint.style.opacity = '0.75';
    hint.textContent = 'Share → Get link, then save link to this note';

    const btnLink = document.createElement('button');
    btnLink.type = 'button';
    btnLink.textContent = 'Save share link to note';
    btnLink.style.cssText = 'padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
    btnLink.addEventListener('click', () => this._promptSaveShareLink(session));

    actions.append(hint, btnLink);
    stage.appendChild(actions);

    this._ensureStageChrome(stage, session);
    this._syncPanelLayout(session);
    this._setPanelStatus(session, hash ? 'Loaded share link' : 'Iframe mode — use Share link to save');
  }

  _promptSaveShareLink(session) {
    const raw = window.prompt(
      'Paste the Excalidraw share link or hash from Menu → Share → Get link.\nExample: json=abc123,xyz789',
      '',
    );
    if (!raw || !String(raw).trim()) return;
    let shareHash = String(raw).trim();
    try {
      if (shareHash.includes('excalidraw.com')) {
        const u = new URL(shareHash);
        shareHash = (u.hash || '').replace(/^#/, '');
      }
    } catch (_) {}
    shareHash = shareHash.replace(/^#/, '');
    if (!shareHash.startsWith('json=') && !shareHash.startsWith('room=')) {
      this.ui.addToaster?.({
        title: EXCAL_PLUGIN_NAME,
        message: 'Expected a link containing #json=… or #room=…',
        dismissible: true,
        autoDestroyTime: 6000,
      });
      return;
    }
    session.pendingScene = { shareHash };
    session.dirty = true;
    void this._saveDrawingDoc(session.recordGuid, session.recordName, { shareHash }).then(() => {
      session.dirty = false;
      this._setPanelStatus(session, 'Share link saved');
      this.ui.addToaster?.({
        title: EXCAL_PLUGIN_NAME,
        message: 'Share link saved to this note.',
        dismissible: true,
        autoDestroyTime: 4000,
      });
    });
  }

  _attachResizeObserver(stage, session) {
    if (session._resizeObs) {
      try { session._resizeObs.disconnect(); } catch (_) {}
    }
    if (typeof ResizeObserver !== 'function') return;
    const refresh = () => {
      clearTimeout(session._resizeTimer);
      session._resizeTimer = setTimeout(() => {
        this._syncPanelLayout(session);
      }, 60);
    };
    session._resizeObs = new ResizeObserver(refresh);
    const panelEl = session.panel?.getElement?.();
    const host = session.hostEl;
    if (stage) {
      try { session._resizeObs.observe(stage); } catch (_) {}
    }
    if (host && host !== stage) {
      try { session._resizeObs.observe(host); } catch (_) {}
    }
    if (panelEl && panelEl !== stage) {
      try { session._resizeObs.observe(panelEl); } catch (_) {}
    }
  }

  _serializeScene(lib, elements, appState, files) {
    const filtered = Array.isArray(elements)
      ? elements.filter((el) => !isDegenerateElement(el))
      : elements;
    if (lib?.serializeAsJSON) {
      try {
        // serializeAsJSON('local') uses export filters — theme is stripped (export:false).
        const sceneJson = this._patchSceneJsonForStorage(
          lib.serializeAsJSON(filtered, appState, files || {}, 'local'),
          appState,
        );
        return { sceneJson };
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] serializeAsJSON`, e);
      }
    }
    return {
      elements: filtered,
      appState: this._pickAppState(appState),
      files: files || {},
    };
  }

  _buildInitialData(doc, lib) {
    if (!doc) return null;
    if (doc.shareHash) return null;

    const restore = lib?.restore;
    const restoreElements = lib?.restoreElements;
    const restoreAppState = lib?.restoreAppState;

    if (doc.sceneJson && restore) {
      try {
        const parsed = typeof doc.sceneJson === 'string' ? JSON.parse(doc.sceneJson) : doc.sceneJson;
        const restored = restore(parsed, null, null);
        const appState = restored?.appState || {};
        const theme = this._excalThemeValue(appState.theme);
        return {
          elements: restored?.elements || [],
          appState: theme ? { ...appState, theme } : appState,
          files: restored?.files || {},
          scrollToContent: true,
        };
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] restore(sceneJson)`, e);
      }
    }

    const scene = doc.scene;
    if (!scene) return null;

    if (scene.sceneJson && restore) {
      try {
        const parsed = typeof scene.sceneJson === 'string' ? JSON.parse(scene.sceneJson) : scene.sceneJson;
        const restored = restore(parsed, null, null);
        const appState = restored?.appState || {};
        const theme = this._excalThemeValue(appState.theme);
        return {
          elements: restored?.elements || [],
          appState: theme ? { ...appState, theme } : appState,
          files: restored?.files || {},
          scrollToContent: true,
        };
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] restore(scene.sceneJson)`, e);
      }
    }

    const hasElements = (scene.elements || []).some((x) => x && !x.isDeleted);
    const hasFiles = scene.files && Object.keys(scene.files).length > 0;
    const hasAppState = scene.appState && Object.keys(scene.appState).length > 0;
    if (!hasElements && !hasFiles && !hasAppState) return null;

    let elements = scene.elements || [];
    let appState = scene.appState || {};
    if (restoreElements) {
      try {
        elements = restoreElements(scene.elements, null);
      } catch (_) {}
    }
    if (restoreAppState && scene.appState) {
      try {
        appState = restoreAppState(scene.appState, null);
      } catch (_) {}
    }
    return {
      elements,
      appState,
      files: scene.files || {},
      scrollToContent: true,
    };
  }

  _sceneDocHasContent(doc) {
    if (!doc) return false;
    if (doc.shareHash) return true;
    if (doc.sceneJson) {
      try {
        const parsed = typeof doc.sceneJson === 'string' ? JSON.parse(doc.sceneJson) : doc.sceneJson;
        const els = parsed?.elements || [];
        return els.some((x) => x && !x.isDeleted);
      } catch (_) {}
    }
    const scene = doc.scene;
    if (!scene) return false;
    if (scene.shareHash) return true;
    if (scene.sceneJson) {
      try {
        const parsed = typeof scene.sceneJson === 'string' ? JSON.parse(scene.sceneJson) : scene.sceneJson;
        const els = parsed?.elements || [];
        return els.some((x) => x && !x.isDeleted);
      } catch (_) {}
    }
    return (scene.elements || []).some((x) => x && !x.isDeleted);
  }

  _pickNewerDoc(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const ta = Date.parse(a.updatedAt || '') || 0;
    const tb = Date.parse(b.updatedAt || '') || 0;
    return tb > ta ? b : a;
  }

  _pickAppState(appState) {
    if (!appState || typeof appState !== 'object') return {};
    return {
      theme: appState.theme,
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    };
  }

  _withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  }

  _ensureExcalStylesheet(ver) {
    const version = String(ver || EXCAL_UMD_VERSION).trim() || EXCAL_UMD_VERSION;
    if (document.querySelector(`link[data-excal-css="${version}"]`)) return;
    const hrefs = [
      `https://unpkg.com/@excalidraw/excalidraw@${version}/dist/excalidraw.production.min.css`,
      `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${version}/dist/excalidraw.production.min.css`,
    ];
    for (const href of hrefs) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.excalCss = version;
      document.head.appendChild(link);
      break;
    }
  }

  _loadClassicScript(src, timeoutMs) {
    const existing = document.querySelector(`script[data-excal-src="${src}"]`);
    if (existing) {
      return existing.dataset.excalLoaded === '1'
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Script failed: ${src}`)), { once: true });
          });
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.dataset.excalSrc = src;
      const timer = setTimeout(() => {
        reject(new Error(`Script timed out: ${src}`));
      }, timeoutMs || 45000);
      s.onload = () => {
        clearTimeout(timer);
        s.dataset.excalLoaded = '1';
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Script failed: ${src}`));
      };
      document.head.appendChild(s);
    });
  }

  async _loadExcalidrawBundle(onProgress) {
    if (globalThis.__thymerExcalBundlePromise) return globalThis.__thymerExcalBundlePromise;

    globalThis.__thymerExcalBundlePromise = this._loadExcalidrawBundleInner(onProgress).catch((err) => {
      delete globalThis.__thymerExcalBundlePromise;
      throw err;
    });

    return globalThis.__thymerExcalBundlePromise;
  }

  async _loadExcalidrawBundleInner(onProgress) {
    const prog = typeof onProgress === 'function' ? onProgress : () => {};
    const ver = this._cdnVersion || EXCAL_UMD_VERSION;
    this._ensureExcalStylesheet(ver);

    const cdnSets = [
      {
        label: 'unpkg',
        react: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
        reactDom: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
        excal: `https://unpkg.com/@excalidraw/excalidraw@${ver}/dist/excalidraw.production.min.js`,
      },
      {
        label: 'jsDelivr',
        react: 'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
        reactDom: 'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
        excal: `https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${ver}/dist/excalidraw.production.min.js`,
      },
    ];

    let lastErr = null;
    for (const cdn of cdnSets) {
      try {
        prog(`Loading React (${cdn.label})…`);
        await this._loadClassicScript(cdn.react, 15000);
        prog(`Loading ReactDOM (${cdn.label})…`);
        await this._loadClassicScript(cdn.reactDom, 15000);
        prog(`Loading Excalidraw (${cdn.label})…`);
        await this._loadClassicScript(cdn.excal, 25000);

        const React = globalThis.React;
        const ReactDOM = globalThis.ReactDOM;
        const lib = globalThis.ExcalidrawLib;
        const Excalidraw = lib?.Excalidraw || lib?.default?.Excalidraw;
        const createRoot = ReactDOM?.createRoot;
        if (!React || !createRoot || !Excalidraw) {
          throw new Error(`UMD globals missing after ${cdn.label} load`);
        }
        return { mode: 'react', React, createRoot, Excalidraw, lib };
      } catch (e) {
        lastErr = e;
        console.warn(`[${EXCAL_PLUGIN_NAME}] UMD ${cdn.label} failed`, e);
      }
    }

    console.warn(`[${EXCAL_PLUGIN_NAME}] UMD failed, using excalidraw.com iframe`, lastErr);
    prog('Opening excalidraw.com embed…');
    return { mode: 'iframe' };
  }

  async _loadDrawingDoc(recordGuid) {
    let fromCollection = null;
    try {
      const drawingsColl = await this._ensureDrawingsCollection();
      if (drawingsColl) {
        const drawingRecord = await this._findDrawingRecordBySourceGuid(
          drawingsColl,
          recordGuid,
          this._panelSession?.recordName,
        );
        if (drawingRecord) {
          fromCollection = this._docFromDrawingRecord(drawingRecord);
          const session = this._panelSession;
          if (session && session.recordGuid === recordGuid) {
            session.drawingRecordGuid = drawingRecord.guid;
          }
        }
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] load collection scene`, e);
    }

    let fromRow = null;
    try {
      const row = await this._findLegacyDrawingRow(recordGuid);
      if (row) fromRow = this._parseLegacyDrawingDoc(row);
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] load legacy row`, e);
    }

    let fromLocal = null;
    try {
      const raw = localStorage.getItem(this._localDrawKey(recordGuid));
      if (raw && String(raw).trim()) fromLocal = JSON.parse(raw);
    } catch (_) {}

    return this._pickNewerDoc(fromCollection, this._pickNewerDoc(fromRow, fromLocal));
  }

  _parseLegacyDrawingDoc(row) {
    try {
      const raw = row.text?.('settings_json') || globalThis.ThymerPluginSettings?.rowField?.(row, 'settings_json') || '';
      if (!raw || !String(raw).trim()) return null;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && (parsed.sceneJson || parsed.scene || parsed.shareHash)) return parsed;
      if (parsed && parsed.elements) return { v: 1, updatedAt: new Date().toISOString(), scene: parsed };
      return parsed;
    } catch (_) {
      return null;
    }
  }

  async _findLegacyDrawingRow(recordGuid) {
    const rowId = `${EXCAL_PLUGIN_SLUG}:draw:${recordGuid}`;
    const PS = globalThis.ThymerPluginSettings;
    if (!PS?.listRows) return null;

    let rows = [];
    try {
      rows = await PS.listRows(this.data, { pluginSlug: EXCAL_PLUGIN_SLUG, recordKind: 'drawing' });
    } catch (_) {
      return null;
    }

    for (const row of rows) {
      const pid = PS.rowField?.(row, 'plugin_id') || '';
      if (pid === rowId) return row;
    }
    return null;
  }

  async _saveDrawingDoc(recordGuid, recordName, scene) {
    const doc = {
      v: 3,
      sourceRecordGuid: recordGuid,
      updatedAt: new Date().toISOString(),
      scene,
    };

    const drawingsColl = await this._ensureDrawingsCollection();
    if (!drawingsColl) {
      throw new Error(`${EXCAL_DRAWINGS_COLL_NAME} collection is not available`);
    }

    const drawingsCollGuid = this._getCollectionGuid(drawingsColl);
    const sourceRecord = await this._resolveSourceRecord(recordGuid);
    let sourceColl = this._panelSession?.sourceColl || null;
    if (!sourceColl && sourceRecord) {
      try {
        sourceColl = sourceRecord.getCollection?.() || null;
      } catch (_) {}
    }
    if (!sourceColl) {
      const panel = this.ui.getActivePanel?.();
      sourceColl = panel?.getActiveCollection?.() || null;
    }

    if (sourceColl && drawingsCollGuid) {
      await this._ensureExcalidrawingFieldOnCollection(sourceColl, drawingsCollGuid);
    }

    let drawingRecord = null;
    if (this._panelSession?.drawingRecordGuid && this._panelSession.recordGuid === recordGuid) {
      try {
        const all = await drawingsColl.getAllRecords();
        drawingRecord = (all || []).find((x) => x.guid === this._panelSession.drawingRecordGuid) || null;
      } catch (_) {}
    }
    if (!drawingRecord) {
      drawingRecord = await this._findDrawingRecordBySourceGuid(drawingsColl, recordGuid, recordName);
    }
    const title = this._drawingTitleForNote(recordName);

    if (!drawingRecord) {
      let newGuid = null;
      try {
        newGuid = drawingsColl.createRecord?.(title);
      } catch (e) {
        console.error(`[${EXCAL_PLUGIN_NAME}] createRecord`, e);
      }
      if (!newGuid) throw new Error('Could not create drawing record');
      drawingRecord = await this._waitForRecord(newGuid, drawingsColl);
      if (!drawingRecord) throw new Error('Drawing record not ready after creation');
      this._drawingRecordCache.set(recordGuid, drawingRecord);
    } else {
      try {
        drawingRecord.setName?.(title);
      } catch (_) {}
    }

    const session = this._panelSession;
    if (session && session.recordGuid === recordGuid) {
      session.drawingRecordGuid = drawingRecord.guid;
    }

    this._drawingRecordCache.set(recordGuid, drawingRecord);

    const sceneJson = JSON.stringify(doc);
    // v0.5.9: write the localStorage mirror BEFORE the awaited DB
    // write. The DB write is async and may not complete if the
    // page unloads (pagehide / beforeunload). The localStorage
    // write is sync — once it lands, even a mid-save page close
    // leaves the mirror updated, and _loadDrawingDoc's
    // _pickNewerDoc merge prefers the newer mirror on reload.
    try {
      localStorage.setItem(this._localDrawKey(recordGuid), sceneJson);
    } catch (_) {}
    try {
      const sceneProp = drawingRecord.prop?.(EXCAL_FIELD_SCENE);
      if (sceneProp?.set) {
        // v0.5.6: await the DB write. Without this, _flushPanelSession
        // resolves before Thymer persists the new value, and a quick
        // hard-refresh sees the previous scene. The prop setter returns
        // a promise in current Thymer versions.
        const r = sceneProp.set(sceneJson);
        if (r && typeof r.then === 'function') await r;
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] scene set`, e);
      throw e;
    }

    if (sourceRecord) {
      try {
        const srcNoteProp = drawingRecord.prop?.(EXCAL_FIELD_SOURCE_NOTE);
        if (srcNoteProp) this._linkRecordProperty(srcNoteProp, recordGuid, EXCAL_FIELD_SOURCE_NOTE, drawingRecord);
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] source_note link`, e);
      }

      try {
        const excProp = sourceRecord.prop?.(EXCAL_SOURCE_FIELD_ID);
        if (excProp) {
          this._linkRecordProperty(excProp, drawingRecord.guid, EXCAL_SOURCE_FIELD_ID, sourceRecord);
        }
      } catch (e) {
        console.warn(`[${EXCAL_PLUGIN_NAME}] excalidrawing link`, e);
      }
    }

    try {
      localStorage.setItem(this._localDrawKey(recordGuid), JSON.stringify(doc));
    } catch (_) {}
  }

  _setupRealtimeListeners(session) {
    if (!this.ws?.onMessage || !this.events?.on) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] realtime disabled: ws or events API unavailable`);
      return;
    }
    if (session.reloadEventId) return;
    console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: plugin GUID=${this.getGuid()}, recordGuid=${session.recordGuid}`);

    session.lastBroadcastElements = new Map();
    try {
      const initialElements = session.excalApi?.getSceneElements();
      if (initialElements) {
        for (const el of initialElements) {
          session.lastBroadcastElements.set(el.id, _cloneElementSnapshot(el));
        }
      }
    } catch (_) {}

    session.wsUnsub = this.ws.onMessage((msg) => {
      this._handleIncomingWsMessage(session, msg);
    });

    session.recordUpdateEventId = this.events.on(
      'record.updated',
      (event) => { this._handleRemoteRecordUpdated(session, event); },
      { collection: '*' },
    );

    session.reloadEventId = this.events.on('reload', () => {
      this._handleReload(session);
    });

    console.log(`[${EXCAL_PLUGIN_NAME}] realtime listeners attached for drawing ${session.recordGuid}`);
    if (typeof window !== 'undefined') {
      window.__excalDebug = window.__excalDebug || {};
      window.__excalDebug[EXCAL_PLUGIN_NAME] = {
        getPluginGuid: () => this.getGuid(),
        getSessionInfo: () => ({
          recordGuid: session.recordGuid,
          elementCount: session.excalApi?.getSceneElements()?.length,
          wsAvailable: !!this.ws?.broadcast,
        }),
        injectWsMessage: (fakeMsg) => {
          this._handleIncomingWsMessage(session, fakeMsg);
        },
      };
    }
  }

  _teardownRealtimeListeners(session) {
    if (!session) return;
    try { session.wsUnsub?.(); } catch (_) {}
    if (session.recordUpdateEventId) {
      try { this.events?.off?.(session.recordUpdateEventId); } catch (_) {}
    }
    if (session.reloadEventId) {
      try { this.events?.off?.(session.reloadEventId); } catch (_) {}
    }
    if (session.wsThrottleTimer) {
      clearTimeout(session.wsThrottleTimer);
    }
    if (session._contextMenuGuardDispose) {
      try { session._contextMenuGuardDispose(); } catch (_) {}
    }
    session.wsUnsub = null;
    session.recordUpdateEventId = null;
    session.reloadEventId = null;
    session.lastBroadcastElements = null;
    session.wsThrottleTimer = null;
    session.wsPendingBroadcast = false;
    session.applyingRemoteUpdate = false;
  }

  _scheduleWsBroadcast(session, elements) {
    if (!session.lastBroadcastElements) {
      session.lastBroadcastElements = new Map();
      for (const el of elements) {
        // Clone so subsequent in-place mutations by Excalidraw don't
        // silently update our delta-detection snapshot.
        session.lastBroadcastElements.set(el.id, { ...el, points: Array.isArray(el.points) ? el.points.slice() : el.points });
      }
      this._broadcastElementDelta(session, elements);
      return;
    }
    if (session.wsThrottleTimer) {
      session.wsPendingBroadcast = true;
      return;
    }
    this._broadcastElementDelta(session, elements);
    session.wsThrottleTimer = setTimeout(() => {
      session.wsThrottleTimer = null;
      // Always broadcast in the throttle callback so the final state after the
      // user finishes drawing is delivered. _broadcastElementDelta will skip
      // the WS send if the delta is empty.
      if (session.excalApi) {
        try {
          this._broadcastElementDelta(session, session.excalApi.getSceneElements());
        } catch (e) {
          console.warn(`[${EXCAL_PLUGIN_NAME}] throttle-broadcast`, e);
        }
      }
    }, EXCAL_WS_THROTTLE_MS);
  }

  _broadcastElementDelta(session, currentElements) {
    if (!this.ws?.broadcast) { console.warn(`[${EXCAL_PLUGIN_NAME}] ws.broadcast unavailable — delta dropped`); return; }
    const prev = session.lastBroadcastElements;
    const delta = [];
    const deletedIds = [];
    const currentIds = new Set();
    let degenerateSkipped = 0;

    for (const el of currentElements) {
      currentIds.add(el.id);
      const prevEl = prev.get(el.id);
      if (!prevEl || prevEl.version !== el.version || prevEl.versionNonce !== el.versionNonce) {
        if (isDegenerateElement(el)) { degenerateSkipped++; continue; }
        delta.push(el);
      }
    }

    for (const [id, prevEl] of prev) {
      if (!currentIds.has(id) && !prevEl.isDeleted) {
        deletedIds.push(id);
      }
    }

    for (const el of delta) {
      // Store a CLONE so the snapshot we keep for delta-detection isn't
      // mutated in place by Excalidraw between broadcasts. Otherwise
      // every subsequent broadcast sees prevEl.version === el.version
      // (the same object) and emits an empty delta.
      prev.set(el.id, _cloneElementSnapshot(el));
    }
    for (const id of deletedIds) {
      prev.delete(id);
    }

    if (delta.length === 0 && deletedIds.length === 0) {
      if (degenerateSkipped > 0) {
        console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG: skipped ${degenerateSkipped} degenerate (in-progress) element(s)`);
      }
      return;
    }
    try {
      for (const el of delta) {
        const pts = el?.points;
        const firstPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[0]) : 'n/a';
        const lastPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[pts.length - 1]) : 'n/a';
        console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG BROADCAST: id=${el?.id} type=${el?.type} pointsLen=${Array.isArray(pts) ? pts.length : 'n/a'} firstPt=${firstPt} lastPt=${lastPt} version=${el?.version} vNonce=${el?.versionNonce}`);
      }
    } catch (e) { /* DIAG only */ }
    console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG: broadcasting ${delta.length} changed, ${deletedIds.length} deleted, ${degenerateSkipped} degenerate-skipped`);

    this.ws.broadcast({
      type: EXCAL_WS_MSG_TYPE,
      data: {
        senderId: session.senderId,
        drawingGuid: session.recordGuid,
        elements: delta,
        deletedIds,
        // v0.5.6 bug 7: include the full scene order so receivers can
        // re-layer elements (Excalidraw uses array order for z-order).
        // The delta alone doesn't carry order information — without this,
        // a layer-order change on tab B doesn't sync to tab A.
        sceneOrder: currentElements.map((e) => e.id),
      },
    });
  }

  _handleIncomingWsMessage(session, msg) {
    if (!session?.excalApi) return;
    if (msg.type !== EXCAL_WS_MSG_TYPE) return;
    const data = msg.data;
    if (!data) {
      console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: WS msg missing data field (msg keys: ${Object.keys(msg || {}).join(',')})`);
      return;
    }
    console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG: WS recv type=${msg?.type} fromPG=${msg?.fromPluginGuid} myG=${this.getGuid()} senderId=${data.senderId} mySender=${session.senderId} match=${data.senderId === session.senderId} drawing=${data.drawingGuid} sessionR=${session?.recordGuid}`);
    if (data.senderId && data.senderId === session.senderId) {
      console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG: WS self-msg filtered out (senderId matches my session)`);
      return;
    }
    if (data.drawingGuid !== session.recordGuid) return;
    if (!data.elements?.length && !data.deletedIds?.length) {
      console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: WS msg passed filters but empty content`);
      return;
    }
    console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: applying remote ${data.elements?.length} els, ${data.deletedIds?.length} deleted`);
    const firstEl = data.elements?.[0];
    if (firstEl) {
      const approxBytes = JSON.stringify(firstEl).length;
      console.log(`[${EXCAL_PLUGIN_NAME}] DIAG: first el type=${firstEl.type} pointsLen=${firstEl.points?.length ?? 'n/a'} bytes=${approxBytes}`);
    }

    try {
      let incomingElements = data.elements || [];
      try {
        for (const el of incomingElements) {
          const pts = el?.points;
          const firstPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[0]) : 'n/a';
          const lastPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[pts.length - 1]) : 'n/a';
          console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG RECV pre-restore: id=${el?.id} type=${el?.type} pointsLen=${Array.isArray(pts) ? pts.length : 'n/a'} firstPt=${firstPt} lastPt=${lastPt} version=${el?.version} vNonce=${el?.versionNonce}`);
        }
      } catch (_) { /* DIAG only */ }
      if (incomingElements.length && session.excalLib?.restoreElements) {
        try {
          const restored = session.excalLib.restoreElements(incomingElements, null);
          if (Array.isArray(restored) && restored.length) {
            incomingElements = restored;
          }
        } catch (e) {
          console.warn(`[${EXCAL_PLUGIN_NAME}] restoreElements failed — using raw`, e);
        }
      }
      try {
        for (const el of incomingElements) {
          const pts = el?.points;
          const firstPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[0]) : 'n/a';
          const lastPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[pts.length - 1]) : 'n/a';
          console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG RECV post-restore: id=${el?.id} type=${el?.type} pointsLen=${Array.isArray(pts) ? pts.length : 'n/a'} firstPt=${firstPt} lastPt=${lastPt} version=${el?.version} vNonce=${el?.versionNonce}`);
        }
      } catch (_) { /* DIAG only */ }
      const localElements = session.excalApi.getSceneElements();
      const merged = this._mergeSceneElements(localElements, incomingElements, data.deletedIds || []);
      // v0.5.6 bug 7: apply the sender's scene order so layer-order
      // changes (z-order in Excalidraw is the array order) propagate.
      // Only apply if the sender's data is newer — measured by whether
      // any incoming element has a higher version than its local
      // counterpart, or by whether the sender's order differs at all
      // and includes newer elements.
      let ordered = merged;
      if (Array.isArray(data.sceneOrder) && data.sceneOrder.length) {
        const mergedMap = new Map(merged.map((e) => [e.id, e]));
        const localMap = new Map(localElements.map((e) => [e.id, e]));
        // Has the sender's order actually changed relative to local?
        const localOrder = localElements.map((e) => e.id);
        const orderChanged = data.sceneOrder.length !== localOrder.length ||
          data.sceneOrder.some((id, i) => id !== localOrder[i]);
        // Is the sender's data newer than local for at least one element?
        const senderNewer = incomingElements.some((inc) => {
          const loc = localMap.get(inc.id);
          return !loc || inc.version > loc.version ||
            (inc.version === loc.version && inc.versionNonce !== loc.versionNonce);
        });
        if (orderChanged && senderNewer) {
          // Build the new array in sender's order, then append any
          // elements local has that the sender's order didn't list
          // (shouldn't happen for normal scenes, but be defensive).
          const seen = new Set();
          ordered = [];
          for (const id of data.sceneOrder) {
            const el = mergedMap.get(id);
            if (el) { ordered.push(el); seen.add(id); }
          }
          for (const el of merged) {
            if (!seen.has(el.id)) ordered.push(el);
          }
        }
      }
      const lb = session.lastBroadcastElements;

      session.applyingRemoteUpdate = true;
      session.lastRemoteApplyMs = Date.now();
      try {
        for (const el of ordered) {
          const pts = el?.points;
          const firstPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[0]) : 'n/a';
          const lastPt = Array.isArray(pts) && pts.length ? JSON.stringify(pts[pts.length - 1]) : 'n/a';
          console.log(`[${EXCAL_PLUGIN_NAME}] [${session._instanceTag || session.senderId}] DIAG updateScene (WS): id=${el?.id} type=${el?.type} pointsLen=${Array.isArray(pts) ? pts.length : 'n/a'} firstPt=${firstPt} lastPt=${lastPt} isDeleted=${!!el?.isDeleted}`);
        }
      } catch (_) { /* DIAG only */ }
      session.excalApi.updateScene({ elements: ordered });

      session.applyingRemoteUpdate = false;

      if (lb) {
        lb.clear();
        const actualScene = session.excalApi.getSceneElements();
        for (const el of actualScene) {
          // v0.5.6: clone before storing (same trap as bug 3, on the WS-receive
          // re-seed path). Without this, the snapshot follows Excalidraw's
          // in-place mutations and the next local onChange emits an empty
          // delta, so a move on tab B never reaches tab A.
          lb.set(el.id, _cloneElementSnapshot(el));
        }
        for (const id of data.deletedIds || []) {
          lb.delete(id);
        }
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] ws handle`, e);
    }
  }

  _mergeSceneElements(localElements, incomingElements, deletedIds) {
    const map = new Map();
    for (const el of localElements) {
      map.set(el.id, el);
    }
    for (const el of incomingElements) {
      const local = map.get(el.id);
      if (!local) {
        map.set(el.id, el);
      } else if (el.version > local.version) {
        map.set(el.id, el);
      } else if (el.version === local.version && el.versionNonce !== local.versionNonce) {
        map.set(el.id, el);
      }
    }
    for (const id of deletedIds) {
      const local = map.get(id);
      if (local && !local.isDeleted) {
        map.set(id, { ...local, isDeleted: true });
      }
    }
    return Array.from(map.values());
  }

  async _handleRemoteRecordUpdated(session, event) {
    if (!session?.drawingRecordGuid) return;
    if (event.source?.isLocal) return;
    if (event.recordGuid !== session.drawingRecordGuid) return;
    if (!session.excalApi) return;

    try {
      const record = this.data.getRecord(event.recordGuid);
      if (!record) return;
      const sceneText = record.text(EXCAL_FIELD_SCENE);
      if (!sceneText) return;
      const parsed = JSON.parse(sceneText);
      const restored = session.excalLib?.restore
        ? session.excalLib.restore(parsed, null, null)
        : parsed;
      const savedElements = restored?.elements || parsed?.elements || [];
      if (!savedElements.length) return;

      const localElements = session.excalApi.getSceneElements();
      const merged = this._mergeSceneElements(localElements, savedElements, []);

      session.applyingRemoteUpdate = true;
      session.lastRemoteApplyMs = Date.now();
      session.excalApi.updateScene({ elements: merged });
      session.applyingRemoteUpdate = false;
      const lb = session.lastBroadcastElements;
      if (lb) {
        lb.clear();
        const actualScene = session.excalApi.getSceneElements();
        for (const el of actualScene) {
          lb.set(el.id, _cloneElementSnapshot(el));
        }
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] record update reconcil`, e);
    }
  }

  async _handleReload(session) {
    if (!session?.drawingRecordGuid || !session.excalApi) return;
    try {
      const drawingsColl = await this._ensureDrawingsCollection();
      if (!drawingsColl) return;
      const all = await drawingsColl.getAllRecords();
      const record = (all || []).find((r) => r.guid === session.drawingRecordGuid);
      if (!record) return;
      const sceneText = record.text(EXCAL_FIELD_SCENE);
      if (!sceneText) return;
      const parsed = JSON.parse(sceneText);
      const restored = session.excalLib?.restore
        ? session.excalLib.restore(parsed, null, null)
        : parsed;
      const savedElements = restored?.elements || parsed?.elements || [];
      if (!savedElements.length) return;

      const localElements = session.excalApi.getSceneElements();
      const merged = this._mergeSceneElements(localElements, savedElements, []);

      session.applyingRemoteUpdate = true;
      session.lastRemoteApplyMs = Date.now();
      session.excalApi.updateScene({ elements: merged });
      session.applyingRemoteUpdate = false;

      if (session.lastBroadcastElements) {
        session.lastBroadcastElements.clear();
        const actualScene = session.excalApi.getSceneElements();
        for (const el of actualScene) {
          session.lastBroadcastElements.set(el.id, _cloneElementSnapshot(el));
        }
      }
    } catch (e) {
      console.warn(`[${EXCAL_PLUGIN_NAME}] reload reconcil`, e);
    }
  }

  async _flushPanelSession(force) {
    const session = this._panelSession;
    if (!session?.recordGuid) return;
    if (!session.dirty && !force) return;
    if (!session.pendingScene && !force) return;
    if (session.saveInFlight) return;

    session.saveInFlight = true;
    this._setPanelStatus(session, 'Saving…');
    try {
      if (session.pendingScene) {
        await this._saveDrawingDoc(session.recordGuid, session.recordName, session.pendingScene);
        session.dirty = false;
        this._setPanelStatus(session, 'Changes saved');
      }
    } catch (e) {
      console.error(`[${EXCAL_PLUGIN_NAME}] save`, e);
      this._setPanelStatus(session, 'Save failed');
    } finally {
      session.saveInFlight = false;
    }
  }
}
