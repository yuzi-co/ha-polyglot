// Pure translation logic shared by the runtime overlay (polyglot.js) and the tests. No DOM, no Home Assistant
// imports: everything here works on plain objects shaped like the frontend's `hass` registries.
//
// Dictionary keys:
//   area:<area_id>      floor:<floor_id>      device:<device_id>      entity:<entity_id>      text:<exact string>

/** Language to use for a user, or null when they should see the original names. */
export function pickLanguage(userLanguage, primary, available) {
  if (!userLanguage) return null;
  const base = (l) => String(l).toLowerCase().split('-')[0];
  if (available.includes(userLanguage)) return userLanguage;
  if (base(userLanguage) === base(primary)) return null;
  return available.find((l) => base(l) === base(userLanguage)) || null;
}

/**
 * Translates every value of a record with `fn`. Returns the same record object when nothing changed, so Lit
 * components that compare by reference do not re-render.
 */
export function mapRecord(record, fn) {
  if (!record) return record;
  let out = null;
  for (const key of Object.keys(record)) {
    const value = record[key];
    const translated = fn(value, key);
    if (translated !== value) {
      if (!out) out = { ...record };
      out[key] = translated;
    }
  }
  return out || record;
}

const deviceName = (d) => (d ? (d.name_by_user || d.name || '').trim() : '');

/**
 * True when the entity's name is shown after its device's name ("Climate sensor" + "Humidity"). Current frontends
 * mark this with next_name_part = "device"; older ones with has_entity_name.
 */
export const isDevicePrefixed = (e) => Boolean(e && e.device_id && (e.next_name_part === 'device' || e.has_entity_name));

/**
 * Builds the translator for one dictionary. Each helper returns its input unchanged when it has nothing to do.
 * `auto` holds names to fall back on where the dictionary has none (see autoNames), in the same key format.
 */
export function createTranslator(dict, auto) {
  const own = Boolean(dict) && Object.keys(dict).length > 0;
  const fallback = Boolean(auto) && Object.keys(auto).length > 0;
  const has = own || fallback;
  const t = (key) => (own && dict[key]) || (fallback ? auto[key] : undefined);

  const area = (a) => {
    const name = a && t(`area:${a.area_id}`);
    return name ? { ...a, name } : a;
  };
  const floor = (f) => {
    const name = f && t(`floor:${f.floor_id}`);
    return name ? { ...f, name } : f;
  };
  // The frontend shows name_by_user before name, so setting name_by_user is enough.
  const device = (d) => {
    const name = d && t(`device:${d.id}`);
    return name ? { ...d, name_by_user: name } : d;
  };
  // Entity registry display entries: `name` is the entity's own part of the name (without the device name when
  // the entity is device-prefixed). Entities without a registry entry only have a friendly_name, handled in state().
  const entity = (e) => {
    const name = e && e.name && t(`entity:${e.entity_id}`);
    return name ? { ...e, name } : e;
  };

  /**
   * friendly_name for a state object. When the backend composed it as "<device> <entity>", rebuild it from the
   * translated parts; otherwise fall back to the entity's own translation.
   */
  const friendlyName = (stateObj, entities, devices) => {
    const id = stateObj.entity_id;
    const current = stateObj.attributes && stateObj.attributes.friendly_name;
    const ent = entities && entities[id];
    const tEnt = t(`entity:${id}`);
    const dev = ent && ent.device_id && devices ? devices[ent.device_id] : undefined;
    const tDev = dev ? t(`device:${dev.id}`) : undefined;
    if (!tEnt && !tDev) return current;
    if (isDevicePrefixed(ent) && dev) {
      const origDev = deviceName(dev);
      const origEnt = ent.name || '';
      const composed = [origDev, origEnt].filter(Boolean).join(' ');
      if (current === composed) {
        return [tDev || origDev, origEnt ? tEnt || origEnt : ''].filter(Boolean).join(' ');
      }
    }
    return tEnt || current;
  };

  // The frontend makes a new `states` record on every state change but keeps the objects of unchanged entities.
  // Results are cached per state object (and the registry entries they were built from), so an unchanged entity
  // keeps its translated object too and cards comparing by reference do not re-render.
  const stateCache = new WeakMap();
  const state = (stateObj, entities, devices) => {
    if (!has || !stateObj || !stateObj.attributes) return stateObj;
    const ent = entities ? entities[stateObj.entity_id] : undefined;
    const dev = ent && ent.device_id && devices ? devices[ent.device_id] : undefined;
    const hit = stateCache.get(stateObj);
    if (hit && hit.ent === ent && hit.dev === dev) return hit.out;
    const current = stateObj.attributes.friendly_name;
    const name = friendlyName(stateObj, entities, devices);
    const out = !name || name === current ? stateObj : { ...stateObj, attributes: { ...stateObj.attributes, friendly_name: name } };
    stateCache.set(stateObj, { ent, dev, out });
    return out;
  };

  const text = (s) => {
    if (!has || typeof s !== 'string') return s;
    const hit = t(`text:${s.trim()}`);
    return hit || s;
  };

  // Displayed state values ("Sweeping and mopping", "recirculation"), for integrations without a translation.
  const stateText = (s) => {
    if (!has || typeof s !== 'string') return s;
    const hit = t(`state:${s.trim()}`);
    return hit || s;
  };

  // Same for the parts form: [{ type: 'value', value: '…' }, { type: 'unit', value: '°C' }].
  const stateParts = (parts) => {
    if (!has || !Array.isArray(parts)) return parts;
    let out = null;
    parts.forEach((p, i) => {
      if (p && p.type === 'value' && typeof p.value === 'string') {
        const v = stateText(p.value);
        if (v !== p.value) {
          if (!out) out = parts.slice();
          out[i] = { ...p, value: v };
        }
      }
    });
    return out || parts;
  };

  return { has, area, floor, device, entity, state, text, stateText, stateParts };
}

/**
 * Names Home Assistant itself has in the viewer's language, for entities still named by their integration or
 * by their device class. Home Assistant shows those names in the system language to everyone; this finds the
 * viewer's version. from, to: translation resources ("component.x.entity.sensor.y.name" → text) in the system
 * language and the viewer's. An entity counts as still named by its integration when its name is exactly the
 * system-language text, so renamed entities and names built from placeholders are left alone.
 * Returns { "entity:<id>": name }.
 */
export function autoNames(entities, states, from, to) {
  const out = {};
  if (!entities || !from || !to) return out;
  for (const id of Object.keys(entities)) {
    const e = entities[id];
    const name = e && typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) continue;
    const domain = id.split('.')[0];
    const s = states && states[id];
    const deviceClass = s && s.attributes && s.attributes.device_class;
    const keys = [
      e.translation_key && e.platform && `component.${e.platform}.entity.${domain}.${e.translation_key}.name`,
      `component.${domain}.entity_component.${deviceClass || '_'}.name`,
    ];
    for (const k of keys) {
      if (!k || from[k] !== name) continue;
      const translated = to[k];
      if (typeof translated === 'string' && translated && translated !== name && !translated.includes('{')) out[`entity:${id}`] = translated;
      break;
    }
  }
  return out;
}

// Config keys that hold visible text in core and popular custom cards. Only these are translated, so IDs, options
// and entity IDs are not changed, even if someone adds them to the dictionary.
export const TEXT_KEYS = new Set([
  'name', 'title', 'heading', 'subtitle', 'label', 'primary', 'secondary', 'content', 'text', 'placeholder',
  'caption', 'description', 'message',
]);

// What an action sends to Home Assistant (tap_action.data.message, target.label_id): never text to translate.
export const ACTION_DATA_KEYS = new Set(['data', 'service_data', 'target']);

/** Deep-copies only what changes: exact-match translation of visible strings in a dashboard config. */
export function translateConfig(node, text, key) {
  if (typeof node === 'string') return TEXT_KEYS.has(key) ? text(node) : node;
  if (Array.isArray(node)) {
    let out = null;
    node.forEach((item, i) => {
      // Strings in a list inherit the list's key, so ["light.x"] under `entities` stays untouched.
      const tr = translateConfig(item, text, key);
      if (tr !== item) {
        if (!out) out = node.slice();
        out[i] = tr;
      }
    });
    return out || node;
  }
  if (node && typeof node === 'object') {
    let out = null;
    for (const k of Object.keys(node)) {
      if (ACTION_DATA_KEYS.has(k)) continue;
      const tr = translateConfig(node[k], text, k);
      if (tr !== node[k]) {
        if (!out) out = { ...node };
        out[k] = tr;
      }
    }
    return out || node;
  }
  return node;
}

/**
 * Inverse of translateConfig for saving: visible strings equal to a translation go back to their original. Used
 * when someone edits a dashboard while it is shown translated, so the translation never lands in the config.
 * A translation shared by several originals is left alone (no way to know which one was meant).
 */
export function untranslateConfig(config, dict) {
  return restoreConfig(config, Object.entries(dict || {}).filter(([key]) => key.startsWith('text:')).map(([key, value]) => [value, key.slice(5)]));
}

/**
 * Puts originals back into a dashboard config: visible strings equal to a shown text become its original.
 * pairs: [[shown, original]]. A shown text with several originals is left alone.
 */
export function restoreConfig(config, pairs) {
  const inverse = new Map();
  const ambiguous = new Set();
  for (const [shown, original] of pairs) {
    if (typeof shown !== 'string' || typeof original !== 'string') continue;
    if (inverse.has(shown) && inverse.get(shown) !== original) ambiguous.add(shown);
    else inverse.set(shown, original);
  }
  for (const v of ambiguous) inverse.delete(v);
  if (!inverse.size) return config;
  return translateConfig(config, (s) => (inverse.has(s.trim()) ? inverse.get(s.trim()) : s));
}

/** How many parts of a dashboard config are generated in the browser: the dashboard itself and its views. */
export const strategyCount = (config) => (!config || typeof config !== 'object' ? 0
  : (config.strategy ? 1 : 0) + (Array.isArray(config.views) ? config.views.filter((v) => v && v.strategy).length : 0));

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'off']);
const words = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP_WORDS.has(w));

/**
 * Picks existing translations that share words with the items, so the AI reuses the user's terms.
 * known: [{ text, translation }]. Exact matches come first, then the entries sharing the most words.
 */
export function pickGlossary(items, known, max = 60) {
  const wanted = new Set(items.flatMap((i) => words(i.text)));
  const exact = new Set(items.map((i) => i.text));
  const seen = new Set();
  const scored = [];
  for (const { text, translation } of known) {
    if (!text || !translation || seen.has(text)) continue;
    const hits = exact.has(text) ? 1000 : words(text).filter((w) => wanted.has(w)).length;
    if (!hits) continue;
    seen.add(text);
    scored.push({ text, translation, hits });
  }
  return scored
    .sort((a, b) => b.hits - a.hits || a.text.length - b.text.length)
    .slice(0, max)
    .map(({ text, translation }) => ({ text, translation }));
}

/**
 * Turns editor rows into translation units: one per distinct text and description, so a name used by several
 * devices or tabs is translated once and the same way. rows: [{ key, text, about, group, groupLabel }].
 * Returns [{ id, text, about, group, groupLabel, keys }], ids counting from 1.
 */
export function dedupeRows(rows) {
  const byText = new Map();
  for (const r of rows) {
    const sig = `${r.text}\n${r.about || ''}`;
    const unit = byText.get(sig);
    if (unit) unit.keys.push(r.key);
    else byText.set(sig, { text: r.text, about: r.about, group: r.group ?? null, groupLabel: r.groupLabel, keys: [r.key] });
  }
  return [...byText.values()].map((u, i) => ({ id: i + 1, ...u }));
}

/**
 * Packs units into batches of at most `max`, keeping each group (a device, a room, a dashboard view) together so
 * the AI sees related names side by side. A group larger than `max` is split; ungrouped units fill the gaps.
 */
export function packBatches(units, max = 30) {
  const groups = new Map();
  for (const u of units) {
    const g = u.group ?? null;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(u);
  }
  const chunks = [];
  for (const list of groups.values()) for (let i = 0; i < list.length; i += max) chunks.push(list.slice(i, i + max));
  // Largest first, then fill each batch with whatever still fits.
  chunks.sort((a, b) => b.length - a.length);
  const batches = [];
  for (const chunk of chunks) {
    const fit = batches.find((b) => b.length + chunk.length <= max);
    if (fit) fit.push(...chunk);
    else batches.push([...chunk]);
  }
  return batches;
}

/**
 * Prompt for translating units with any AI (Home Assistant's AI Task, or pasted into a chat by hand).
 * items: units from dedupeRows; glossary: [{ text, translation }] the user already has.
 * The reply is {"t": {id: translation}, "unsure": [ids]}, read by parseAiReply.
 */
export function buildTranslationPrompt({ from, to, fromName, toName, items, glossary = [] }) {
  const name = (n, code) => (n && n !== code ? `${n} (${code})` : code);
  const lines = [
    `Translate the labels of a Home Assistant smart-home app from ${name(fromName, from)} to ${name(toName, to)}: names of rooms, devices, sensors and controls, dashboard headings and state values.`,
    '',
    'Rules:',
    '1. Translate the meaning, not word for word. Integration names are often terse: use the group and "about" (type, unit, range, options) to work out what is meant. Write short, natural, grammatically correct labels.',
    "2. Keep brand, model and product names, codes and numbers as they are. Everyday abbreviations (AC, TV, est.) and unit symbols take the target language's usual form.",
    '3. Items in a device group are shown after the device name, unless "about" says "full name": translate only the given text, so that both read well together. A room at the end of a name is a qualifier: join it the way the language does, not as two capitalized words.',
    '4. Be consistent: the same word gets the same translation in every item and follows the glossary. Different texts in one group must not get the same translation.',
    "5. Keep ALL CAPS as ALL CAPS; otherwise use the language's usual capitalization for labels.",
    '6. Group names and "about" only describe the text. Never translate them.',
    '',
    'Terse names that are easy to get wrong:',
    '- "Distance reset", "Average speed start": readings since the last reset / since the trip started, not actions.',
    '- "Wetness" on a robot vacuum: how wet the mop is, not air humidity. "Route": the cleaning pattern.',
    '- "Eco away", "Frost": heating or cooling presets (eco while nobody is home; frost protection).',
    '- "Lock" as a car reading: the lock state. "Energy returned": energy fed back to the grid.',
  ];
  if (glossary.length) {
    lines.push(
      '',
      'Glossary: translations the user already has. Reuse these terms and their style.',
      JSON.stringify(Object.fromEntries(glossary.map((g) => [g.text, g.translation]))),
    );
  }
  // Grouped, each group named once.
  const groups = [];
  const index = new Map();
  for (const u of items) {
    const g = u.group ?? null;
    if (!index.has(g)) {
      index.set(g, { ...(u.groupLabel ? { group: u.groupLabel } : {}), items: [] });
      groups.push(index.get(g));
    }
    index.get(g).items.push(u.about ? { id: u.id, text: u.text, about: u.about } : { id: u.id, text: u.text });
  }
  lines.push(
    '',
    'Reply with only this JSON, no comments or code fences: {"t": {"<id>": "<translation>", ...}, "unsure": [<ids>]}. Every id must be in "t". List in "unsure" only the ids whose meaning you had to guess, usually none or a few.',
    '',
    // One line per item: compact for the model, still readable when pasted into a chat.
    groups.map((g) => `${g.group ? `Group: ${JSON.stringify(g.group)}` : 'No group'}\n${g.items.map((i) => JSON.stringify(i)).join('\n')}`).join('\n\n'),
  );
  return lines.join('\n');
}

/**
 * Reads a reply to buildTranslationPrompt: {"t": {...}, "unsure": [...]} or a plain {id: translation} object,
 * possibly wrapped in prose or code fences. A reply cut off in the middle still gives its complete pairs.
 * Returns { byId: {id: translation}, unsure: Set of ids }.
 */
export function parseAiReply(reply) {
  let data = reply && typeof reply === 'object' ? reply : null;
  if (!data) {
    const s = String(reply || '').replace(/```(?:json)?/gi, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    try {
      if (start >= 0 && end > start) data = JSON.parse(s.slice(start, end + 1));
    } catch (e) { /* cut off or malformed: salvage the pairs below */ }
    if (!data) {
      data = { t: {} };
      for (const m of s.matchAll(/"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        try { data.t[m[1]] = JSON.parse(`"${m[2]}"`); } catch (e) { /* skip a broken pair */ }
      }
    }
  }
  const map = data.t && typeof data.t === 'object' ? data.t : data;
  const byId = {};
  for (const [k, v] of Object.entries(map)) if (/^\d+$/.test(k) && typeof v === 'string' && v.trim()) byId[k] = v.trim();
  const unsure = new Set(Array.isArray(data.unsure) ? data.unsure.map(String) : []);
  return { byId, unsure };
}

/**
 * Marks suggestions worth a second look. rows: the tab's rows ({ key, original }); suggestions and saved:
 * key → text. Returns key → [reasons], for suggestions only.
 */
export function reviewSuggestions(rows, suggestions, saved = {}, unsure = new Set()) {
  const flags = {};
  const add = (key, reason) => { (flags[key] ||= []).push(reason); };
  const byTranslation = new Map();
  for (const r of rows) {
    const t = suggestions[r.key] || saved[r.key];
    if (!t) continue;
    const norm = t.trim().toLowerCase();
    if (!byTranslation.has(norm)) byTranslation.set(norm, new Set());
    byTranslation.get(norm).add(String(r.original).trim().toLowerCase());
  }
  for (const r of rows) {
    const t = suggestions[r.key];
    if (!t) continue;
    const original = String(r.original).trim();
    if (unsure.has(r.key)) add(r.key, 'AI unsure');
    if (byTranslation.get(t.trim().toLowerCase()).size > 1) add(r.key, 'same as another name');
    if (t.length > 3 * original.length + 10) add(r.key, 'much longer');
  }
  return flags;
}

/**
 * Reads an AI reply: a JSON object of key → translation, possibly wrapped in prose or code fences, or in the
 * Export format ({ translations: { lang: {...} } }). Only keys in `validKeys` with non-empty text are returned.
 */
export function parseTranslationReply(text, validKeys, language) {
  if (text && typeof text === 'object') return pickValid(text, validKeys, language);
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply.');
  let data;
  try {
    data = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error(`The reply is not valid JSON: ${e.message}`);
  }
  return pickValid(data, validKeys, language);
}

function pickValid(data, validKeys, language) {
  let map = data;
  if (map && map.translations && typeof map.translations === 'object') {
    map = language && map.translations[language] ? map.translations[language] : map.translations;
  }
  if (Array.isArray(map)) map = Object.fromEntries(map.filter((x) => x && x.key).map((x) => [x.key, x.translation ?? x.text]));
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (validKeys.has(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * Collects the visible strings and entity IDs of a dashboard config, for the editor. Strings longer than 200
 * characters or containing templates are skipped: exact-match translation cannot handle them.
 */
export function collectConfig(config, dashboard) {
  const strings = new Set();
  const entityIds = new Set();
  // Where each string appears: [{ dashboard, view, card, key }], at most 3 per string.
  const contexts = new Map();
  const isEntityId = (s) => /^[a-z_]+\.[a-z0-9_]+$/.test(s);
  const walk = (node, key, ctx) => {
    if (typeof node === 'string') {
      const s = node.trim();
      if (isEntityId(s) && (key === 'entity' || key === 'entities' || key === 'entity_id')) entityIds.add(s);
      else if (!ctx.noText && TEXT_KEYS.has(key) && s && s.length <= 200 && !/\{\{|\{%/.test(s) && !isEntityId(s)) {
        strings.add(s);
        if (!contexts.has(s)) contexts.set(s, []);
        const list = contexts.get(s);
        if (list.length < 3) list.push({ ...ctx, key });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((x, i) => {
        const inner = key === 'views' && x && typeof x === 'object' ? { ...ctx, view: x.title || x.path || `view ${i + 1}`, card: undefined } : ctx;
        walk(x, key === 'entities' ? 'entities' : key, inner);
      });
    } else if (node && typeof node === 'object') {
      let inner = ctx;
      if (key === 'sections') inner = { ...ctx, card: 'section' };
      else if (typeof node.type === 'string' && key !== 'views') inner = { ...ctx, card: node.type.replace(/^custom:/, '') };
      // Action data is still walked for entity IDs, but its strings are not text.
      for (const k of Object.keys(node)) walk(node[k], k, ACTION_DATA_KEYS.has(k) && !inner.noText ? { ...inner, noText: true } : inner);
    }
  };
  walk(config, undefined, { dashboard });
  return { strings, entityIds, contexts };
}

/** "dashboard "Home", view "Transport"": the place a dashboard string appears, for grouping and the AI. */
export const placeOf = (c) => [c.dashboard && `dashboard "${c.dashboard}"`, c.view && `view "${c.view}"`].filter(Boolean).join(', ');

/** "heading card, title", "view title": what a dashboard string is. */
export const roleOf = (c) => (c.card ? `${c.card} card, ${c.key}` : c.view ? `view ${c.key}` : `dashboard ${c.key}`);

// Keys of `dict` whose area, floor, device or entity no longer exists. `exists` maps a key type to a check by id;
// types without a check (dashboard text, state values) are never reported.
export function orphanKeys(dict, exists) {
  return Object.keys(dict || {}).filter((key) => {
    const i = key.indexOf(':');
    const check = exists[key.slice(0, i)];
    return Boolean(check) && !check(key.slice(i + 1));
  });
}
