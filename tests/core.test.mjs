// Run with: node --test tests/
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoNames, buildTranslationPrompt, collectConfig, createTranslator, dedupeRows, mapRecord, packBatches, parseAiReply, parseTranslationReply, pickGlossary, pickLanguage, placeOf, restoreConfig, reviewSuggestions, roleOf, strategyCount, translateConfig, untranslateConfig } from '../custom_components/polyglot/frontend/core.js';

test('pickLanguage', () => {
  assert.equal(pickLanguage('ru', 'en', ['ru']), 'ru');
  assert.equal(pickLanguage('en', 'en', ['ru']), null);
  assert.equal(pickLanguage('en-GB', 'en', ['ru']), null);
  assert.equal(pickLanguage('pt-BR', 'en', ['pt']), 'pt');
  assert.equal(pickLanguage('de', 'en', ['ru']), null);
  assert.equal(pickLanguage(undefined, 'en', ['ru']), null);
});

test('mapRecord keeps the reference when nothing changes', () => {
  const rec = { a: { n: 1 }, b: { n: 2 } };
  assert.equal(mapRecord(rec, (v) => v), rec);
  const out = mapRecord(rec, (v, k) => (k === 'b' ? { n: 3 } : v));
  assert.notEqual(out, rec);
  assert.equal(out.a, rec.a);
  assert.deepEqual(out.b, { n: 3 });
});

const entities = {
  'light.bar_lamp': { entity_id: 'light.bar_lamp', device_id: 'd1', has_entity_name: true, name: undefined },
  'sensor.pax_humidity': { entity_id: 'sensor.pax_humidity', device_id: 'd2', has_entity_name: true, name: 'Humidity' },
  'sensor.legacy': { entity_id: 'sensor.legacy', has_entity_name: false, name: 'Legacy thing' },
  'sensor.custom': { entity_id: 'sensor.custom', device_id: 'd2', has_entity_name: true, name: 'Humidity' },
  // Current frontends: next_name_part instead of has_entity_name.
  'sensor.room_temp': { entity_id: 'sensor.room_temp', device_id: 'd2', next_name_part: 'device', name: 'Temperature' },
};
const devices = { d1: { id: 'd1', name: 'Bar lamp' }, d2: { id: 'd2', name: 'Pax', name_by_user: 'Bathroom fan' } };
const st = (id, fn) => ({ entity_id: id, state: 'on', attributes: { friendly_name: fn } });

test('registries are translated', () => {
  const tr = createTranslator({ 'area:living_room': 'Гостиная', 'device:d1': 'Барная лампа', 'entity:sensor.pax_humidity': 'Влажность', 'floor:f1': 'Этаж' });
  assert.equal(tr.area({ area_id: 'living_room', name: 'Living room' }).name, 'Гостиная');
  const kitchen = { area_id: 'kitchen', name: 'Kitchen' };
  assert.equal(tr.area(kitchen), kitchen);
  assert.equal(tr.floor({ floor_id: 'f1', name: 'Ground' }).name, 'Этаж');
  assert.equal(tr.device(devices.d1).name_by_user, 'Барная лампа');
  assert.equal(tr.entity(entities['sensor.pax_humidity']).name, 'Влажность');
  // No own name: nothing to translate at entity level.
  assert.equal(tr.entity(entities['light.bar_lamp']), entities['light.bar_lamp']);
});

test('friendly_name is rebuilt from translated parts', () => {
  const tr = createTranslator({ 'device:d1': 'Барная лампа', 'device:d2': 'Вытяжка', 'entity:sensor.pax_humidity': 'влажность', 'entity:sensor.legacy': 'Старое' });
  assert.equal(tr.state(st('light.bar_lamp', 'Bar lamp'), entities, devices).attributes.friendly_name, 'Барная лампа');
  assert.equal(tr.state(st('sensor.pax_humidity', 'Bathroom fan Humidity'), entities, devices).attributes.friendly_name, 'Вытяжка влажность');
  assert.equal(tr.state(st('sensor.legacy', 'Legacy thing'), entities, devices).attributes.friendly_name, 'Старое');
  assert.equal(tr.state(st('sensor.room_temp', 'Bathroom fan Temperature'), entities, devices).attributes.friendly_name, 'Вытяжка Temperature');
  // friendly_name not composed the expected way and no own translation: unchanged.
  const odd = st('sensor.custom', 'Something else');
  assert.equal(tr.state(odd, entities, devices), odd);
  const untouched = st('switch.x', 'X');
  assert.equal(tr.state(untouched, entities, devices), untouched);
});

test('state values', () => {
  const tr = createTranslator({ 'state:Sweeping and mopping': 'Пылесос и швабра', 'state:recirculation': 'Рециркуляция' });
  assert.equal(tr.stateText('Sweeping and mopping'), 'Пылесос и швабра');
  assert.equal(tr.stateText('Off'), 'Off');
  const parts = [{ type: 'value', value: 'recirculation' }, { type: 'unit', value: 'recirculation' }];
  const out = tr.stateParts(parts);
  assert.equal(out[0].value, 'Рециркуляция');
  assert.equal(out[1], parts[1]);
  const plain = [{ type: 'value', value: '21' }];
  assert.equal(tr.stateParts(plain), plain);
});

test('empty dictionary is a no-op', () => {
  const tr = createTranslator({});
  assert.equal(tr.has, false);
  const s = st('light.bar_lamp', 'Bar lamp');
  assert.equal(tr.state(s, entities, devices), s);
  assert.equal(tr.text('Living room'), 'Living room');
});

test('dashboard config: exact visible strings only', () => {
  const tr = createTranslator({ 'text:Living room': 'Гостиная', 'text:light.bar_lamp': 'nope', 'text:tile': 'nope' });
  const cfg = {
    title: 'Home',
    views: [{
      title: 'Living room',
      sections: [{ cards: [
        { type: 'tile', entity: 'light.bar_lamp', name: 'Living room' },
        { type: 'heading', heading: ' Living room ' },
        { type: 'entities', entities: ['light.bar_lamp', { entity: 'light.bar_lamp', name: 'Living room' }] },
      ] }],
    }],
  };
  const out = translateConfig(cfg, tr.text);
  assert.equal(out.title, 'Home');
  assert.equal(out.views[0].title, 'Гостиная');
  const cards = out.views[0].sections[0].cards;
  assert.equal(cards[0].type, 'tile');
  assert.equal(cards[0].entity, 'light.bar_lamp');
  assert.equal(cards[0].name, 'Гостиная');
  assert.equal(cards[1].heading, 'Гостиная');
  assert.equal(cards[2].entities[0], 'light.bar_lamp');
  assert.equal(cards[2].entities[1].name, 'Гостиная');
  // Untouched config keeps its reference.
  const same = { title: 'Home' };
  assert.equal(translateConfig(same, tr.text), same);
});

test('untranslateConfig restores originals on save', () => {
  const dict = { 'text:Living room': 'Гостиная', 'text:Living Room': 'Гостиная', 'text:Kitchen': 'Кухня', 'entity:x.y': 'Кухня' };
  const cfg = { views: [{ title: 'Кухня', cards: [{ type: 'tile', name: 'Гостиная', entity: 'light.x' }, { type: 'heading', heading: 'Своё' }] }] };
  const out = untranslateConfig(cfg, dict);
  assert.equal(out.views[0].title, 'Kitchen');
  // Two originals share "Гостиная": ambiguous, left as typed.
  assert.equal(out.views[0].cards[0].name, 'Гостиная');
  assert.equal(out.views[0].cards[1].heading, 'Своё');
  assert.equal(untranslateConfig(cfg, {}), cfg);
});

test('dedupe and batches keep groups together', () => {
  const rows = [
    { key: 'entity:a.energy_returned', text: 'Energy returned', about: 'sensor', group: 'd1', groupLabel: 'Boiler' },
    { key: 'entity:b.energy_returned', text: 'Energy returned', about: 'sensor', group: 'd2', groupLabel: 'Dryer' },
    { key: 'entity:b.power', text: 'Power', about: 'sensor', group: 'd2', groupLabel: 'Dryer' },
    { key: 'entity:c.lock', text: 'Lock', about: 'lock' },
    { key: 'entity:d.lock', text: 'Lock', about: 'sensor' },
  ];
  const units = dedupeRows(rows);
  assert.equal(units.length, 4);
  assert.deepEqual(units[0].keys, ['entity:a.energy_returned', 'entity:b.energy_returned']);
  assert.deepEqual(units.map((u) => u.id), [1, 2, 3, 4]);
  const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, text: `x${i}`, group: i < 4 ? 'big' : i < 6 ? 'small' : null }));
  const batches = packBatches(many, 5);
  // The group of 4 and the group of 2 never share a batch of 5 with a split; the single fills a gap.
  assert.deepEqual(batches.map((b) => b.map((u) => u.id)), [[1, 2, 3, 4, 7], [5, 6]]);
  assert.deepEqual(packBatches(Array.from({ length: 7 }, (_, i) => ({ id: i, group: 'g' })), 3).map((b) => b.length), [3, 3, 1]);
});

test('AI reply parsing and review flags', () => {
  assert.deepEqual(parseAiReply('ok:\n```json\n{"t": {"1": " Бар ", "2": ""}, "unsure": [3]}\n```'), { byId: { 1: 'Бар' }, unsure: new Set(['3']) });
  assert.deepEqual(parseAiReply({ 1: 'Бар' }).byId, { 1: 'Бар' });
  // Cut off mid-reply: the complete pairs survive.
  assert.deepEqual(parseAiReply('{"t": {"1": "Бар", "2": "Кухня \\"А\\"", "3": "Сп').byId, { 1: 'Бар', 2: 'Кухня "А"' });
  const rows = [
    { key: 'entity:h', original: 'Humidity' }, { key: 'entity:w', original: 'Wetness' },
    { key: 'device:a', original: 'AdGuard' }, { key: 'text:x', original: 'Bar' }, { key: 'text:y', original: 'OK' },
  ];
  const flags = reviewSuggestions(rows, { 'entity:w': 'Влажность', 'device:a': 'AdGuard', 'text:x': 'Барная стойка в гостиной комнате', 'text:y': 'OK' }, { 'entity:h': 'влажность' }, new Set(['text:x']));
  assert.deepEqual(flags, {
    'entity:w': ['same as another name'], 'text:x': ['AI unsure', 'much longer'],
  });
});

test('translation prompt and reply parsing', () => {
  const items = dedupeRows([
    { key: 'area:living_room', text: 'Living Room', about: 'room name' },
    { key: 'text:Bar', text: 'Bar', group: 'v', groupLabel: 'dashboard "Home", view "Rooms"' },
  ]);
  const prompt = buildTranslationPrompt({ from: 'en', to: 'ru', fromName: 'English', toName: 'Russian', items });
  assert.match(prompt, /from English \(en\) to Russian \(ru\)/);
  assert.match(prompt, /No group\n\{"id":1,"text":"Living Room","about":"room name"\}/);
  assert.match(prompt, /Group: "dashboard \\"Home\\", view \\"Rooms\\""\n\{"id":2,"text":"Bar"\}/);
  assert.doesNotMatch(prompt, /"about": undefined/);
  assert.doesNotMatch(prompt, /Glossary/);
  const glossary = pickGlossary(
    [{ text: 'Living room lamp' }, { text: 'Bar' }],
    [
      { text: 'Bar', translation: 'Бар' },
      { text: 'Kitchen lamp', translation: 'Лампа на кухне' },
      { text: 'Bathroom', translation: 'Ванная' },
      { text: 'Living room', translation: 'Гостиная' },
      { text: 'Living room', translation: 'Зал' },
      { text: 'The fan', translation: 'Вентилятор' },
    ],
  );
  assert.deepEqual(glossary.map((g) => g.text), ['Bar', 'Living room', 'Kitchen lamp']);
  assert.equal(glossary[1].translation, 'Гостиная');
  assert.match(buildTranslationPrompt({ from: 'en', to: 'ru', items, glossary }), /Glossary[^]*"Bar":"Бар"/);
  const valid = new Set(['area:living_room', 'text:Bar']);
  // Prose and code fences around the JSON, an unknown key, an empty value.
  const reply = 'Here you go:\n```json\n{"area:living_room": " Гостиная ", "text:Bar": "", "area:other": "x"}\n```';
  assert.deepEqual(parseTranslationReply(reply, valid), { 'area:living_room': 'Гостиная' });
  // Export format and the array form.
  assert.deepEqual(parseTranslationReply('{"translations": {"ru": {"text:Bar": "Бар"}}}', valid, 'ru'), { 'text:Bar': 'Бар' });
  assert.deepEqual(parseTranslationReply([{ key: 'text:Bar', translation: 'Бар' }], valid), { 'text:Bar': 'Бар' });
  assert.throws(() => parseTranslationReply('no json here', valid), /No JSON/);
  assert.throws(() => parseTranslationReply('{"a": }', valid), /not valid JSON/);
});

test('collectConfig finds strings and entity IDs', () => {
  const { strings, entityIds } = collectConfig({
    title: 'Home',
    views: [{ title: 'Rooms', cards: [
      { type: 'tile', entity: 'light.bar_lamp', name: 'Bar' },
      { type: 'markdown', content: 'Hi {{ user }}' },
      { type: 'entities', entities: ['sensor.a', { entity: 'sensor.b' }] },
    ] }],
  });
  assert.deepEqual([...strings].sort(), ['Bar', 'Home', 'Rooms']);
  assert.deepEqual([...entityIds].sort(), ['light.bar_lamp', 'sensor.a', 'sensor.b']);
});

test('collectConfig records where strings appear', () => {
  const { contexts } = collectConfig({
    views: [
      { title: 'Transport', sections: [{ type: 'grid', title: 'Buses', cards: [{ type: 'custom:mushroom-title-card', title: '> TRANSIT' }] }] },
      { path: 'other', cards: [{ type: 'tile', entity: 'light.x', name: '> TRANSIT' }] },
    ],
  }, 'Home');
  const at = contexts.get('> TRANSIT');
  assert.deepEqual(at.map((c) => [placeOf(c), roleOf(c)]), [
    ['dashboard "Home", view "Transport"', 'mushroom-title-card card, title'],
    ['dashboard "Home", view "other"', 'tile card, name'],
  ]);
  assert.equal(roleOf(contexts.get('Buses')[0]), 'section card, title');
  assert.equal(roleOf(contexts.get('Transport')[0]), 'view title');
});

test('an unchanged state keeps its translated object across updates', () => {
  const tr = createTranslator({ 'entity:light.a': 'Свет', 'device:d1': 'Лампа' });
  const a = { entity_id: 'light.a', attributes: { friendly_name: 'Light' } };
  const entities = { 'light.a': { entity_id: 'light.a', device_id: 'd1' } };
  const devices = { d1: { id: 'd1', name: 'Lamp' } };
  const first = tr.state(a, entities, devices);
  assert.equal(first.attributes.friendly_name, 'Свет');
  assert.equal(tr.state(a, entities, devices), first);
  // Another record object with the same entries (another entity changed): still the same result object.
  assert.equal(tr.state(a, { ...entities }, { ...devices }), first);
  // Its registry entry changed: translated again.
  const renamed = { 'light.a': { entity_id: 'light.a', device_id: 'd1', name: 'x' } };
  assert.notEqual(tr.state(a, renamed, devices), first);
  // A state with nothing to translate is returned as it is, every time.
  const b = { entity_id: 'light.b', attributes: { friendly_name: 'B' } };
  assert.equal(tr.state(b, entities, devices), b);
});

test('action data is neither translated nor listed', () => {
  const tr = createTranslator({ 'text:Kitchen': 'Кухня' });
  const config = {
    title: 'Kitchen',
    tap_action: { action: 'perform-action', data: { message: 'Kitchen', name: 'Kitchen' }, target: { entity_id: 'light.k', label: 'Kitchen' } },
    hold_action: { service_data: { title: 'Kitchen' }, confirmation: { text: 'Kitchen' } },
  };
  const out = translateConfig(config, tr.text);
  assert.equal(out.title, 'Кухня');
  assert.equal(out.tap_action, config.tap_action);
  assert.equal(out.hold_action.service_data, config.hold_action.service_data);
  assert.equal(out.hold_action.confirmation.text, 'Кухня');
  // Saving leaves action data as typed, even when it equals a translation.
  const typed = { tap_action: { data: { message: 'Кухня' } } };
  assert.equal(untranslateConfig(typed, { 'text:Kitchen': 'Кухня' }), typed);
  const found = collectConfig({ views: [{ cards: [{ type: 'button', tap_action: { data: { message: 'Only in data' }, target: { entity_id: 'light.k' } } }] }] }, 'Home');
  assert.equal(found.strings.has('Only in data'), false);
  assert.equal(found.entityIds.has('light.k'), true);
});

test('restoreConfig and strategyCount: taking control of a generated dashboard', () => {
  const pairs = [['Кухня', 'Kitchen'], ['Свет', 'Light'], ['Свет', 'Lamp']];
  const out = restoreConfig({ views: [{ title: 'Кухня', cards: [{ type: 'heading', heading: ' Кухня ', name: 'Свет', entity: 'light.k' }] }] }, pairs);
  assert.equal(out.views[0].title, 'Kitchen');
  assert.equal(out.views[0].cards[0].heading, 'Kitchen');
  // Two originals share this translation: left as shown.
  assert.equal(out.views[0].cards[0].name, 'Свет');
  const same = { title: 'Other' };
  assert.equal(restoreConfig(same, pairs), same);
  assert.equal(strategyCount(undefined), 0);
  assert.equal(strategyCount({ views: [{ title: 'a' }] }), 0);
  assert.equal(strategyCount({ strategy: { type: 'original-states' } }), 1);
  assert.equal(strategyCount({ views: [{ strategy: { type: 'area' } }, { title: 'a' }] }), 1);
});

test('autoNames: integration and device class names in the viewer language', () => {
  const from = {
    'component.demo.entity.sensor.filter_life.name': 'Filter life',
    'component.demo.entity.sensor.zone_temp.name': '{zone} temperature',
    'component.sensor.entity_component.battery.name': 'Battery',
    'component.switch.entity_component._.name': 'Switch',
  };
  const to = {
    'component.demo.entity.sensor.filter_life.name': 'Ресурс фильтра',
    'component.demo.entity.sensor.zone_temp.name': 'Температура {zone}',
    'component.sensor.entity_component.battery.name': 'Батарея',
    'component.switch.entity_component._.name': 'Switch',
  };
  const entities = {
    'sensor.a': { entity_id: 'sensor.a', platform: 'demo', translation_key: 'filter_life', name: 'Filter life' },
    'sensor.renamed': { entity_id: 'sensor.renamed', platform: 'demo', translation_key: 'filter_life', name: 'HEPA' },
    'sensor.zone': { entity_id: 'sensor.zone', platform: 'demo', translation_key: 'zone_temp', name: 'Hall temperature' },
    'sensor.batt': { entity_id: 'sensor.batt', platform: 'other', name: 'Battery' },
    'sensor.noname': { entity_id: 'sensor.noname', platform: 'demo', translation_key: 'filter_life' },
    'switch.same': { entity_id: 'switch.same', platform: 'other', name: 'Switch' },
  };
  const states = { 'sensor.batt': { entity_id: 'sensor.batt', attributes: { device_class: 'battery' } } };
  assert.deepEqual(autoNames(entities, states, from, to), {
    'entity:sensor.a': 'Ресурс фильтра',
    'entity:sensor.batt': 'Батарея',
  });
  assert.deepEqual(autoNames(entities, states, from, undefined), {});
});

test('translator falls back to automatic names, the dictionary wins', () => {
  const auto = { 'entity:sensor.a': 'Ресурс фильтра', 'entity:sensor.b': 'Батарея' };
  const tr = createTranslator({ 'entity:sensor.b': 'Аккумулятор' }, auto);
  assert.equal(tr.entity({ entity_id: 'sensor.a', name: 'Filter life' }).name, 'Ресурс фильтра');
  assert.equal(tr.entity({ entity_id: 'sensor.b', name: 'Battery' }).name, 'Аккумулятор');
  // Automatic names alone make a working translator, and compose with the device name.
  const only = createTranslator({}, auto);
  assert.equal(only.has, true);
  const s = { entity_id: 'sensor.a', attributes: { friendly_name: 'Purifier Filter life' } };
  const entities = { 'sensor.a': { entity_id: 'sensor.a', device_id: 'd1', name: 'Filter life', next_name_part: 'device' } };
  assert.equal(only.state(s, entities, { d1: { id: 'd1', name: 'Purifier' } }).attributes.friendly_name, 'Purifier Ресурс фильтра');
  assert.equal(createTranslator({}, {}).has, false);
});
