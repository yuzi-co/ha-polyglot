// Runs the editor's AI translation on tools/ai-eval/cases.json through a Home Assistant AI Task, the same way the
// panel does (same grouping, batches and prompt), and writes a review sheet. Optionally asks a second AI to mark
// each translation, so prompt changes can be compared by error counts rather than by taste.
//
//   HA_URL=https://ha.example HA_TOKEN=... node tools/ai-eval/run.mjs --to ru --entity ai_task.x [--judge ai_task.y]
//
// The sheet (tools/ai-eval/out/<time>-<lang>.tsv) has one row per case: text, context, translation, automatic
// flags and the judge's verdict. Hand it to a native speaker for the final word.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTranslationPrompt, dedupeRows, packBatches, parseAiReply, reviewSuggestions,
} from '../../custom_components/polyglot/frontend/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const to = arg('to', 'ru');
const entity = arg('entity');
const judge = arg('judge');
const { HA_URL, HA_TOKEN } = process.env;
if (!HA_URL || !HA_TOKEN || !entity) {
  console.error('Usage: HA_URL=... HA_TOKEN=... node tools/ai-eval/run.mjs --to ru --entity ai_task.x [--judge ai_task.y]');
  process.exit(2);
}

// Minimal Home Assistant WebSocket client (Node 22+ has WebSocket built in).
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${HA_URL.replace(/^http/, 'ws')}/api/websocket`);
    let id = 0;
    const pending = new Map();
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message || e.type}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      else if (msg.type === 'auth_invalid') reject(new Error('Token rejected'));
      else if (msg.type === 'auth_ok') {
        resolve({
          call: (m) => new Promise((res, rej) => {
            id += 1;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ ...m, id }));
          }),
          close: () => ws.close(),
        });
      } else if (msg.type === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.success) p.res(msg.result);
        else p.rej(new Error(msg.error ? msg.error.message : 'failed'));
      }
    };
  });
}

const ask = async (ha, entity_id, instructions) => {
  const res = await ha.call({
    type: 'call_service', domain: 'ai_task', service: 'generate_data', return_response: true,
    service_data: { task_name: 'Polyglot eval', entity_id, instructions },
  });
  return res && res.response ? res.response.data : undefined;
};

const { rows } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const ha = await connect();
const units = dedupeRows(rows);
const queue = packBatches(units, 30);
const translations = {};
const unsure = new Set();
const started = Date.now();
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    const prompt = buildTranslationPrompt({ from: 'en', to, fromName: 'English', toName: new Intl.DisplayNames(['en'], { type: 'language' }).of(to), items: batch });
    const reply = parseAiReply(await ask(ha, entity, prompt));
    for (const u of batch) {
      if (!reply.byId[u.id]) continue;
      for (const key of u.keys) {
        translations[key] = reply.byId[u.id];
        if (reply.unsure.has(String(u.id))) unsure.add(key);
      }
    }
  }
}));
const seconds = Math.round((Date.now() - started) / 1000);
const flags = reviewSuggestions(rows.map((r) => ({ key: r.key, original: r.text })), translations, {}, unsure);

// Second opinion: another AI marks each translation.
let verdicts = {};
if (judge) {
  const list = rows.filter((r) => translations[r.key]).map((r, i) => ({ id: i + 1, key: r.key, text: r.text, group: r.groupLabel, about: r.about, translation: translations[r.key] }));
  const prompt = [
    `You review translations of Home Assistant smart-home labels from English to ${to}, as a native speaker would.`,
    'For each item answer "ok", or "wrong: <why>" when the meaning is wrong or misleading, or "awkward: <why>" when the meaning is right but a native speaker would not write it that way (grammar, style, inconsistency with the other items).',
    'Group and about describe where the label appears. Entity names are shown after their device name.',
    'Intended, not errors: ALL CAPS kept from the original; brand, model and product names kept as they are; short labels.',
    'Only suggest a change you are sure a native speaker would make. When unsure, answer "ok".',
    'Reply with only JSON: {"<id>": "<verdict>", ...}',
    '',
    list.map(({ key, ...rest }) => JSON.stringify(rest)).join('\n'),
  ].join('\n');
  const reply = parseAiReply(await ask(ha, judge, prompt));
  for (const item of list) verdicts[item.key] = reply.byId[item.id] || '';
}
ha.close();

const cell = (s) => String(s ?? '').replace(/[\t\n]/g, ' ');
const lines = [['text', 'context', 'translation', 'flags', 'judge'].join('\t')];
for (const r of rows) {
  lines.push([r.text, [r.groupLabel, r.about].filter(Boolean).join(' | '), translations[r.key] || '(none)', (flags[r.key] || []).join(', '), verdicts[r.key] || ''].map(cell).join('\t'));
}
mkdirSync(join(here, 'out'), { recursive: true });
const file = join(here, 'out', `${new Date().toISOString().replace(/[:.]/g, '-')}-${to}.tsv`);
writeFileSync(file, `${lines.join('\n')}\n`);

const v = Object.values(verdicts);
console.log(`${Object.keys(translations).length}/${rows.length} translated in ${seconds} s, ${Object.keys(flags).length} flagged`);
if (judge) console.log(`judge: ${v.filter((x) => /^ok/i.test(x)).length} ok, ${v.filter((x) => /^awkward/i.test(x)).length} awkward, ${v.filter((x) => /^wrong/i.test(x)).length} wrong`);
console.log(file);
