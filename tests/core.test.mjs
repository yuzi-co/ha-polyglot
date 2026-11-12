// Run with: node --test tests/
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectConfig, createTranslator, mapRecord, pickLanguage, translateConfig, untranslateConfig } from '../custom_components/polyglot/frontend/core.js';

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
