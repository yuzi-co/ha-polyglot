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


async def test_subscribe_with_language_gets_only_that_dictionary(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client
) -> None:
    writer = await hass_ws_client(hass)
    await _call(writer, type="polyglot/set_many", language="ru", values={"area:kitchen": "Кухня"})
    await _call(writer, type="polyglot/set_many", language="de", values={"area:kitchen": "Küche"})
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "polyglot/subscribe", "language": "ru"})
    assert (await client.receive_json())["success"]
    first = (await client.receive_json())["event"]
    assert first["languages"] == ["ru", "de"]
    assert first["translations"] == {"ru": {"area:kitchen": "Кухня"}}
    # A change to another language is not sent; the next message is the change to this one.
    await _call(writer, type="polyglot/set", language="de", key="area:hall", value="Flur")
    await _call(writer, type="polyglot/set", language="ru", key="area:hall", value="Холл")
    update = (await client.receive_json())["event"]
    assert update["translations"] == {"ru": {"area:kitchen": "Кухня", "area:hall": "Холл"}}
    # A language that only matches by its base (pt-BR for pt) is picked up when it is added.
    other = await hass_ws_client(hass)
    await other.send_json_auto_id({"type": "polyglot/subscribe", "language": "pt-BR"})
    assert (await other.receive_json())["success"]
    assert (await other.receive_json())["event"]["translations"] == {}
    await _call(writer, type="polyglot/set", language="pt", key="area:hall", value="Corredor")
    assert (await other.receive_json())["event"]["translations"] == {"pt": {"area:hall": "Corredor"}}


async def test_subscription_survives_a_reload(hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    await _call(client, type="polyglot/set", language="ru", key="area:kitchen", value="Кухня")
    await client.send_json_auto_id({"type": "polyglot/subscribe", "language": "ru"})
    assert (await client.receive_json())["success"]
    assert (await client.receive_json())["event"]["translations"] == {"ru": {"area:kitchen": "Кухня"}}
    # Unloaded: the open page is told to show the original names.
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert (await client.receive_json())["event"] == {
        "primary": hass.config.language,
        "languages": [],
        "translations": {},
        "auto_names": False,
    }
    # Loaded again: the same subscription gets the dictionary back, and later changes too.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (await client.receive_json())["event"]["translations"] == {"ru": {"area:kitchen": "Кухня"}}
    writer = await hass_ws_client(hass)
    await _call(writer, type="polyglot/set", language="ru", key="area:hall", value="Холл")
    assert (await client.receive_json())["event"]["translations"]["ru"]["area:hall"] == "Холл"


async def test_auto_names_setting(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client, hass_storage, hass_admin_user
) -> None:
    client = await hass_ws_client(hass)
    assert (await _call(client, type="polyglot/config"))["result"]["auto_names"] is False
    # Subscribers hear about it, also those without a dictionary: the names come from Home Assistant itself.
    sub = await hass_ws_client(hass)
    await sub.send_json_auto_id({"type": "polyglot/subscribe", "language": "de"})
    assert (await sub.receive_json())["success"]
    assert (await sub.receive_json())["event"]["auto_names"] is False
    assert (await _call(client, type="polyglot/settings", auto_names=True))["success"]
    assert (await sub.receive_json())["event"]["auto_names"] is True
    assert (await _call(client, type="polyglot/config"))["result"]["auto_names"] is True
    # Stored with the translations.
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert hass_storage["polyglot.translations"]["data"]["auto_names"] is True
    # Admin only.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    hass_admin_user.groups = []
    other = await hass_ws_client(hass)
    res = await _call(other, type="polyglot/settings", auto_names=False)
    assert res["error"]["code"] == "unauthorized"
