"""Polyglot: per-user translations of area, device, entity and dashboard names.

The integration stores the translations and serves two frontend modules: the overlay that every page loads
(polyglot.js) and the admin editor panel (polyglot-panel.js). Nothing in Home Assistant's registries is changed.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import websocket
from .const import DOMAIN, PANEL_URL, STATIC_URL, VERSION
from .store import PolyglotStore

FRONTEND_DIR = Path(__file__).parent / "frontend"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Load the store, register the WebSocket API, the overlay module and the editor panel."""
    store = PolyglotStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store
    # Computed per setup, so reloading the integration is enough to hand browsers new frontend files.
    version = f"{VERSION}-{await hass.async_add_executor_job(_frontend_hash)}"
    hass.data[f"{DOMAIN}_overlay_url"] = f"{STATIC_URL}/polyglot.js?v={version}"

    # Static paths and WebSocket commands cannot be unregistered, so only add them once per run.
    if not hass.data.get(f"{DOMAIN}_registered"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
        )
        websocket.async_register(hass)
        hass.data[f"{DOMAIN}_registered"] = True

    frontend.add_extra_js_url(hass, hass.data[f"{DOMAIN}_overlay_url"])
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name="polyglot-panel",
        module_url=f"{STATIC_URL}/polyglot-panel.js?v={version}",
        sidebar_title="Translations",
        sidebar_icon="mdi:translate",
        require_admin=True,
        config={},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the overlay and the panel; open pages keep the old module until reloaded."""
    frontend.remove_extra_js_url(hass, hass.data.pop(f"{DOMAIN}_overlay_url", ""))
    frontend.async_remove_panel(hass, PANEL_URL)
    store: PolyglotStore | None = hass.data.pop(DOMAIN, None)
    if store is not None:
        await store.async_flush()
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete the translations when the integration is removed."""
    await PolyglotStore(hass).async_remove()


def _frontend_hash() -> str:
    """Hash of the frontend files, so browsers fetch new modules after any change, even within one version."""
    digest = hashlib.sha256()
    for path in sorted(FRONTEND_DIR.glob("*.js")):
        digest.update(path.read_bytes())
    return digest.hexdigest()[:10]
