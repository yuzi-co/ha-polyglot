// Polyglot editor: the admin-only "Translations" panel. Plain custom element, no build step.
// Lists areas, floors, devices, entities and dashboard text with one input per row for the chosen language.
// core.js gets this module's ?v= query too, so a new release never runs against a cached old core.
const {
  buildTranslationPrompt, collectConfig, dedupeRows, isDevicePrefixed, packBatches, parseAiReply, parseTranslationReply,
  pickGlossary, placeOf, reviewSuggestions, roleOf,
} = await import(
  new URL(`./core.js${new URL(import.meta.url).search}`, import.meta.url).href
);

const TYPES = [
  ['area', 'Areas'],
  ['floor', 'Floors'],
  ['device', 'Devices'],
  ['entity', 'Entities'],
  ['text', 'Dashboard text'],
  ['state', 'State values'],
];

// What an entity of each domain is, in plain words: tells the AI a reading from an action ("Distance reset").
const KIND = {
  sensor: 'a reading', binary_sensor: 'an on/off reading', button: 'an action button', switch: 'an on/off switch',
  select: 'a choice', number: 'a setting', input_number: 'a setting', input_select: 'a choice', input_boolean: 'an on/off switch',
};

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
// The server's rules for keys and lengths (const.py), checked before an import sends anything.
const KEY_RE = /^(area|floor|device|entity|text|state):/;
const MAX_LENGTH = 500;

// "1 row", "2 rows".
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class PolyglotPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._type = 'area';
    this._search = '';
    this._onlyUsed = true;
    this._language = null;
    this._config = null; // { primary, languages, translations }
    this._dash = null; // { strings: Set, entityIds: Set }
    this._loading = false;
    this._error = null;
    this._userSettings = {};
    this._drafts = {};
    this._unsure = new Set(); // suggestion keys the AI marked as unsure
    this._stash = {}; // language -> { drafts, unsure }: suggestions of the languages not on screen
    this._flaggedOnly = false;
    this._show = 'all'; // row filter: all, todo (missing or suggested), missing, suggested
    // HA may create this element and set its properties before the module finished loading (it awaits core.js).
    // Those values landed as plain own properties that hide the setters below: re-apply them through the setters.
    for (const prop of ['narrow', 'panel', 'route', 'hass']) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = this[prop];
        delete this[prop];
        this[prop] = value;
      }
    }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    const menu = this.shadowRoot.querySelector('ha-menu-button');
    if (menu) menu.hass = hass;
  }

  set narrow(narrow) {
    this._narrow = narrow;
    const menu = this.shadowRoot.querySelector('ha-menu-button');
    if (menu) menu.narrow = narrow;
  }

  set panel(panel) { this._panel = panel; }

  _ws(msg) { return this._hass.callWS(msg); }

  async _load() {
    this._loading = true;
    this._render();
    try {
      this._config = await this._ws({ type: 'polyglot/config' });
      try {
        const { value } = await this._ws({ type: 'frontend/get_user_data', key: 'polyglot' });
        this._userSettings = value || {};
      } catch (e) { this._userSettings = {}; }
      if (!this._language || !this._config.languages.includes(this._language)) this._language = this._config.languages[0] || null;
      this._dash = await this._scanDashboards();
      await this._loadHaTranslations();
      this._error = null;
    } catch (e) {
      this._error = e.message || String(e);
    }
    this._loading = false;
    this._render();
  }

  // State values HA itself translates for the target language: those rows are hidden. Loaded per language.
  // Also keeps HA's entity names in the target and the original language, for _haNames.
  async _loadHaTranslations() {
    const lang = this._language;
    this._haKeys = new Set();
    this._haNamesTo = {};
    this._haNamesFrom = {};
    if (!lang) return;
    const names = async (language, into, states) => {
      for (const category of ['entity', 'entity_component']) {
        try {
          const { resources } = await this._ws({ type: 'frontend/get_translations', language, category });
          for (const [k, v] of Object.entries(resources || {})) {
            if (states && k.includes('.state.')) this._haKeys.add(k);
            else if (k.endsWith('.name')) into[k] = v;
          }
        } catch (e) { /* older core: show everything */ }
      }
    };
    await names(lang, this._haNamesTo, true);
    await names(this._config.primary, this._haNamesFrom, false);
    if (!this._registry) {
      try {
        const list = await this._ws({ type: 'config/entity_registry/list' });
        this._registry = new Map(list.map((e) => [e.entity_id, e]));
      } catch (e) { this._registry = new Map(); }
    }
  }

  // Names Home Assistant itself translates: entities named by their integration (translation_key) or by their
  // device class, not renamed by the user, whose original-language name is exactly the row's text (so names that
  // an integration composes or that carry placeholders are left to the AI). key → translation.
  _haNames(rows) {
    const out = {};
    for (const r of rows) {
      if (!r.key.startsWith('entity:')) continue;
      const id = r.key.slice(7);
      const e = this._registry && this._registry.get(id);
      const s = this._hass.states[id];
      if (!e || !s || e.name) continue;
      const domain = id.split('.')[0];
      let k = null;
      if (e.translation_key) k = `component.${e.platform}.entity.${domain}.${e.translation_key}.name`;
      else if (!e.original_name && s.attributes.device_class) k = `component.${domain}.entity_component.${s.attributes.device_class}.name`;
      const to = k && this._haNamesTo[k];
      // to === original: the integration has no real translation for this language, only the fallback.
      if (to && !to.includes('{') && to !== r.original && this._haNamesFrom[k] === r.original) out[r.key] = to;
    }
    return out;
  }

  // Fills missing rows from Home Assistant's own translations. Returns how many.
  _fillFromHa() {
    const found = this._haNames(this._missingRows());
    this._addDrafts(found);
    return Object.keys(found).length;
  }

  // True when HA has its own translation of this state value in the target language.
  _haTranslates(stateObj, value) {
    if (!this._haKeys || !this._haKeys.size) return false;
    const id = stateObj.entity_id;
    const domain = id.split('.')[0];
    const e = this._hass.entities[id];
    const dc = stateObj.attributes.device_class;
    return [
      e && e.translation_key && e.platform && `component.${e.platform}.entity.${domain}.${e.translation_key}.state.${value}`,
      dc && `component.${domain}.entity_component.${dc}.state.${value}`,
      `component.${domain}.entity_component._.state.${value}`,
    ].some((k) => k && this._haKeys.has(k));
  }

  async _scanDashboards() {
    const strings = new Set();
    const entityIds = new Set();
    const contexts = new Map();
    const dashboards = await this._ws({ type: 'lovelace/dashboards/list' });
    const list = [{ url_path: null, title: 'Overview' }, ...dashboards.filter((d) => d.mode === 'storage')];
    for (const { url_path, title } of list) {
      try {
        const cfg = await this._ws({ type: 'lovelace/config', url_path, force: false });
        const found = collectConfig(cfg, title);
        found.strings.forEach((s) => strings.add(s));
        found.entityIds.forEach((s) => entityIds.add(s));
        for (const [s, at] of found.contexts) contexts.set(s, [...(contexts.get(s) || []), ...at].slice(0, 3));
      } catch (e) { /* auto-generated or YAML dashboard without config */ }
    }
    for (const d of dashboards) {
      if (!d.title) continue;
      strings.add(d.title);
      if (!contexts.has(d.title)) contexts.set(d.title, [{ key: 'title in the sidebar' }]);
    }
    return { strings, entityIds, contexts };
  }

  // Rows for the current type: { key, original, context }.
  _rows() {
    const h = this._hass;
    const onDashboards = this._dash ? this._dash.entityIds : new Set();
    const usedDevices = new Set([...onDashboards].map((id) => h.entities[id] && h.entities[id].device_id).filter(Boolean));
    // "Likely visible": on a dashboard, on the same device as something on a dashboard, or assigned to an area
    // (area cards and auto-generated views show those).
    const used = new Set(Object.keys(h.states).filter((id) => {
      if (onDashboards.has(id)) return true;
      const e = h.entities[id];
      if (!e || e.hidden || e.entity_category) return false;
      const dev = e.device_id && h.devices[e.device_id];
      return usedDevices.has(e.device_id) || Boolean(e.area_id || (dev && dev.area_id));
    }));
    for (const id of used) {
      const e = h.entities[id];
      if (e && e.device_id) usedDevices.add(e.device_id);
    }
    const areaName = (id) => (id && h.areas[id] ? h.areas[id].name : '');
    let rows = [];
    if (this._type === 'area') {
      rows = Object.values(h.areas).map((a) => ({ key: `area:${a.area_id}`, original: a.name, context: a.area_id, about: 'room or area name' }));
    } else if (this._type === 'floor') {
      rows = Object.values(h.floors || {}).map((f) => ({ key: `floor:${f.floor_id}`, original: f.name, context: f.floor_id, about: 'floor name' }));
    } else if (this._type === 'device') {
      rows = Object.values(h.devices)
        .filter((d) => !d.disabled_by && (d.name_by_user || d.name))
        .filter((d) => !this._onlyUsed || usedDevices.has(d.id))
        .map((d) => ({
          key: `device:${d.id}`, original: d.name_by_user || d.name, context: [areaName(d.area_id), d.model].filter(Boolean).join(' · '),
          about: ['device name', [d.manufacturer, d.model].filter(Boolean).join(' ')].filter(Boolean).join(', '),
          group: d.area_id || null, groupLabel: d.area_id ? `room "${areaName(d.area_id)}"` : undefined,
        }));
    } else if (this._type === 'entity') {
      rows = Object.keys(h.states)
        .filter((id) => !this._onlyUsed || used.has(id))
        .map((id) => {
          const e = h.entities[id];
          const s = h.states[id];
          const prefixed = isDevicePrefixed(e);
          // Entities named after their device have nothing of their own to translate.
          if (prefixed && !e.name) return null;
          const original = prefixed ? e.name : s.attributes.friendly_name || id;
          const device = e && e.device_id && h.devices[e.device_id];
          const ctx = [id, prefixed && device ? `after device: ${device.name_by_user || device.name}` : ''].filter(Boolean).join(' · ');
          const domain = id.split('.')[0];
          const a = s.attributes;
          const dc = a.device_class;
          const unit = a.unit_of_measurement;
          // Only numbers are sent as the current value: text states can be personal (addresses, names, events).
          const now = /^-?\d+(\.\d+)?$/.test(s.state) ? `now ${s.state}${unit ? ` ${unit}` : ''}` : '';
          const range = a.min !== undefined && a.max !== undefined ? `range ${a.min} to ${a.max}` : '';
          const options = Array.isArray(a.options) && a.options.length ? `options: ${a.options.slice(0, 6).join(', ')}` : '';
          const about = [
            `${domain}${dc ? ` (${dc})` : ''}${KIND[domain] ? `, ${KIND[domain]}` : ''}`,
            unit && !now ? `unit ${unit}` : '',
            range,
            options,
            now,
            device && !prefixed ? 'full name' : '',
          ].filter(Boolean).join(', ');
          const model = device && [device.manufacturer, device.model].filter(Boolean).join(' ');
          const deviceName = device && (device.name_by_user || device.name);
          return {
            key: `entity:${id}`, original, context: ctx, about,
            group: device ? device.id : null,
            groupLabel: device ? `device "${deviceName}"${model && model !== deviceName ? ` (${model})` : ''}` : undefined,
          };
        })
        .filter(Boolean);
    } else if (this._type === 'text') {
      const contexts = (this._dash && this._dash.contexts) || new Map();
      rows = [...(this._dash ? this._dash.strings : [])].map((s) => {
        const at = contexts.get(s) || [];
        const place = at.length ? placeOf(at[0]) : '';
        return {
          key: `text:${s}`, original: s, context: place,
          about: at.length ? [...new Set(at.map(roleOf))].join('; ') : 'dashboard text',
          group: place || null, groupLabel: place || undefined,
        };
      });
    } else if (this._type === 'state') {
      // Text states and selectable options the way this page shows them, minus the ones HA already translates
      // into the target language (the target user never sees those in English). Dates and times are skipped.
      const seen = new Map();
      const SKIP_DOMAINS = ['input_datetime', 'date', 'time', 'datetime', 'calendar', 'event', 'button', 'scene', 'script', 'automation', 'update'];
      const looksLikeDate = (v) => /\b\d{4}\b|\d{1,2}:\d{2}/.test(v);
      const add = (value, id) => {
        if (typeof value !== 'string' || !/[^\d\s.,:%+-]/.test(value) || value.length > 100 || looksLikeDate(value)) return;
        if (!seen.has(value)) seen.set(value, new Set());
        seen.get(value).add(id);
      };
      for (const id of this._onlyUsed ? used : Object.keys(h.states)) {
        const s = h.states[id];
        if (!s || ['unavailable', 'unknown'].includes(s.state)) continue;
        if (SKIP_DOMAINS.includes(id.split('.')[0])) continue;
        if (s.attributes.unit_of_measurement !== undefined || ['timestamp', 'date', 'duration'].includes(s.attributes.device_class)) continue;
        if (!this._haTranslates(s, s.state)) add(h.formatEntityState(s), id);
        for (const opt of s.attributes.options || []) {
          if (!['unknown', 'unavailable'].includes(opt) && !this._haTranslates(s, opt)) add(h.formatEntityState(s, opt), id);
        }
      }
      rows = [...seen].map(([value, ids]) => ({
        key: `state:${value}`, original: value, context: [...ids].slice(0, 3).join(', ') + (ids.size > 3 ? ` +${ids.size - 3}` : ''),
        about: `state value or option of ${[...ids].slice(0, 3).map((id) => (h.states[id] && h.states[id].attributes.friendly_name) || id).join('; ')}`,
      }));
    }
    const dict = (this._config && this._language && this._config.translations[this._language]) || {};
    // Translations whose area, floor, device or entity no longer exists (renamed or removed).
    const exists = { area: (id) => h.areas[id], floor: (id) => (h.floors || {})[id], device: (id) => h.devices[id], entity: (id) => h.states[id] };
    if (exists[this._type]) {
      const prefix = `${this._type}:`;
      for (const key of Object.keys(dict)) {
        if (key.startsWith(prefix) && !exists[this._type](key.slice(prefix.length))) {
          rows.push({ key, original: key.slice(prefix.length), context: 'No longer exists (renamed or removed). Clear to delete.', orphan: true });
        }
      }
    }
    const q = this._search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => [r.original, r.context, dict[r.key]].some((v) => v && String(v).toLowerCase().includes(q)));
    // Orphans first, so they get noticed.
    return rows.sort((a, b) => (b.orphan ? 1 : 0) - (a.orphan ? 1 : 0) || String(a.original).localeCompare(String(b.original)));
  }

  async _save(key, value) {
    const lang = this._language;
    const v = value.trim();
    await this._ws({ type: 'polyglot/set', language: lang, key, value: v || null });
    const dict = (this._config.translations[lang] ||= {});
    if (v) dict[key] = v;
    else delete dict[key];
  }

  async _addLanguage(code) {
    const lang = code.trim();
    if (!lang) return;
    if (!LANG_RE.test(lang)) {
      this._error = `"${lang}" is not a language code. Use the code from the HA profile, for example ru, de or pt-BR.`;
      this._render();
      return;
    }
    this._error = null;
    this._adding = false;
    if (this._config.languages.includes(lang)) { this._language = lang; this._render(); return; }
    const languages = [...this._config.languages, lang];
    await this._ws({ type: 'polyglot/languages', languages });
    this._config.languages = languages;
    this._language = lang;
    await this._loadHaTranslations();
    this._render();
  }

  async _removeLanguage() {
    const lang = this._language;
    this._confirmRemove = false;
    this._clearDrafts(); // its suggestions go with it
    const languages = this._config.languages.filter((l) => l !== lang);
    await this._ws({ type: 'polyglot/languages', languages });
    await this._load();
  }

  // Stored in the admin's own frontend user data, so it follows them across devices and affects nobody else.
  async _setDashboardTextForMe(on) {
    const value = { ...(this._userSettings || {}), dashboard_text_for_admin: on };
    await this._ws({ type: 'frontend/set_user_data', key: 'polyglot', value });
    this._userSettings = value;
    this._render();
  }

  // Updates the missing count, the translated counter, the suggestion count and the AI buttons from the fields
  // as they are now. Rows a filter hides are counted as they were at the last redraw (this._hidden).
  _updateCounts() {
    const sr = this.shadowRoot;
    const hidden = this._hidden || { missing: 0, done: 0, total: 0 };
    const inputs = [...sr.querySelectorAll('input[data-key]')];
    const orphan = (i) => i.closest('.row') && i.closest('.row').classList.contains('orphan');
    const missing = hidden.missing + inputs.filter((i) => !orphan(i) && !i.value.trim()).length;
    const done = hidden.done + inputs.filter((i) => i.value.trim() && !i.classList.contains('draft')).length;
    const strong = sr.querySelector('.ai strong');
    if (strong) strong.textContent = `${missing} missing`;
    const counter = sr.querySelector('#done-count');
    if (counter) counter.textContent = `${done} / ${hidden.total} translated`;
    const draftCount = sr.querySelector('#draft-count');
    if (draftCount) draftCount.textContent = `${count(Object.keys(this._drafts || {}).length, 'suggestion', 'suggestions')} to review (dashed fields).`;
    const run = sr.querySelector('#ai-run');
    if (run && !this._aiBusy) run.disabled = !missing;
    const copy = sr.querySelector('#ai-copy');
    if (copy) copy.disabled = !missing;
  }

  // Saves fields edited but not yet committed (still focused), so the AI buttons work on what the page shows.
  async _commitPending() {
    const dict = (this._config.translations[this._language] ||= {});
    const drafts = this._drafts || {};
    const values = {};
    for (const i of this.shadowRoot.querySelectorAll('input[data-key]')) {
      const key = i.dataset.key;
      const v = i.value.trim();
      if (drafts[key] !== undefined) {
        if (v === drafts[key]) continue; // an untouched suggestion is not an edit
        // Edited or cleared: no longer a suggestion, so Save all cannot bring the AI's text back.
        delete drafts[key];
        this._unsure.delete(key);
      }
      if (v !== (dict[key] || '')) values[key] = v || null;
    }
    if (!Object.keys(values).length) return;
    await this._ws({ type: 'polyglot/set_many', language: this._language, values });
    for (const [k, v] of Object.entries(values)) {
      if (v) dict[k] = v; else delete dict[k];
      delete drafts[k];
      const input = this.shadowRoot.querySelector(`input[data-key="${CSS.escape(k)}"]`);
      if (input) input.defaultValue = v || '';
    }
  }

  // Rows of the current tab that have neither a translation nor a pending suggestion.
  _missingRows() {
    const dict = this._config.translations[this._language] || {};
    const drafts = this._drafts || {};
    return this._rows().filter((r) => !r.orphan && !dict[r.key] && !drafts[r.key]);
  }

  // The original text behind a translation key, from any tab.
  _originalOf(key) {
    const h = this._hass;
    const i = key.indexOf(':');
    const type = key.slice(0, i);
    const id = key.slice(i + 1);
    if (type === 'text' || type === 'state') return id;
    if (type === 'area') return h.areas[id] && h.areas[id].name;
    if (type === 'floor') return h.floors && h.floors[id] && h.floors[id].name;
    if (type === 'device') return h.devices[id] && (h.devices[id].name_by_user || h.devices[id].name);
    if (type === 'entity') {
      const e = h.entities[id];
      const s = h.states[id];
      if (!s) return undefined;
      return isDevicePrefixed(e) ? e.name : s.attributes.friendly_name;
    }
    return undefined;
  }

  // Translation units for rows (see dedupeRows): each distinct text once, with its group.
  _unitsFor(rows) {
    return dedupeRows(rows.map((r) => ({ key: r.key, text: r.original, about: r.about, group: r.group, groupLabel: r.groupLabel })));
  }

  _promptFor(items) {
    const names = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code); } catch (e) { return code; } };
    // Saved translations first, then this run's suggestions, so later batches follow earlier ones.
    const dict = this._config.translations[this._language] || {};
    const drafts = this._draftsFor === this._language ? this._drafts || {} : {};
    const known = [...Object.entries(dict), ...Object.entries(drafts)].map(([k, v]) => ({ text: this._originalOf(k), translation: v }));
    return buildTranslationPrompt({
      from: this._config.primary, to: this._language, fromName: names(this._config.primary), toName: names(this._language),
      items, glossary: pickGlossary(items, known),
    });
  }

  _aiTasks() {
    return Object.keys(this._hass.states).filter((id) => id.startsWith('ai_task.')).sort();
  }

  // Suggestions are kept per language until saved or discarded (switching language puts them aside, see _render);
  // they are never written without review.
  _addDrafts(values) {
    this._drafts = { ...(this._drafts || {}), ...values };
    this._draftsFor = this._language;
  }

  // Applies a parsed reply to its units: every key of a unit gets the translation. Returns the units left out.
  _applyUnits(units, { byId, unsure }) {
    const values = {};
    const missing = [];
    for (const u of units) {
      const t = byId[u.id];
      if (!t) { missing.push(u); continue; }
      for (const key of u.keys) {
        values[key] = t;
        if (unsure.has(String(u.id))) this._unsure.add(key);
      }
    }
    this._addDrafts(values);
    return missing;
  }

  _clearDrafts() {
    this._drafts = {};
    this._unsure = new Set();
    this._flaggedOnly = false;
  }

  async _translateWithAi() {
    const entity_id = this._aiEntity || this._userSettings.ai_task_entity || this._aiTasks()[0];
    // Home Assistant's own translations first: exact, free, and nothing to send.
    const fromHa = this._fillFromHa();
    if (fromHa) this._notice = `${count(fromHa, 'name', 'names')} taken from Home Assistant's own translations.`;
    const rows = this._missingRows();
    if (!entity_id || !rows.length) { this._render(); return; }
    const units = this._unitsFor(rows);
    const queue = packBatches(units, 30);
    const PARALLEL = 3;
    this._aiBusy = { done: 0, total: units.length };
    this._error = null;
    this._render();
    let failed = 0;
    let lastError = null;
    let worked = false;
    let stop = null;
    const progress = (n) => { this._aiBusy = { done: this._aiBusy.done + n, total: units.length }; this._render(); };
    // retried: units the AI left out of a reply get one more try in a batch of their own.
    const run = async (batch, retried) => {
      let reply;
      try {
        const res = await this._ws({
          type: 'call_service', domain: 'ai_task', service: 'generate_data', return_response: true,
          service_data: { task_name: 'Polyglot translation', entity_id, instructions: this._promptFor(batch) },
        });
        reply = parseAiReply(res && res.response ? res.response.data : undefined);
      } catch (e) {
        // Too much output for one reply: split the batch. Any other error: stop if nothing has worked yet (the AI
        // itself is failing), otherwise skip this batch and go on.
        if (/token|length|limit|too long|truncat/i.test(e.message || '') && batch.length > 1) {
          const half = Math.ceil(batch.length / 2);
          await run(batch.slice(0, half), retried);
          await run(batch.slice(half), retried);
          return;
        }
        if (!worked) { stop = e; return; }
        failed += batch.length;
        lastError = e;
        progress(batch.length);
        return;
      }
      worked = true;
      const missing = this._applyUnits(batch, reply);
      progress(batch.length - missing.length);
      if (!missing.length) return;
      if (!retried) { await run(missing, true); return; }
      failed += missing.length;
      lastError = new Error('the AI left them out of its reply');
      progress(missing.length);
    };
    // A few batches at a time; the first one alone, so a failing AI stops the run after one call.
    const worker = async () => {
      while (queue.length && !stop) await run(queue.shift(), false);
    };
    try {
      if (queue.length) await run(queue.shift(), false);
      if (!stop) await Promise.all(Array.from({ length: PARALLEL }, worker));
      if (stop) throw stop;
    } finally {
      this._aiBusy = null;
      if (failed) this._error = `${count(failed, 'name', 'names')} could not be translated (${(lastError && lastError.message) || lastError}). Run it again for those.`;
      this._render();
    }
  }

  async _setAiEntity(entity_id) {
    this._aiEntity = entity_id;
    const value = { ...(this._userSettings || {}), ai_task_entity: entity_id };
    await this._ws({ type: 'frontend/set_user_data', key: 'polyglot', value });
    this._userSettings = value;
  }

  async _copyForAi() {
    const fromHa = this._fillFromHa();
    const rows = this._missingRows();
    if (!rows.length) { this._render(); return; }
    const units = this._unitsFor(rows);
    // The reply refers to the numbers in this prompt; kept until the reply is pasted.
    this._copied = units;
    const text = this._promptFor(units);
    try {
      await navigator.clipboard.writeText(text);
      this._notice = `${fromHa ? `${count(fromHa, 'name', 'names')} taken from Home Assistant's own translations. ` : ''}Copied ${count(units.length, 'name', 'names')}. Paste them into any AI chat, then paste its reply here.`;
    } catch (e) {
      this._manualCopy = text; // clipboard blocked: show the text to copy by hand
    }
    this._pasting = true;
    this._render();
  }

  _applyPastedReply(text) {
    const before = Object.keys(this._drafts || {}).length;
    const reply = parseAiReply(text);
    if (this._copied && Object.keys(reply.byId).length) {
      // A reply to "Copy for any AI": numbered.
      this._applyUnits(this._copied, reply);
    } else {
      // Keys, as in an Export file.
      let found = {};
      try { found = parseTranslationReply(text, new Set(this._rows().map((r) => r.key)), this._language); } catch (e) { /* none */ }
      this._addDrafts(found);
    }
    const n = Object.keys(this._drafts).length - before;
    if (!n) {
      throw new Error(Object.keys(reply.byId).length
        ? 'This reply is for an earlier copy. Copy again and paste the new reply.'
        : 'The reply has no translations for rows on this tab.');
    }
    this._pasting = false;
    this._manualCopy = null;
    this._notice = `${count(n, 'suggestion', 'suggestions')} added. Review, then Save all.`;
    this._render();
  }

  async _saveDrafts() {
    const values = { ...this._drafts };
    if (!Object.keys(values).length) { this._clearDrafts(); this._render(); return; }
    await this._ws({ type: 'polyglot/set_many', language: this._language, values });
    const dict = (this._config.translations[this._language] ||= {});
    Object.assign(dict, values);
    this._clearDrafts();
    this._notice = `Saved ${count(Object.keys(values).length, 'translation', 'translations')}.`;
    this._render();
  }

  _export() {
    const data = { primary: this._config.primary, translations: this._config.translations };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'polyglot-translations.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async _import(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('Not a JSON file.'); }
    const translations = data && typeof data === 'object' ? data.translations || data : null;
    const entries = translations
      ? Object.entries(translations).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
      : [];
    if (!entries.length) throw new Error('No translations found in the file. Expected the format that Export writes.');
    const bad = entries.map(([l]) => l).filter((l) => !LANG_RE.test(l));
    if (bad.length) throw new Error(`Not language codes: ${bad.join(', ')}. Nothing was imported.`);
    // Everything the server would refuse is found first, so an import is all or nothing.
    const refused = [];
    for (const [language, values] of entries) {
      for (const [k, v] of Object.entries(values)) {
        const ok = KEY_RE.test(k) && k.length <= MAX_LENGTH && (v === null || (typeof v === 'string' && v.trim().length <= MAX_LENGTH));
        if (!ok) refused.push(`${language} "${k.length > 40 ? `${k.slice(0, 40)}…` : k}"`);
      }
    }
    if (refused.length) {
      throw new Error(`${count(refused.length, 'entry is', 'entries are')} not valid (unknown key, not text, or longer than ${MAX_LENGTH} characters): ${refused.slice(0, 3).join(', ')}${refused.length > 3 ? ', …' : ''}. Nothing was imported.`);
    }
    for (const [language, values] of entries) await this._ws({ type: 'polyglot/set_many', language, values });
    await this._load();
  }

  _render() {
    const c = this._config;
    const lang = this._language;
    const dict = (c && lang && c.translations[lang]) || {};
    if (this._draftsFor !== lang) {
      // Another language: put this one's suggestions aside and bring back the ones waiting for the new one.
      if (this._draftsFor && Object.keys(this._drafts || {}).length) this._stash[this._draftsFor] = { drafts: this._drafts, unsure: this._unsure };
      const back = lang ? this._stash[lang] : null;
      if (lang) delete this._stash[lang];
      this._clearDrafts();
      if (back) { this._drafts = back.drafts; this._unsure = back.unsure; }
      this._draftsFor = lang;
    }
    const drafts = this._drafts || {};
    const draftCount = Object.keys(drafts).length;
    const allRows = c && lang ? this._rows() : [];
    // Suggestions worth a second look on this tab, and the filter that shows only them.
    const flags = draftCount ? reviewSuggestions(allRows, drafts, dict, this._unsure) : {};
    const flagCount = Object.keys(flags).length;
    if (!flagCount) this._flaggedOnly = false;
    const isMissing = (r) => !r.orphan && !dict[r.key] && !drafts[r.key];
    // A suggestion waiting for review: from the AI, a pasted reply or Home Assistant's own names.
    const isSuggested = (r) => Boolean(drafts[r.key]) && drafts[r.key] !== dict[r.key];
    const filter = { missing: isMissing, suggested: isSuggested, todo: (r) => isMissing(r) || isSuggested(r) }[this._show];
    const rows = this._flaggedOnly ? allRows.filter((r) => flags[r.key]) : filter ? allRows.filter(filter) : allRows;
    const missingRows = c && lang ? allRows.filter(isMissing) : [];
    const shown = new Set(rows);
    const hiddenRows = allRows.filter((r) => !shown.has(r));
    this._hidden = { missing: hiddenRows.filter(isMissing).length, done: hiddenRows.filter((r) => dict[r.key]).length, total: allRows.length };
    const missing = missingRows.length;
    const haCount = this._type === 'entity' ? Object.keys(this._haNames(missingRows)).length : 0;
    const aiTasks = this._hass ? this._aiTasks() : [];
    const aiEntity = this._aiEntity || (this._userSettings && this._userSettings.ai_task_entity) || aiTasks[0];
    const done = allRows.filter((r) => dict[r.key]).length;
    const showToggle = ['device', 'entity', 'state'].includes(this._type);
    // Keep focus, caret and any unsaved typing across a redraw (it rebuilds every field).
    const active = this.shadowRoot.activeElement;
    const focusedKey = active && active.dataset ? active.dataset.key : null;
    const caret = focusedKey ? [active.selectionStart, active.selectionEnd] : null;
    const typing = {};
    this.shadowRoot.querySelectorAll('input[data-key]').forEach((i) => { if (i.value !== i.defaultValue) typing[i.dataset.key] = i.value; });

    this.shadowRoot.innerHTML = `
      <style>
        /* The editor's own text is English, so it stays left to right in a right-to-left UI (Hebrew, Arabic);
           names and translations get dir="auto" and follow their own script. */
        :host { direction: ltr; }
        :host { display: block; min-height: 100vh; background: var(--primary-background-color); color: var(--primary-text-color);
          font-family: var(--ha-font-family-body, Roboto, sans-serif); }
        header { display: flex; align-items: center; gap: 8px; height: var(--header-height, 56px); padding: 0 12px;
          background: var(--app-header-background-color); color: var(--app-header-text-color, var(--text-primary-color));
          border-bottom: var(--app-header-border-bottom, none); position: sticky; top: 0; z-index: 2; }
        header h1 { font-size: 20px; font-weight: 400; margin: 0; flex: 1; }
        main { max-width: 960px; margin: 0 auto; padding: 16px; }
        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
        .tabs { display: flex; flex-wrap: wrap; gap: 4px; }
        button, select, input { font: inherit; color: inherit; }
        button { background: var(--secondary-background-color); border: 1px solid var(--divider-color); border-radius: 8px;
          padding: 6px 12px; cursor: pointer; }
        button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        select, input[type=text], input[type=search] { background: var(--input-fill-color, var(--card-background-color));
          border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 10px; }
        input[type=search] { flex: 1; min-width: 160px; }
        .muted { color: var(--secondary-text-color); font-size: 0.9em; }
        .card { background: var(--ha-card-background, var(--card-background-color)); border-radius: var(--ha-card-border-radius, 12px);
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color)); overflow: hidden; }
        .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--divider-color); align-items: center; }
        .row:first-child { border-top: none; }
        .row .orig { overflow-wrap: anywhere; }
        .row .ctx { display: block; color: var(--secondary-text-color); font-size: 0.8em; overflow-wrap: anywhere; }
        .row input { width: 100%; box-sizing: border-box; }
        .row input.saved { border-color: var(--success-color, #4caf50); }
        .row.orphan .orig { color: var(--warning-color, #ff9800); }
        .row .flag { display: block; color: var(--warning-color, #ff9800); font-size: 0.8em; }
        .row input.draft { border-color: var(--primary-color); border-style: dashed; font-style: italic; }
        .ai { padding: 10px 12px; margin-bottom: 12px; }
        .ai .bar { margin-bottom: 0; }
        .ai textarea { width: 100%; box-sizing: border-box; min-height: 120px; margin-top: 8px; font: inherit; font-size: 0.85em;
          background: var(--input-fill-color, var(--card-background-color)); color: inherit; border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px; }
        .notice { color: var(--success-color, #4caf50); }
        button:disabled { opacity: 0.5; cursor: default; }
        .empty, .error { padding: 24px; text-align: center; }
        .error { color: var(--error-color); }
        @media (max-width: 600px) { .row { grid-template-columns: 1fr; gap: 4px; } main { padding: 8px; } }
      </style>
      <header>
        <ha-menu-button></ha-menu-button>
        <h1>Translations</h1>
        <button id="export" ${c ? '' : 'disabled'}>Export</button>
        <button id="import" ${c ? '' : 'disabled'}>Import</button>
        <input id="file" type="file" accept="application/json" hidden>
      </header>
      <main>
        ${this._error ? `<div class="error">${esc(this._error)}</div>` : ''}
        ${this._loading ? '<div class="empty muted">Loading…</div>' : ''}
        ${c ? `
          <div class="bar">
            <span class="muted">Original: ${esc(c.primary)}</span>
            ${c.languages.length ? `<select id="lang">${c.languages.map((l) => `<option ${l === lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}
            ${this._adding || !c.languages.length
    ? '<input type="text" id="new-lang" placeholder="Language code, e.g. ru" size="18"><button id="add-ok">Add</button>' + (c.languages.length ? '<button id="add-cancel">Cancel</button>' : '')
    : '<button id="add-lang">Add language</button>'}
            ${lang && !this._adding ? (this._confirmRemove
    ? `<span>Remove ${esc(lang)} and its ${Object.keys(dict).length} translations?</span><button id="remove-yes">Remove</button><button id="remove-no">Keep</button>`
    : '<button id="remove-lang">Remove language</button>') : ''}
          </div>
          <div class="bar">
            <label><input type="checkbox" id="me-text" ${this._userSettings && this._userSettings.dashboard_text_for_admin ? 'checked' : ''}>
              Translate dashboard text for me too</label>
            <span class="muted">Admins see original dashboard text by default. When on, dashboards you save get their
              translated text turned back into the original first.</span>
          </div>
          ${lang ? `
            <div class="bar tabs">${TYPES.map(([t, label]) => `<button class="${t === this._type ? 'on' : ''}" data-type="${t}">${label}</button>`).join('')}</div>
            <div class="bar">
              <input type="search" id="search" placeholder="Search" value="${esc(this._search)}">
              ${showToggle ? `<label class="muted"><input type="checkbox" id="used" ${this._onlyUsed ? 'checked' : ''}> Only likely visible</label>` : ''}
              <select id="show" title="Which rows to show">${[['all', 'All rows'], ['todo', 'Missing or suggested'], ['missing', 'Missing'], ['suggested', 'Suggestions']]
    .map(([v, label]) => `<option value="${v}" ${v === this._show ? 'selected' : ''}>${label}</option>`).join('')}</select>
              <span class="muted" id="done-count">${done} / ${allRows.length} translated</span>
            </div>
            <div class="card ai">
              <div class="bar">
                <strong>${missing} missing</strong>
                ${haCount ? `<button id="ha-fill" title="Names Home Assistant already translates for this language">Use Home Assistant's names (${haCount})</button>` : ''}
                ${aiTasks.length ? `
                  <select id="ai-entity" title="AI used for translating">${aiTasks.map((id) => `<option value="${esc(id)}" ${id === aiEntity ? 'selected' : ''}>${esc((this._hass.states[id].attributes.friendly_name) || id)}</option>`).join('')}</select>
                  <button id="ai-run" ${!missing || this._aiBusy ? 'disabled' : ''}>${this._aiBusy ? `Translating ${this._aiBusy.done} / ${this._aiBusy.total}…` : 'Translate missing with AI'}</button>` : ''}
                <button id="ai-copy" ${!missing ? 'disabled' : ''}>Copy for any AI</button>
                <button id="ai-paste">Paste reply</button>
              </div>
              <div class="muted">${aiTasks.length
    ? `Sends the missing names on this tab, with a short description of each, to the chosen AI. ${this._type === 'state' ? 'On this tab the state values themselves are what is sent: use Search to narrow them down if some are private. ' : ''}Suggestions are shown for review and saved only when you choose.`
    : 'Set up an AI Task in Home Assistant to translate here in one click, or copy the missing names into any AI chat and paste the reply back.'}</div>
              ${this._notice ? `<div class="notice">${esc(this._notice)}</div>` : ''}
              ${draftCount ? `<div class="bar" style="margin-top:8px"><span id="draft-count">${count(draftCount, 'suggestion', 'suggestions')} to review (dashed fields).</span><button id="drafts-save" class="on">Save all</button><button id="drafts-discard">Discard</button>
                ${flagCount ? `<label><input type="checkbox" id="flagged-only" ${this._flaggedOnly ? 'checked' : ''}> Only the ${count(flagCount, 'one', 'ones')} to check here</label>` : ''}</div>` : ''}
              ${this._pasting ? `
                ${this._manualCopy ? `<div class="muted">Copying was blocked. Select this text, copy it into an AI chat:</div><textarea readonly id="manual-copy">${esc(this._manualCopy)}</textarea>` : ''}
                <textarea id="paste-box" dir="auto" placeholder="Paste the AI's reply here (the JSON with translations)"></textarea>
                <div class="bar" style="margin-top:8px"><button id="paste-apply">Use reply</button><button id="paste-cancel">Cancel</button></div>` : ''}
            </div>
            <div class="card">
              ${rows.length ? rows.map((r) => `
                <div class="row${r.orphan ? ' orphan' : ''}">
                  <div class="orig"><bdi>${esc(r.original)}</bdi>${r.context ? `<span class="ctx" dir="auto">${esc(r.context)}</span>` : ''}${flags[r.key] ? `<span class="flag">Check: ${esc(flags[r.key].join(', '))}</span>` : ''}</div>
                  <input type="text" data-key="${esc(r.key)}" class="${isSuggested(r) ? 'draft' : ''}" value="${esc(drafts[r.key] || dict[r.key] || '')}" placeholder="${esc(r.original)}" lang="${esc(lang)}" dir="auto">
                </div>`).join('') : '<div class="empty muted">Nothing here.</div>'}
            </div>` : '<div class="empty muted">Add a language to start, for example ru, de or fr.</div>'}
        ` : ''}
      </main>`;

    const $ = (s) => this.shadowRoot.querySelector(s);
    const menu = $('ha-menu-button');
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    if (!c) return;
    $('#export').onclick = () => this._export();
    $('#import').onclick = () => $('#file').click();
    $('#file').onchange = (ev) => ev.target.files[0] && this._import(ev.target.files[0]).catch((e) => { this._error = e.message; this._render(); });
    const fail = (e) => { this._error = e.message || String(e); this._render(); };
    const me = $('#me-text');
    if (me) me.onchange = (ev) => this._setDashboardTextForMe(ev.target.checked).catch(fail);
    const sel = $('#lang');
    if (sel) sel.onchange = async (ev) => { this._language = ev.target.value; this._confirmRemove = false; await this._loadHaTranslations(); this._render(); };
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('#add-lang', () => { this._adding = true; this._render(); const i = $('#new-lang'); if (i) i.focus(); });
    on('#add-cancel', () => { this._adding = false; this._error = null; this._render(); });
    on('#add-ok', () => this._addLanguage($('#new-lang').value).catch(fail));
    const nl = $('#new-lang');
    if (nl) nl.onkeydown = (ev) => { if (ev.key === 'Enter') this._addLanguage(nl.value).catch(fail); };
    on('#remove-lang', () => { this._confirmRemove = true; this._render(); });
    on('#remove-no', () => { this._confirmRemove = false; this._render(); });
    on('#remove-yes', () => this._removeLanguage().catch(fail));
    this.shadowRoot.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { this._type = b.dataset.type; this._notice = null; this._pasting = false; this._render(); }; });
    const search = $('#search');
    if (search) {
      search.oninput = (ev) => { this._search = ev.target.value; clearTimeout(this._t); this._t = setTimeout(() => { this._render(); const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 250); };
    }
    const aiSel = $('#ai-entity');
    if (aiSel) aiSel.onchange = (ev) => this._setAiEntity(ev.target.value).catch(fail);
    on('#ai-run', () => { this._notice = null; this._commitPending().then(() => this._translateWithAi()).catch(fail); });
    on('#ai-copy', () => { this._notice = null; this._commitPending().then(() => this._copyForAi()).catch(fail); });
    on('#ha-fill', () => {
      const n = this._fillFromHa();
      this._notice = `${count(n, 'name', 'names')} taken from Home Assistant's own translations. Review, then Save all.`;
      this._render();
    });
    on('#ai-paste', () => { this._pasting = true; this._notice = null; this._render(); const b = $('#paste-box'); if (b) b.focus(); });
    on('#paste-cancel', () => { this._pasting = false; this._manualCopy = null; this._render(); });
    on('#paste-apply', () => { try { this._applyPastedReply($('#paste-box').value); } catch (e) { fail(e); } });
    on('#drafts-save', () => this._saveDrafts().catch(fail));
    on('#drafts-discard', () => { this._clearDrafts(); this._notice = null; this._render(); });
    const fo = $('#flagged-only');
    if (fo) fo.onchange = (ev) => { this._flaggedOnly = ev.target.checked; this._render(); };
    const mc = $('#manual-copy');
    if (mc) mc.onfocus = () => mc.select();
    const show = $('#show');
    if (show) show.onchange = (ev) => { this._show = ev.target.value; this._render(); };
    const used = $('#used');
    if (used) used.onchange = (ev) => { this._onlyUsed = ev.target.checked; this._render(); };
    this.shadowRoot.querySelectorAll('input[data-key]').forEach((input) => {
      const commit = async () => {
        const key = input.dataset.key;
        const v = input.value.trim();
        // An edited or cleared suggestion is no longer a suggestion. It is dropped here, before anything is
        // awaited, so the click on Save all that took the focus away cannot save the AI's text over the edit.
        if (this._drafts && this._drafts[key] !== undefined && v !== this._drafts[key]) {
          delete this._drafts[key];
          this._unsure.delete(key);
          input.classList.remove('draft');
        }
        const before = (this._config.translations[this._language] || {})[key] || '';
        if (v === before) {
          input.defaultValue = v;
          this._updateCounts();
          return;
        }
        try {
          await this._save(key, input.value);
          // Saved: no longer unsaved typing, so a later redraw shows the stored value, not this text.
          input.defaultValue = v;
          if (this._drafts) delete this._drafts[key];
          input.classList.remove('draft');
          input.classList.toggle('saved', Boolean(v));
          this._updateCounts();
        } catch (e) { this._error = e.message; this._render(); }
      };
      input.onchange = commit;
      input.oninput = () => this._updateCounts();
      input.onkeydown = (ev) => { if (ev.key === 'Enter') input.blur(); };
    });
    for (const [key, value] of Object.entries(typing)) {
      const f = this.shadowRoot.querySelector(`input[data-key="${CSS.escape(key)}"]`);
      if (f) f.value = value;
    }
    if (focusedKey) {
      const f = this.shadowRoot.querySelector(`input[data-key="${CSS.escape(focusedKey)}"]`);
      if (f) {
        f.focus();
        if (caret && caret[0] !== null) try { f.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
      }
    }
  }
}

// A tab that stayed open across an upgrade loads this module again under its new URL; defining the element twice
// throws and would leave the panel failing to load until the tab is reloaded.
if (!customElements.get('polyglot-panel')) customElements.define('polyglot-panel', PolyglotPanel);
