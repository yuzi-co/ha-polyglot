"""WebSocket API. polyglot/subscribe is open to every user; everything that reads all data or writes is admin only."""

from __future__ import annotations

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
import voluptuous as vol

from .const import DOMAIN
from .store import PolyglotStore


def _store(hass: HomeAssistant) -> PolyglotStore | None:
    return hass.data.get(DOMAIN)


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_set)
    websocket_api.async_register_command(hass, ws_set_many)
    websocket_api.async_register_command(hass, ws_languages)


@websocket_api.websocket_command(
    {vol.Required("type"): "polyglot/subscribe", vol.Optional("language"): vol.Any(str, None)}
)
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Send the dictionaries now and after every change. The client picks the language it needs."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Polyglot is not loaded")
        return

    @callback
    def send() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], store.as_dict()))

    connection.subscriptions[msg["id"]] = store.async_listen(send)
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
