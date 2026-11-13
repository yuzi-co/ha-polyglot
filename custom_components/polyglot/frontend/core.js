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

/** Builds the translator for one dictionary. Each helper returns its input unchanged when it has nothing to do. */
export function createTranslator(dict) {
  const has = dict && Object.keys(dict).length > 0;
  const t = (key) => (has ? dict[key] : undefined);

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

  const state = (stateObj, entities, devices) => {
    if (!has || !stateObj || !stateObj.attributes) return stateObj;
    const current = stateObj.attributes.friendly_name;
    const name = friendlyName(stateObj, entities, devices);
    if (!name || name === current) return stateObj;
    return { ...stateObj, attributes: { ...stateObj.attributes, friendly_name: name } };
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

// Config keys that hold visible text in core and popular custom cards. Only these are translated, so IDs, options
// and entity IDs can never be changed, even if someone adds them to the dictionary.
export const TEXT_KEYS = new Set([
  'name', 'title', 'heading', 'subtitle', 'label', 'primary', 'secondary', 'content', 'text', 'placeholder',
  'caption', 'description', 'message',
]);

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
  const inverse = new Map();
  const ambiguous = new Set();
  for (const [key, value] of Object.entries(dict || {})) {
    if (!key.startsWith('text:') || typeof value !== 'string') continue;
    const original = key.slice(5);
    if (inverse.has(value) && inverse.get(value) !== original) ambiguous.add(value);
    else inverse.set(value, original);
  }
  for (const v of ambiguous) inverse.delete(v);
  if (!inverse.size) return config;
  return translateConfig(config, (s) => (inverse.has(s.trim()) ? inverse.get(s.trim()) : s));
}

/**
 * Prompt for translating editor rows with any AI (Home Assistant's AI Task, or pasted into a chat by hand).
 * items: [{ key, text, about }]. The reply is a JSON object mapping each key to its translation.
 */
export function buildTranslationPrompt({ from, to, fromName, toName, items }) {
  const name = (n, code) => (n && n !== code ? `${n} (${code})` : code);
  return [
    `Translate names shown in a Home Assistant smart-home app from ${name(fromName, from)} to ${name(toName, to)}.`,
    '',
    'Rules:',
    '- Short, natural labels, the way a native speaker would expect them on a home dashboard. Not word for word.',
    '- Keep brand, model and product names, codes, numbers and units unchanged (for example "PAX Calima", "X40 Ultra", "PM2.5").',
    '- Many entity names are shown after their device name ("Breezer" + "Air mode"): translate only the given part, so that both read well together.',
    "- Use the target language's usual capitalization for labels.",
    '- "about" says what the text is and where it appears. Use it to choose the right meaning; do not translate it.',
    '',
    'Reply with only a JSON object that maps every "key" below to its translation. No comments, no code fences.',
    '',
    JSON.stringify(items.map(({ key, text, about }) => (about ? { key, text, about } : { key, text })), null, 1),
  ].join('\n');
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
export function collectConfig(config) {
  const strings = new Set();
  const entityIds = new Set();
  const isEntityId = (s) => /^[a-z_]+\.[a-z0-9_]+$/.test(s);
  const walk = (node, key) => {
    if (typeof node === 'string') {
      const s = node.trim();
      if (isEntityId(s) && (key === 'entity' || key === 'entities' || key === 'entity_id')) entityIds.add(s);
      else if (TEXT_KEYS.has(key) && s && s.length <= 200 && !/\{\{|\{%/.test(s) && !isEntityId(s)) strings.add(s);
      return;
    }
    if (Array.isArray(node)) node.forEach((x) => walk(x, key === 'entities' ? 'entities' : key));
    else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], k);
  };
  walk(config, undefined);
  return { strings, entityIds };
}
