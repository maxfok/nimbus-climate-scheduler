"""Expose global color thresholds to Home Assistant actions and automations."""
from __future__ import annotations

import voluptuous as vol

from homeassistant.components.number import NumberDeviceClass, NumberEntity, NumberMode
from homeassistant.const import EntityCategory, UnitOfTemperature
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN, SIGNAL_UPDATED


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([
        NimbusColorThreshold(hass.data[DOMAIN]["store"], mode, band)
        for mode in ("heat", "cool") for band in ("cold", "warm", "hot")
    ])


class NimbusColorThreshold(NumberEntity):
    _attr_should_poll = False
    _attr_has_entity_name = True
    _attr_entity_category = EntityCategory.CONFIG
    _attr_device_class = NumberDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_native_min_value = -100
    _attr_native_max_value = 100
    _attr_native_step = 0.1
    _attr_mode = NumberMode.BOX
    _attr_icon = "mdi:palette"
    _attr_device_info = DeviceInfo(
        identifiers={(DOMAIN, "settings")}, name="Nimbus Climate Scheduler",
        manufacturer="Nimbus", model="Global settings",
    )

    def __init__(self, store, mode, band):
        self.store = store
        self.schedule_mode = mode
        self.band = band
        self._attr_unique_id = f"{DOMAIN}_{mode}_{band}_color_threshold"
        self._attr_translation_key = f"{mode}_{band}_color_threshold"

    @property
    def native_value(self) -> float:
        return self.store.get_settings()["color_thresholds"][self.schedule_mode][self.band]

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.store.async_set_settings({"color_thresholds": {self.schedule_mode: {self.band: value}}})
        except vol.Invalid as err:
            raise HomeAssistantError(str(err)) from err

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self.async_write_ha_state))
