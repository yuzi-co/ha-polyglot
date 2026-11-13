"""WebSocket API: reads, writes, validation and who may do what."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry


async def _call(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_set_config_and_clear(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    res = await _call(
        client,
        type="polyglot/set_many",
        language="ru",
        values={"area:kitchen": " Кухня ", "text:Power": "Мощность", "entity:light.bar": "Бар"},
    )
    assert res["success"]
    res = await _call(client, type="polyglot/config")
    assert res["result"]["primary"] == hass.config.language
    assert res["result"]["languages"] == ["ru"]
    # Trimmed on save.
    assert res["result"]["translations"]["ru"]["area:kitchen"] == "Кухня"
    # None or an empty string removes a translation.
    assert (await _call(client, type="polyglot/set", language="ru", key="text:Power", value=None))["success"]
    assert (await _call(client, type="polyglot/set", language="ru", key="entity:light.bar", value="  "))["success"]
    res = await _call(client, type="polyglot/config")
    assert res["result"]["translations"]["ru"] == {"area:kitchen": "Кухня"}


async def test_invalid_input_changes_nothing(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    for msg in (
        {"language": "x!", "values": {"area:kitchen": "Кухня"}},
        {"language": "ru", "values": {"area:kitchen": "Кухня", "registry:x": "y"}},
        {"language": "ru", "values": {"area:kitchen": "Ж" * 501}},
    ):
        res = await _call(client, type="polyglot/set_many", **msg)
        assert not res["success"]
        assert res["error"]["code"] == "invalid_format"
    res = await _call(client, type="polyglot/config")
    assert res["result"]["languages"] == []
    assert res["result"]["translations"] == {}


async def test_removing_a_language_drops_its_translations(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client
) -> None:
    client = await hass_ws_client(hass)
    await _call(client, type="polyglot/set_many", language="ru", values={"area:kitchen": "Кухня"})
    await _call(client, type="polyglot/set_many", language="de", values={"area:kitchen": "Küche"})
    assert (await _call(client, type="polyglot/languages", languages=["de", "de"]))["success"]
    res = await _call(client, type="polyglot/config")
    assert res["result"]["languages"] == ["de"]
    assert res["result"]["translations"] == {"de": {"area:kitchen": "Küche"}}
    assert not (await _call(client, type="polyglot/languages", languages=["pt_BR"]))["success"]


async def test_subscribe_sends_updates(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "polyglot/subscribe"})
    result = await client.receive_json()
    assert result["success"]
    sub_id = result["id"]
    first = await client.receive_json()
    assert first["id"] == sub_id
    assert first["event"]["translations"] == {}
    writer = await hass_ws_client(hass)
    await _call(writer, type="polyglot/set", language="ru", key="area:kitchen", value="Кухня")
    update = await client.receive_json()
    assert update["event"]["translations"] == {"ru": {"area:kitchen": "Кухня"}}


async def test_non_admin_reads_through_subscribe_only(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client, hass_admin_user
) -> None:
    hass_admin_user.groups = []  # the test user is no longer an admin
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "polyglot/subscribe"})
    assert (await client.receive_json())["success"]
    assert "event" in await client.receive_json()
    for msg in (
        {"type": "polyglot/config"},
        {"type": "polyglot/set", "language": "ru", "key": "area:kitchen", "value": "x"},
        {"type": "polyglot/set_many", "language": "ru", "values": {}},
        {"type": "polyglot/languages", "languages": ["ru"]},
    ):
        res = await _call(client, **msg)
        assert not res["success"]
        assert res["error"]["code"] == "unauthorized"
