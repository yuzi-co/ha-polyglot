"""Setup, unload and removal: panel, overlay module and storage."""

from __future__ import annotations

from typing import Any

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.polyglot.const import STORAGE_KEY, VERSION


def _overlay_urls(hass: HomeAssistant) -> list[str]:
    return [url for url in hass.data[DATA_EXTRA_MODULE_URL].urls if "/polyglot_static/" in url]


async def test_setup_registers_panel_and_overlay(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert entry.state is ConfigEntryState.LOADED
    panel = hass.data[DATA_PANELS]["polyglot"]
    assert panel.require_admin
    assert panel.sidebar_title == "Polyglot"
    urls = _overlay_urls(hass)
    assert len(urls) == 1
    # Version plus a hash of the frontend files, so browsers fetch new modules after any change.
    assert urls[0].startswith(f"/polyglot_static/polyglot.js?v={VERSION}-")


async def test_unload_removes_panel_and_overlay(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert "polyglot" not in hass.data[DATA_PANELS]
    assert _overlay_urls(hass) == []
    # Reloading adds them back exactly once.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert "polyglot" in hass.data[DATA_PANELS]
    assert len(_overlay_urls(hass)) == 1


async def test_loads_stored_translations(hass: HomeAssistant, hass_storage: dict[str, Any], hass_ws_client) -> None:
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "key": STORAGE_KEY,
        "data": {"languages": ["ru"], "translations": {"ru": {"area:kitchen": "Кухня"}}},
    }
    entry = MockConfigEntry(domain="polyglot")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "polyglot/config"})
    msg = await client.receive_json()
    assert msg["result"]["translations"] == {"ru": {"area:kitchen": "Кухня"}}


async def test_unload_flushes_and_remove_deletes(
    hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any], hass_ws_client
) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "polyglot/set", "language": "ru", "key": "area:kitchen", "value": "Кухня"})
    assert (await client.receive_json())["success"]
    # Saved on unload without waiting for the save delay.
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert hass_storage[STORAGE_KEY]["data"]["translations"] == {"ru": {"area:kitchen": "Кухня"}}
    # Removing the integration deletes the translations.
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert STORAGE_KEY not in hass_storage
