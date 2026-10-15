"""Select the active (or next resumed) schedule mode."""
from homeassistant.components.select import SelectEntity

from .entity import NimbusZoneEntity, async_setup_zone_entities


async def async_setup_entry(hass, entry, async_add_entities):
    async_setup_zone_entities(hass, entry, async_add_entities, NimbusScheduleMode)


class NimbusScheduleMode(NimbusZoneEntity, SelectEntity):
    _attr_translation_key = "schedule_mode"
    _attr_icon = "mdi:thermostat"

    def __init__(self, scheduler, zone_id):
        super().__init__(scheduler, zone_id)
        self._attr_unique_id = f"{zone_id}_schedule_mode"

    @property
    def options(self) -> list[str]:
        return self.scheduler.supported_modes(self.zone_group) if self.zone_group else []

    @property
    def available(self) -> bool:
        return super().available and bool(self.options)

    @property
    def current_option(self) -> str | None:
        modes = {zone.get("activeScheduleMode") or zone.get("resumeScheduleMode") or zone.get("scheduleMode", "heat") for zone in self.zones}
        mode = next(iter(modes)) if len(modes) == 1 else None
        return mode if mode in self.options else None

    async def async_select_option(self, option: str) -> None:
        await self.scheduler.async_set_control(self.zone_id, mode=option)
