"""Config flow for Nimbus Climate Scheduler."""
from __future__ import annotations

from typing import Any

from homeassistant import config_entries

try:  # HA 2024.4+
    from homeassistant.config_entries import ConfigFlowResult
except ImportError:  # older cores
    from homeassistant.data_entry_flow import FlowResult as ConfigFlowResult

from .const import DOMAIN


class NimbusClimateSchedulerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """UI setup: a single instance; zones are managed inside the panel."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="Nimbus Climate Scheduler", data={})

        return self.async_show_form(step_id="user")
