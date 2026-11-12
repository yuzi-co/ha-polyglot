// Spins up throwaway HA containers on localhost, onboards them, installs Polyglot and seeds test data.
// Usage: node tools/ha-matrix.cjs up <version> <port> | down <version>   (needs Docker)
// Test instances live in <tmp>/polyglot-ha-test/<version>; session.json there holds the local test tokens.
// Browser part: run tools/serve-test.cjs, log in by evaluating /<version>/inject.js in the page, open /pg-test/main,
// then evaluate /check.js (tools/browser-check.js). Tested so far: 2026.3.0, 2026.6.0, 2026.9.0, 2026.11.1.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(require('os').tmpdir(), 'polyglot-ha-test');
const SRC = path.join(__dirname, '..', 'custom_components', 'polyglot');
const [cmd, version, portArg] = process.argv.slice(2);
const name = `hapg-${version.replace(/\./g, '-')}`;
const dir = path.join(ROOT, version);
const port = Number(portArg);
const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (f === '__pycache__') continue;
    const a = path.join(from, f);
    const b = path.join(to, f);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

async function ws(token) {
  const sock = new WebSocket(`ws://localhost:${port}/api/websocket`);
  let id = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    sock.onerror = () => reject(new Error('ws error'));
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') sock.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_ok') resolve();
      else if (m.type === 'auth_invalid') reject(new Error('auth invalid'));
      else if (m.type === 'result') {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.success ? p.resolve(m.result) : p.reject(new Error(JSON.stringify(m.error))); }
      }
    };
  });
  return {
    call: (msg) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); sock.send(JSON.stringify({ id: i, ...msg })); }),
    close: () => sock.close(),
  };
}

async function up() {
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(SRC, path.join(dir, 'custom_components', 'polyglot'));
  fs.writeFileSync(path.join(dir, 'configuration.yaml'), 'default_config:\ndemo:\n');
  try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (e) { /* not running */ }
  execFileSync('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8123`, '-e', 'TZ=Europe/Sofia',
    '-v', `${dir.replace(/\\/g, '/')}:/config`, `ghcr.io/home-assistant/home-assistant:${version}`]);

  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${base}/api/onboarding`); if (r.ok) break; } catch (e) { /* starting */ }
    await sleep(2000);
  }
  const clientId = `${base}/`;
  const password = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(path.join(dir, 'test-login.txt'), `user: tester\npassword: ${password}\n`);
  let r = await fetch(`${base}/api/onboarding/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, name: 'Tester', username: 'tester', password, language: 'en' }) });
  const { auth_code } = await r.json();
  r = await fetch(`${base}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: auth_code, client_id: clientId }) });
  const tokens = await r.json();
  const auth = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' };
  for (const step of ['core_config', 'analytics']) await fetch(`${base}/api/onboarding/${step}`, { method: 'POST', headers: auth, body: '{}' });
  await fetch(`${base}/api/onboarding/integration`, { method: 'POST', headers: auth, body: JSON.stringify({ client_id: clientId, redirect_uri: `${base}/?auth_callback=1` }) });

  // Wait for the demo integration's entities.
  for (let i = 0; i < 60; i++) {
    const s = await (await fetch(`${base}/api/states`, { headers: auth })).json();
    if (Array.isArray(s) && s.some((x) => x.entity_id.startsWith('light.'))) break;
    await sleep(2000);
  }
  let f = await (await fetch(`${base}/api/config/config_entries/flow`, { method: 'POST', headers: auth, body: JSON.stringify({ handler: 'polyglot' }) })).json();
  if (f.type === 'form') f = await (await fetch(`${base}/api/config/config_entries/flow/${f.flow_id}`, { method: 'POST', headers: auth, body: '{}' })).json();
  const result = { version, flow: f.type };

  const ha = await ws(tokens.access_token);
  const area = await ha.call({ type: 'config/area_registry/create', name: 'Living Room' }).catch(async () =>
    (await ha.call({ type: 'config/area_registry/list' })).find((a) => a.name === 'Living Room'));
  const ents = (await ha.call({ type: 'config/entity_registry/list' })).filter((e) => e.device_id && e.entity_id.startsWith('light.'));
  const light = ents[0];
  await ha.call({ type: 'config/device_registry/update', device_id: light.device_id, area_id: area.area_id });
  const dev = (await ha.call({ type: 'config/device_registry/list' })).find((d) => d.id === light.device_id);
  await ha.call({ type: 'polyglot/set_many', language: 'ru', values: {
    [`area:${area.area_id}`]: 'Гостиная',
    [`device:${dev.id}`]: 'Тестовая лампа',
    'text:Test heading': 'Тестовый заголовок',
  } });
  await ha.call({ type: 'lovelace/dashboards/create', url_path: 'pg-test', title: 'PG test', mode: 'storage', require_admin: false, show_in_sidebar: true }).catch(() => {});
  await ha.call({ type: 'lovelace/config/save', url_path: 'pg-test', config: { views: [{ title: 'Main', path: 'main', cards: [
    { type: 'heading', heading: 'Test heading' },
    { type: 'tile', entity: light.entity_id },
    { type: 'markdown', content: "LANG={{ language if language is defined else 'none' }}" },
  ] }] } });
  ha.close();
  Object.assign(result, { area: area.area_id, light: light.entity_id, device: dev.id, deviceName: dev.name_by_user || dev.name });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ base, clientId, tokens, ...result }, null, 1));
  const tok = { access_token: tokens.access_token, token_type: 'Bearer', expires_in: tokens.expires_in, refresh_token: tokens.refresh_token, hassUrl: base, clientId, expires: Date.now() + tokens.expires_in * 1000 };
  fs.writeFileSync(path.join(dir, 'inject.js'), `localStorage.setItem('hassTokens', ${JSON.stringify(JSON.stringify(tok))}); window.__pgSession = ${JSON.stringify({ area: result.area, device: result.device, light: result.light })}; 'ok'`);
  console.log(JSON.stringify(result));
}

if (cmd === 'up') up().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
else if (cmd === 'down') { try { execFileSync('docker', ['rm', '-f', name]); } catch (e) { /* gone */ } console.log('removed', name); }
