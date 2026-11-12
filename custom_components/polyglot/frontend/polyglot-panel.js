// Polyglot editor: the admin-only "Translations" panel. Plain custom element, no build step.
// Lists areas, floors, devices, entities and dashboard text with one input per row for the chosen language.
// core.js gets this module's ?v= query too, so a new release never runs against a cached old core.
const { collectConfig, isDevicePrefixed } = await import(
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

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

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
  async _loadHaTranslations() {
    const lang = this._language;
    this._haKeys = new Set();
    if (!lang) return;
    for (const category of ['entity', 'entity_component']) {
      try {
        const { resources } = await this._ws({ type: 'frontend/get_translations', language: lang, category });
        for (const k of Object.keys(resources || {})) if (k.includes('.state.')) this._haKeys.add(k);
      } catch (e) { /* older core: show everything */ }
    }
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
    const dashboards = await this._ws({ type: 'lovelace/dashboards/list' });
    const paths = [null, ...dashboards.filter((d) => d.mode === 'storage').map((d) => d.url_path)];
    for (const url_path of paths) {
      try {
        const cfg = await this._ws({ type: 'lovelace/config', url_path, force: false });
        const found = collectConfig(cfg);
        found.strings.forEach((s) => strings.add(s));
        found.entityIds.forEach((s) => entityIds.add(s));
      } catch (e) { /* auto-generated or YAML dashboard without config */ }
    }
    for (const d of dashboards) if (d.title) strings.add(d.title);
    return { strings, entityIds };
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
      rows = Object.values(h.areas).map((a) => ({ key: `area:${a.area_id}`, original: a.name, context: a.area_id }));
    } else if (this._type === 'floor') {
      rows = Object.values(h.floors || {}).map((f) => ({ key: `floor:${f.floor_id}`, original: f.name, context: f.floor_id }));
    } else if (this._type === 'device') {
      rows = Object.values(h.devices)
        .filter((d) => !d.disabled_by && (d.name_by_user || d.name))
        .filter((d) => !this._onlyUsed || usedDevices.has(d.id))
        .map((d) => ({ key: `device:${d.id}`, original: d.name_by_user || d.name, context: [areaName(d.area_id), d.model].filter(Boolean).join(' · ') }));
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
          return { key: `entity:${id}`, original, context: ctx };
        })
        .filter(Boolean);
    } else if (this._type === 'text') {
      rows = [...(this._dash ? this._dash.strings : [])].map((s) => ({ key: `text:${s}`, original: s, context: '' }));
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
    for (const [language, values] of entries) await this._ws({ type: 'polyglot/set_many', language, values });
    await this._load();
  }

  _render() {
    const c = this._config;
    const lang = this._language;
    const dict = (c && lang && c.translations[lang]) || {};
    const rows = c && lang ? this._rows() : [];
    const done = rows.filter((r) => dict[r.key]).length;
    const showToggle = ['device', 'entity', 'state'].includes(this._type);
    const focusedKey = this.shadowRoot.activeElement && this.shadowRoot.activeElement.dataset ? this.shadowRoot.activeElement.dataset.key : null;

    this.shadowRoot.innerHTML = `
      <style>
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
              <span class="muted">${done} / ${rows.length} translated</span>
            </div>
            <div class="card">
              ${rows.length ? rows.map((r) => `
                <div class="row${r.orphan ? ' orphan' : ''}">
                  <div class="orig">${esc(r.original)}${r.context ? `<span class="ctx">${esc(r.context)}</span>` : ''}</div>
                  <input type="text" data-key="${esc(r.key)}" value="${esc(dict[r.key] || '')}" placeholder="${esc(r.original)}" lang="${esc(lang)}">
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
    this.shadowRoot.querySelectorAll('[data-type]').forEach((b) => { b.onclick = () => { this._type = b.dataset.type; this._render(); }; });
    const search = $('#search');
    if (search) {
      search.oninput = (ev) => { this._search = ev.target.value; clearTimeout(this._t); this._t = setTimeout(() => { this._render(); const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 250); };
    }
    const used = $('#used');
    if (used) used.onchange = (ev) => { this._onlyUsed = ev.target.checked; this._render(); };
    this.shadowRoot.querySelectorAll('input[data-key]').forEach((input) => {
      const commit = async () => {
        const before = dict[input.dataset.key] || '';
        if (input.value.trim() === before) return;
        try {
          await this._save(input.dataset.key, input.value);
          input.classList.add('saved');
        } catch (e) { this._error = e.message; this._render(); }
      };
      input.onchange = commit;
      input.onkeydown = (ev) => { if (ev.key === 'Enter') input.blur(); };
    });
    if (focusedKey) {
      const f = this.shadowRoot.querySelector(`input[data-key="${CSS.escape(focusedKey)}"]`);
      if (f) f.focus();
    }
  }
}

customElements.define('polyglot-panel', PolyglotPanel);
