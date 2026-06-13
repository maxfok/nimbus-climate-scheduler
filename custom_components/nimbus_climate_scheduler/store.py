from __future__ import annotations

from copy import deepcopy
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION


class NimbusClimateSchedulerStore:
    """Persist scheduler configuration in Home Assistant storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data: dict[str, Any] = {"zones": {}}

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            self.data = stored
        self.data.setdefault("zones", {})

    async def async_save(self) -> None:
        await self._store.async_save(self.data)

    def get_zone(self, entity_id: str) -> dict[str, Any] | None:
        zone = self.data.get("zones", {}).get(entity_id)
        return deepcopy(zone) if isinstance(zone, dict) else None

    def get_climates(self) -> list[dict[str, Any]]:
        climates = self.data.get("climates")
        return deepcopy(climates) if isinstance(climates, list) else []

    async def async_set_climates(self, climates: list[dict[str, Any]]) -> None:
        self.data["climates"] = deepcopy(climates)
        # Zones deselected in setup lose their schedules, like deleting a zone.
        allowed = {entry.get("entity") for entry in climates}
        zones = self.data.setdefault("zones", {})
        for entity_id in list(zones):
            if entity_id not in allowed:
                zones.pop(entity_id)
        await self.async_save()

    def zone_entity_ids(self) -> list[str]:
        return list(self.data.get("zones", {}).keys())

    async def async_set_zone(self, entity_id: str, zone_data: dict[str, Any]) -> None:
        self.data.setdefault("zones", {})[entity_id] = deepcopy(zone_data)
        await self.async_save()

    def as_dict(self) -> dict[str, Any]:
        return deepcopy(self.data)
