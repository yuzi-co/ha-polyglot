"""Config flow: a single entry (single_config_entry in the manifest), no options. Languages are managed in the
Translations panel."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class PolyglotConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="Polyglot", data={})
        return self.async_show_form(step_id="user")
