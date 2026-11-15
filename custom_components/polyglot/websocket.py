"""WebSocket API. polyglot/subscribe is open to every user and gives them the dictionary for their language;
everything that reads all data or writes is admin only."""

from __future__ import annotations

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
import voluptuous as vol

from .const import DOMAIN
from .store import PolyglotStore, async_listen


def _store(hass: HomeAssistant) -> PolyglotStore | None:
    return hass.data.get(DOMAIN)


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_set)
    websocket_api.async_register_command(hass, ws_set_many)
    websocket_api.async_register_command(hass, ws_languages)
    websocket_api.async_register_command(hass, ws_settings)


@websocket_api.websocket_command(
    {vol.Required("type"): "polyglot/subscribe", vol.Optional("language"): vol.Any(str, None)}
)
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Send the dictionary for `language` (the user's profile language) now and whenever it changes.

    Without `language` every dictionary is sent, on every change. The subscription survives a reload of the
    integration: while Polyglot is not loaded the subscriber gets no translations, so it shows the original names.
    """
    if _store(hass) is None:
        connection.send_error(msg["id"], "not_loaded", "Polyglot is not loaded")
        return
    user_language: str | None = msg.get("language")

    @callback
    def send(changed: str | None = None) -> None:
        store = _store(hass)
        if store is None:
            data: dict[str, Any] = {
                "primary": hass.config.language,
                "languages": [],
                "translations": {},
                "auto_names": False,
            }
        elif user_language is None:
            data = store.as_dict()
        else:
            picked = store.pick(user_language)
            if changed is not None and changed != picked:
                return  # another language changed
            # `languages` stays complete, so the client's own pick gives the same answer.
            data = store.as_dict(only=picked or "")
        connection.send_message(websocket_api.event_message(msg["id"], data))

    connection.subscriptions[msg["id"]] = async_listen(hass, send)
    connection.send_result(msg["id"])
    send()


@websocket_api.websocket_command({vol.Required("type"): "polyglot/config"})
@websocket_api.require_admin
@callback
def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Polyglot is not loaded")
        return
    connection.send_result(msg["id"], store.as_dict())


def _write(hass, connection, msg, apply) -> None:
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Polyglot is not loaded")
        return
    try:
        apply(store)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "polyglot/set",
        vol.Required("language"): str,
        vol.Required("key"): str,
        vol.Required("value"): vol.Any(str, None),
    }
)
@websocket_api.require_admin
@callback
def ws_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    _write(hass, connection, msg, lambda s: s.set_many(msg["language"], {msg["key"]: msg["value"]}))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "polyglot/set_many",
        vol.Required("language"): str,
        vol.Required("values"): {str: vol.Any(str, None)},
    }
)
@websocket_api.require_admin
@callback
def ws_set_many(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    _write(hass, connection, msg, lambda s: s.set_many(msg["language"], msg["values"]))


@websocket_api.websocket_command({vol.Required("type"): "polyglot/languages", vol.Required("languages"): [str]})
@websocket_api.require_admin
@callback
def ws_languages(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    _write(hass, connection, msg, lambda s: s.set_languages(msg["languages"]))


@websocket_api.websocket_command({vol.Required("type"): "polyglot/settings", vol.Required("auto_names"): bool})
@websocket_api.require_admin
@callback
def ws_settings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    _write(hass, connection, msg, lambda s: s.set_auto_names(msg["auto_names"]))
