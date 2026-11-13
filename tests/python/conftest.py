"""Shared fixtures: custom integrations enabled, and a helper that sets Polyglot up."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.polyglot.const import DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Let Home Assistant load custom_components/polyglot."""
    return


@pytest.fixture
async def entry(hass: HomeAssistant) -> MockConfigEntry:
    """Polyglot, set up and loaded."""
    entry = MockConfigEntry(domain=DOMAIN, title="Polyglot")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
