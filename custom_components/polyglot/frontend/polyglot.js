// Polyglot runtime overlay. Loaded on every page by the integration (frontend extra module).
//
// For a user whose profile language has a dictionary, it replaces area, floor, device and entity names in the
// frontend's `hass` object before any panel sees it, and translates visible strings of dashboard configs. Nothing
// is written back to Home Assistant. Settings screens always show the original names, so a translated name can
// never be saved by accident.
//
// It relies on two frontend internals: the `home-assistant` element's `_updateHass(partial)` method and the
// `lovelace/config` WebSocket call. If either is missing it logs a warning and does nothing.
// core.js gets this module's ?v= query too, so a new release never runs against a cached old core.
const { createTranslator, mapRecord, pickLanguage, restoreConfig, strategyCount, translateConfig, untranslateConfig } = await import(
  new URL(`./core.js${new URL(import.meta.url).search}`, import.meta.url).href
);

const TAG = '[polyglot]';
const REGISTRY_KEYS = ['states', 'entities', 'devices', 'areas', 'floors', 'panels'];
// hass.format* functions whose output is a displayed state value.
const FORMATTERS = {
  formatEntityState: 'text',
  formatEntityAttributeValue: 'text',
  formatEntityStateToParts: 'parts',
  formatEntityAttributeValueToParts: 'parts',
};
const KEYS = [...REGISTRY_KEYS, ...Object.keys(FORMATTERS)];
// Pages that edit names or show raw data: always untranslated.
const RAW_PATHS = /^\/(config|developer-tools|polyglot|hassio|profile)(\/|$)/;

const waitFor = (fn, interval = 100, timeout = 60000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let value;
      try { value = fn(); } catch (e) { value = null; }
      if (value) resolve(value);
      else if (Date.now() - start > timeout) reject(new Error('timeout'));
      else setTimeout(tick, interval);
    };
    tick();
  });

// Depth-first search through shadow roots for the first element with this tag.
const deepFind = (root, tag) => {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.tagName && node.tagName.toLowerCase() === tag) return node;
    if (node.shadowRoot) stack.push(node.shadowRoot);
    for (const child of node.children || []) stack.push(child);
  }
  return null;
};

async function main() {
  const el = await waitFor(() => {
    const e = document.querySelector('home-assistant');
    const h = e && e.hass;
    return h && h.connection && h.states && h.entities && h.devices && h.areas ? e : null;
  });
  if (el.__polyglot) return;
  el.__polyglot = true;
  if (typeof el._updateHass !== 'function') {
    console.warn(TAG, 'frontend internals changed (_updateHass missing), names stay untranslated');
    return;
  }

  const conn = el.hass.connection;
  const original = el._updateHass.bind(el);
  const raw = {};
  for (const k of KEYS) raw[k] = el.hass[k];

  let translator = createTranslator({});
  let currentDict = {};
  let dictSig; // language and dictionary in use, to ignore changes to other languages
  let textSig = null; // language and its dashboard text entries
  let language = null; // dictionary language in use, null = original names
  let subscribedFor; // user language the subscription was made for
  let unsubscribe = null;
  let broken = false;
  const memo = {}; // key -> { src, deps, out }

  const active = () => !broken && translator.has && !RAW_PATHS.test(location.pathname);
  const isAdmin = () => Boolean(el.hass && el.hass.user && el.hass.user.is_admin);

  const memoize = (key, deps, fn) => {
    const m = memo[key];
    if (m && m.src === raw[key] && m.deps.length === deps.length && m.deps.every((d, i) => d === deps[i])) return m.out;
    const out = fn(raw[key]);
    memo[key] = { src: raw[key], deps, out };
    return out;
  };

  // Wrapped formatters read the current translator on every call, so one wrapper per raw function is enough.
  const wrappers = new WeakMap();
  const wrapFormatter = (name) => {
    const fn = raw[name];
    if (typeof fn !== 'function') return fn;
    if (!wrappers.has(fn)) {
      const kind = FORMATTERS[name];
      wrappers.set(fn, (...args) => {
        const out = fn(...args);
        if (!active()) return out;
        return kind === 'parts' ? translator.stateParts(out) : translator.stateText(out);
      });
    }
    return wrappers.get(fn);
  };

  // Translated versions of all overlay keys (or the raw ones when inactive).
  const translated = () => {
    if (!active()) return { ...raw };
    const tr = translator;
    const formatters = {};
    for (const name of Object.keys(FORMATTERS)) formatters[name] = wrapFormatter(name);
    return {
      ...formatters,
      areas: memoize('areas', [tr], (r) => mapRecord(r, tr.area)),
      floors: memoize('floors', [tr], (r) => mapRecord(r, tr.floor)),
      devices: memoize('devices', [tr], (r) => mapRecord(r, tr.device)),
      entities: memoize('entities', [tr], (r) => mapRecord(r, tr.entity)),
      // friendly_name depends on the raw registries, not the translated ones.
      states: memoize('states', [tr, raw.entities, raw.devices], (r) => mapRecord(r, (s) => tr.state(s, raw.entities, raw.devices))),
      panels: memoize('panels', [tr], (r) => mapRecord(r, (p) => {
        const title = p && p.title ? tr.text(p.title) : undefined;
        return title && title !== p.title ? { ...p, title } : p;
      })),
    };
  };

  let lastActive = false;
  const refresh = () => {
    lastActive = active();
    original(translated());
    reloadDashboard();
  };

  el._updateHass = (obj) => {
    if (broken || !obj) return original(obj);
    try {
      let touched = false;
      for (const k of KEYS) {
        if (k in obj && obj[k]) {
          raw[k] = obj[k];
          touched = true;
        }
      }
      const out = touched ? { ...obj, ...pick(translated(), obj) } : obj;
      const result = original(out);
      if ('language' in obj || 'user' in obj) queueMicrotask(subscribe);
      return result;
    } catch (e) {
      broken = true;
      console.warn(TAG, 'disabled after an error, names stay untranslated', e);
      return original({ ...obj, ...raw });
    }
  };
  // When registries change, states must be re-derived too, since friendly_name depends on them.
  const pick = (all, obj) => {
    const out = {};
    for (const k of KEYS) if (k in obj || (k === 'states' && ('entities' in obj || 'devices' in obj))) out[k] = all[k];
    return out;
  };

  // Per-user setting, kept in the user's own frontend data: admins may opt in to translated dashboard text.
  let userSettings = {};
  const dashboardTextFor = () => !isAdmin() || Boolean(userSettings.dashboard_text_for_admin);
  conn.subscribeMessage(
    (ev) => {
      const next = (ev && ev.value) || {};
      const changed = Boolean(next.dashboard_text_for_admin) !== Boolean(userSettings.dashboard_text_for_admin);
      userSettings = next;
      if (changed && isAdmin()) reloadDashboard(true);
    },
    { type: 'frontend/subscribe_user_data', key: 'polyglot' },
  ).catch((e) => console.warn(TAG, 'user settings unavailable', e));

  // Dashboard text: for users who cannot edit dashboards, and admins who opted in. Their saves are run through
  // untranslateConfig, so text shown translated goes back to the original before it is stored. Someone who sees
  // the original text gets it saved exactly as typed.
  //
  // Generated dashboards (strategies, or no stored config at all) are built in the browser from the translated
  // names. "Take control" saves that result as a normal config, so on such a save the translated area, floor,
  // device and entity names in it are turned back into the original ones as well.
  const generated = new Map(); // dashboard url_path -> generated parts in its config as last fetched or saved
  const pathOf = (msg) => msg.url_path ?? null;
  // [[translated, original]] for every name that is shown translated right now.
  const namePairs = () => {
    const pairs = [];
    if (!active()) return pairs;
    const shown = translated();
    const add = (a, b) => { if (a && b && a !== b) pairs.push([a, b]); };
    const each = (key, fn) => {
      const from = raw[key] || {};
      const to = shown[key] || {};
      for (const id of Object.keys(to)) if (to[id] !== from[id] && from[id]) fn(to[id], from[id]);
    };
    each('areas', (t, o) => add(t.name, o.name));
    each('floors', (t, o) => add(t.name, o.name));
    each('devices', (t, o) => add(t.name_by_user, o.name_by_user || o.name));
    each('states', (t, o) => add(t.attributes && t.attributes.friendly_name, o.attributes && o.attributes.friendly_name));
    return pairs;
  };
  const sendMessagePromise = conn.sendMessagePromise.bind(conn);
  conn.sendMessagePromise = (msg) => {
    if (msg && msg.type === 'lovelace/config/save' && msg.config && !broken) {
      try {
        let config = msg.config;
        if (translator.has && dashboardTextFor()) config = untranslateConfig(config, currentDict);
        const parts = strategyCount(msg.config);
        if (parts < (generated.get(pathOf(msg)) || 0)) config = restoreConfig(config, namePairs());
        generated.set(pathOf(msg), parts);
        if (config !== msg.config) msg = { ...msg, config };
      } catch (e) {
        console.warn(TAG, 'could not restore original dashboard text before saving', e);
      }
    }
    const p = sendMessagePromise(msg);
    if (!msg || msg.type !== 'lovelace/config') return p;
    return p.then(
      (config) => {
        try {
          generated.set(pathOf(msg), strategyCount(config));
          return active() && dashboardTextFor() ? translateConfig(config, translator.text) : config;
        } catch (e) {
          console.warn(TAG, 'dashboard translation failed', e);
          return config;
        }
      },
      (err) => {
        // No stored config: the frontend generates the whole dashboard.
        if (err && err.code === 'config_not_found') generated.set(pathOf(msg), 1);
        throw err;
      },
    );
  };

  // Templates rendered for cards (Markdown, Mushroom and others) get a `language` variable with the viewer's
  // profile language, so a template can write {% if language == 'ru' %}…{% else %}…{% endif %}.
  // The variable is fixed when a card subscribes, so open template subscriptions are tracked and re-made with the
  // new language when the user changes it (on this device or another one).
  const subscribeMessage = conn.subscribeMessage.bind(conn);
  const templateSubs = new Set();
  const currentLanguage = () => (el.hass ? el.hass.language : undefined);
  const withLanguage = (msg, language) => ({ ...msg, variables: { ...(msg.variables || {}), language } });
  conn.subscribeMessage = (callback, msg, options) => {
    if (!msg || msg.type !== 'render_template' || broken) return subscribeMessage(callback, msg, options);
    const sub = { callback, msg, options, language: currentLanguage(), unsub: null, closed: false };
    templateSubs.add(sub);
    return subscribeMessage(callback, withLanguage(msg, sub.language), options).then(
      (unsub) => {
        sub.unsub = unsub;
        // The card keeps this function; it always closes whichever subscription is current.
        return async () => {
          sub.closed = true;
          templateSubs.delete(sub);
          const u = sub.unsub;
          sub.unsub = null;
          if (u) await u();
        };
      },
      (err) => {
        templateSubs.delete(sub);
        throw err;
      },
    );
  };
  const resubscribeTemplates = async () => {
    const language = currentLanguage();
    for (const sub of [...templateSubs]) {
      if (sub.closed || sub.language === language || !sub.unsub) continue;
      const old = sub.unsub;
      sub.unsub = null;
      sub.language = language;
      try { await old(); } catch (e) { /* already gone */ }
      if (sub.closed) continue;
      try {
        const unsub = await subscribeMessage(sub.callback, withLanguage(sub.msg, language), sub.options);
        if (sub.closed) await unsub();
        else sub.unsub = unsub;
      } catch (e) {
        console.warn(TAG, 'template resubscribe failed', e);
      }
    }
  };

  let dashboardSig = null; // dashboard text the open dashboard was last fetched for, null = original text
  // A dashboard that was already there when this module started has cards whose templates subscribed without the
  // `language` variable. It gets one reload, and only if its config mentions `language` at all: a reload redraws
  // the whole dashboard, which nobody should see on every page load for nothing.
  const startedLate = Boolean(deepFind(el, 'ha-panel-lovelace'));
  let templatesChecked = false;
  const mentionsLanguage = (panel) => {
    try {
      const config = panel && panel.lovelace && (panel.lovelace.rawConfig || panel.lovelace.config);
      return Boolean(config) && JSON.stringify(config).includes('language');
    } catch (e) {
      return false;
    }
  };
  // The first dashboard config is usually fetched before this module loads. Re-fetch it once the dashboard text
  // for this user is known, and again only when that text changes: names reach the cards through `hass`, so
  // saving an entity's translation does not make every open dashboard fetch its config again.
  const reloadDashboard = (force = false) => {
    const sig = language && dashboardTextFor() ? textSig : null;
    let needed = force || sig !== dashboardSig;
    dashboardSig = sig;
    let panel;
    if (!templatesChecked) {
      templatesChecked = true;
      if (!needed && startedLate) {
        panel = deepFind(el, 'ha-panel-lovelace');
        needed = mentionsLanguage(panel);
      }
    }
    if (!needed) return;
    panel = panel || deepFind(el, 'ha-panel-lovelace');
    if (!panel || typeof panel._fetchConfig !== 'function') return;
    // Never under someone editing the dashboard: the next time it is opened it is fetched anyway.
    if (panel.lovelace && panel.lovelace.editMode) return;
    panel._fetchConfig(false);
  };

  async function subscribe() {
    const userLanguage = el.hass && el.hass.language;
    if (userLanguage === subscribedFor) return;
    const changed = subscribedFor !== undefined;
    subscribedFor = userLanguage;
    if (changed) resubscribeTemplates();
    if (unsubscribe) {
      const u = unsubscribe;
      unsubscribe = null;
      try { await u(); } catch (e) { /* connection gone */ }
    }
    try {
      unsubscribe = await conn.subscribeMessage(
        (event) => {
          const lang = pickLanguage(userLanguage, event.primary, event.languages || []);
          const dict = lang && event.translations ? event.translations[lang] || {} : {};
          // Every change to any language arrives here: do nothing unless this user's dictionary changed.
          const sig = lang ? `${lang}\n${JSON.stringify(dict)}` : '';
          if (sig === dictSig) return;
          dictSig = sig;
          const texts = Object.entries(dict).filter(([k]) => k.startsWith('text:'));
          textSig = lang && texts.length ? `${lang}\n${JSON.stringify(texts)}` : null;
          language = lang;
          currentDict = dict;
          translator = createTranslator(dict);
          refresh();
        },
        { type: 'polyglot/subscribe', language: userLanguage },
        { resubscribe: true },
      );
    } catch (e) {
      console.warn(TAG, 'subscription failed (integration not loaded?)', e);
    }
  }

  // Settings dialogs opened from translated pages (more-info → entity settings → device, area dialogs) get their
  // device, area or floor object from the translated registries and would pre-fill and save the translated name.
  // Swap those objects for the original ones before the dialog reads them.
  const toRaw = (v) => {
    if (!v || typeof v !== 'object' || v.entity_id) return v;
    if (v.id && raw.devices && raw.devices[v.id]) return raw.devices[v.id];
    if (v.area_id && !v.id && raw.areas && raw.areas[v.area_id]) return raw.areas[v.area_id];
    if (v.floor_id && !v.area_id && raw.floors && raw.floors[v.floor_id]) return raw.floors[v.floor_id];
    return v;
  };
  window.addEventListener('show-dialog', (ev) => {
    const params = ev.detail && ev.detail.dialogParams;
    if (!params || typeof params !== 'object' || broken) return;
    try {
      for (const k of Object.keys(params)) {
        const r = toRaw(params[k]);
        if (r !== params[k]) params[k] = r;
      }
    } catch (e) {
      console.warn(TAG, 'could not restore original names for a dialog', e);
    }
  }, true);

  const onNavigate = () => {
    if (active() !== lastActive) refresh();
  };
  window.addEventListener('location-changed', onNavigate);
  window.addEventListener('popstate', onNavigate);

  await subscribe();
  window.__polyglot = {
    get language() { return language; },
    get active() { return active(); },
    raw,
    refresh,
  };
}

main().catch((e) => console.warn(TAG, 'not started', e));
