# Changelog

## 0.2.1 (2026-11-13)

### Changed
- The sidebar entry is now "Polyglot" (the page heading stays "Translations"): a name that needs no translation
  and matches the integration's name in Settings and HACS.

### Fixed
- Right-to-left languages (tested with Hebrew): the Translations page keeps its English text left to right in a
  Hebrew or Arabic interface instead of scrambling it, and every name and translation field follows its own
  script's direction, so Hebrew typed in an English interface reads right to left.
- A field saved in the editor no longer shows its old typed text again after the page redraws.

## 0.2.0 (2026-11-13)

Translating a whole home is now mostly review work.

### Added
- **Use Home Assistant's names**: many entities are named by their integration, and Home Assistant already has
  those names in other languages. The Entities tab fills them in as suggestions to review.
- **Translate missing with AI** through any AI Task set up in Home Assistant, and **Copy for any AI / Paste reply**
  for any AI chat or a human translator. Suggestions are never saved without review.
  - Names go grouped by device, room or dashboard view, each distinct name once, with what it is (a reading, an
    action button, a choice), its unit, range and options. Only numeric values are sent, never text states.
  - Your existing translations go along as a glossary, so the AI keeps your terms.
  - Suggestions worth a second look are marked (the AI was unsure, two different names got the same translation,
    much longer than the original), with a filter to show only those.
  - A few batches run at once; a reply cut off by the model's output limit is split and retried.
- Dashboard text rows show where the text appears (dashboard, view).
- **Translate dashboard text for me too**: admins see original dashboard text by default and can opt in. Dashboards
  they save while translated get their text turned back into the original first.
- Tests for the integration (setup, storage, WebSocket API) and CI: hassfest, the HACS check, ruff, pytest and the
  frontend tests on every push, plus a twice-monthly check of the current beta and stable releases in a real browser.
- `tools/ai-eval`: runs the AI translation on a fixed set of hard names and writes a review sheet.

### Changed
- Requires Home Assistant 2026.3 or newer (tested on 2026.3, 2026.6, 2026.9 and 2026.11).

### Fixed
- The editor's counts and AI buttons follow edits while you type; a click is no longer lost to a redraw.

## 0.1.1 (2026-11-12)

First version: per-user translations of area, floor, device, entity, state and dashboard names, edited on the
admin-only Translations page.
