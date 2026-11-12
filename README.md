# Polyglot

Per-user names for Home Assistant. Everyone in the home sees area, floor, device, entity and dashboard names in
the language of their own HA profile, and falls back to the original name where no translation exists.

Home Assistant translates its own interface per user, but the names you type yourself (rooms, devices, card
titles) exist in one language only. Polyglot adds a translation layer on top, without renaming anything: your
automations, history and entity IDs stay exactly as they are.

## How it works

- **Translations page** (admin only, sidebar → Translations). One row per area, floor, device, entity and dashboard
  string, one input per row. Pick a language, type, press Enter. Export and import as JSON.
- **Overlay** that every page loads. For a user whose profile language has translations, it swaps the names in the
  frontend before any card sees them: dashboards, tiles, more-info dialogs, the sidebar, history and logbook.
- **Nothing is written back.** Translations live in `.storage/polyglot.translations`. Settings and developer tools
  pages always show the original names, so a translated name can never be saved by accident.

Original names are taken to be in the system language (Settings → System → General). A user whose profile
language matches it, or who has no translations, sees the original names.

## Requirements

Home Assistant 2026.3 or newer. Tested on 2026.3, 2026.6, 2026.9 and 2026.11.

## Install

1. HACS → Custom repositories → add this repository as an *Integration*, then install Polyglot. Or copy
   `custom_components/polyglot` into your `config/custom_components`.
2. Restart Home Assistant.
3. Settings → Devices & services → Add integration → Polyglot.
4. Open **Translations** in the sidebar, add a language (the code from the HA profile, for example `ru`, `de`,
   `pt-BR`), and translate.
5. Each person picks their language in their profile (bottom left → Language).

Reload open browser tabs and the companion app after installing or upgrading.

## What gets translated

| | Translated |
|---|---|
| Area and floor names | Everywhere outside settings |
| Device names | Everywhere outside settings |
| Entity names | Everywhere outside settings. For entities named "device + entity", both parts are translated separately |
| Sidebar dashboard titles | Yes, through *Dashboard text* |
| State values | Through *State values*: text states and select options that the integration leaves untranslated ("Sweeping and mopping", "recirculation"). Values Home Assistant already translates into the chosen language are not listed |
| Dashboard text: view titles, headings, card names | For non-admin users, and for admins who turn on *Translate dashboard text for me too* on the Translations page (a per-person setting). An exact match of the whole string, so `Living room` is translated but `Living room temperature` needs its own row |

## Templates

Card templates (Markdown, Mushroom and other cards that render templates) get a `language` variable with the
viewer's profile language:

```jinja
{% set ru = language is defined and language == 'ru' %}
{{ 'Добрый вечер' if ru else 'Good evening' }}
```

Use `language is defined` so the template still works where Polyglot is not loaded (the companion app before an
update, or a template preview).

## Limits

- Text built on the server stays in the original language: notifications, Assist voice replies, logbook messages
  written by automations and template sensors. Card templates can switch language themselves, see above.
- Settings, developer tools and your profile page always show original names. That is deliberate.
- Admins see untranslated dashboard text unless they opt in. When they do and save a dashboard, text that matches a
  translation is turned back into the original first; a translation shared by two originals is saved as typed.
- Settings dialogs opened from a translated page (more-info → settings → device) get the original names, so saving
  them never stores a translation.
- Polyglot depends on Home Assistant frontend internals. If a release changes them, Polyglot switches itself off and
  everyone sees the original names until an update. Check the browser console for `[polyglot]` messages.

## Development

```
npm test        # node --test tests/
```

The frontend is plain ES modules served straight from `custom_components/polyglot/frontend`, no build step.
`core.js` holds the pure translation logic and is what the tests cover.

## License

MIT
