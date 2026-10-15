"""Enable or pause a shared zone schedule from Home Assistant automations."""
from homeassistant.components.switch import SwitchEntity

from .entity import NimbusZoneEntity, async_setup_zone_entities


async def async_setup_entry(hass, entry, async_add_entities):
    async_setup_zone_entities(hass, entry, async_add_entities, NimbusScheduleSwitch)


class NimbusScheduleSwitch(NimbusZoneEntity, SwitchEntity):
    _attr_translation_key = "schedule"
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, scheduler, zone_id):
        super().__init__(scheduler, zone_id)
        self._attr_unique_id = f"{zone_id}_schedule"

    @property
    def is_on(self) -> bool:
        return bool(self.zones) and all(zone.get("activeScheduleMode") in {"heat", "cool"} for zone in self.zones)

    async def async_turn_on(self, **kwargs):
        await self.scheduler.async_set_control(self.zone_id, enabled=True)

    async def async_turn_off(self, **kwargs):
        await self.scheduler.async_set_control(self.zone_id, enabled=False)
