// Pasted into the page (via the browser tool) after login. Switches this tab to Russian without saving, opts the
// admin into dashboard text, and reports what Polyglot did. Expects window.__pgSession = { area, device, light }.
(async () => {
  const S = window.__pgSession;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = document.querySelector('home-assistant');
  const deep = (pred) => { const st = [el]; const out = []; while (st.length) { const n = st.pop(); if (!n) continue; if (pred(n)) out.push(n); if (n.shadowRoot) st.push(n.shadowRoot); for (const c of n.children || []) st.push(c); } return out; };
  const res = { haVersion: el.hass.config.version, overlay: !!window.__polyglot };
  await el.hass.connection.sendMessagePromise({ type: 'frontend/set_user_data', key: 'polyglot', value: { dashboard_text_for_admin: true } });
  el._selectLanguage('ru', false);
  await sleep(6000);
  const h = el.hass;
  Object.assign(res, {
    language: window.__polyglot && window.__polyglot.language,
    active: window.__polyglot && window.__polyglot.active,
    area: h.areas[S.area] && h.areas[S.area].name,
    device: h.devices[S.device] && (h.devices[S.device].name_by_user || h.devices[S.device].name),
    friendly: h.states[S.light].attributes.friendly_name,
    formatName: h.formatEntityName ? h.formatEntityName(h.states[S.light]) : 'n/a',
    heading: deep((n) => n.tagName === 'HUI-HEADING-CARD').map((n) => n.shadowRoot.textContent.replace(/\s+/g, ' ').trim()).join('|'),
    markdown: deep((n) => n.tagName === 'HA-MARKDOWN').map((n) => (n.shadowRoot || n).textContent.trim()).join('|'),
  });
  // Dialog swap: a capture listener added after Polyglot's sees the params it left, then stops the event.
  const params = { device: h.devices[S.device] };
  const stop = (ev) => { if (ev.detail && ev.detail.dialogTag === 'pg-test-dialog') { ev.stopImmediatePropagation(); ev.stopPropagation(); } };
  window.addEventListener('show-dialog', stop, true);
  el.dispatchEvent(new CustomEvent('show-dialog', { bubbles: true, composed: true, detail: { dialogTag: 'pg-test-dialog', dialogParams: params } }));
  window.removeEventListener('show-dialog', stop, true);
  res.dialogDevice = params.device.name_by_user || params.device.name;
  const warnings = (window.__pgWarn || []).join(' | ');
  res.warnings = warnings || 'none';
  window.__pgResult = res;
  return res;
})();
