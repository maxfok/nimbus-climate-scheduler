from __future__ import annotations

from copy import deepcopy
from typing import Any
from uuid import uuid4

from homeassistant.helpers.dispatcher import async_dispatcher_send

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION


class NimbusClimateSchedulerStore:
    """Persist scheduler configuration in Home Assistant storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
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
        """Update membership atomically, inheriting the destination zone state."""
        old_groups = {g["id"]: g for g in self.zone_groups()}
        assigned = self._with_group_ids(climates)
        updated = deepcopy(self.data)
        updated["climates"] = assigned
        groups: dict[str, list[str]] = {}
        for entry in assigned:
            groups.setdefault(entry["zone_id"], []).append(entry["entity"])
        old_zones = self.data.get("zones", {})
        zones = {}
        paused = set()
        reasons = {}
        for group_id, members in groups.items():
            previous = old_groups.get(group_id)
            old_members = previous["entities"] if previous else []
            # Retain each existing member's saved/draft data. Only incoming
            # members inherit the destination's schedule and pause state.
            source = next((old_zones[e] for e in old_members if e in old_zones), None)
            reason = next((self.pause_reason(e) for e in old_members if self.is_automation_paused(e)), None)
            for entity in members:
                if entity in old_members:
                    if entity in old_zones:
                        zones[entity] = deepcopy(old_zones[entity])
                elif source is not None:
                    zones[entity] = deepcopy(source)
                # New groups without an existing destination retain the source
                # schedule, but start unpaused; moved members cannot bring a pause.
                elif not previous and entity in old_zones:
                    zones[entity] = deepcopy(old_zones[entity])
                if reason:
                    paused.add(entity)
                    reasons[entity] = reason
        updated["zones"] = zones
        updated["automation_paused"] = sorted(paused)
        updated["pause_reasons"] = reasons
        await self._store.async_save(updated)
        self.data = updated
        async_dispatcher_send(self.hass, f"{STORAGE_KEY}_groups_updated")

    def _with_group_ids(self, climates: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Resolve destination by existing zone name, preserving rename identity."""
        groups = {}
        for item in climates:
            groups.setdefault(item.get("name") or item["entity"], []).append(item)
        old_groups = self.zone_groups()
        by_name = {group["name"]: group for group in old_groups}
        used = set()
        result = []
        for name, members in groups.items():
            destination = by_name.get(name)
            if destination and destination["id"] not in used:
                group_id = destination["id"]
            else:
                member_ids = {item["entity"] for item in members}
                # An entire old group renamed together retains its identity.
                candidates = [g for g in old_groups if g["id"] not in used
                              and set(g["entities"]) == member_ids]
                group_id = candidates[0]["id"] if len(candidates) == 1 else uuid4().hex
            used.add(group_id)
            result.extend({**item, "zone_id": group_id} for item in members)
        return result

    async def async_initialize_groups(self, configured: list[dict[str, Any]]) -> None:
        existing = self.get_climates()
        climates = existing or configured
        if not climates:
            climates = [{"entity": entity} for entity in self.zone_entity_ids()]
        assigned = self._with_group_ids(climates)
        if assigned != existing:
            self.data["climates"] = assigned
            await self.async_save()

    def zone_groups(self) -> list[dict[str, Any]]:
        groups = {}
        for item in self.get_climates():
            group_id = item.get("zone_id")
            if not group_id:
                continue
            group = groups.setdefault(group_id, {"id": group_id, "name": item.get("name") or item["entity"], "entities": []})
            group["entities"].append(item["entity"])
        return list(groups.values())

    def zone_entity_ids(self) -> list[str]:
        return list(self.data.get("zones", {}).keys())

    def is_automation_paused(self, entity_id: str) -> bool:
        return entity_id in self.data.get("automation_paused", [])

    def pause_reason(self, entity_id: str) -> str | None:
        if not self.is_automation_paused(entity_id):
            return None
        return self.data.get("pause_reasons", {}).get(entity_id, "manual")

    async def async_set_automation_pause(self, entity_ids: list[str], paused: bool, reason: str = "manual") -> None:
        """Persist independent pause state without replacing saved schedules."""
        previous = self.data.get("automation_paused", [])
        current = set(previous)
        if paused:
            current.update(entity_ids)
        else:
            current.difference_update(entity_ids)
        updated = deepcopy(self.data)
        updated["automation_paused"] = sorted(current)
        reasons = updated.setdefault("pause_reasons", {})
        for entity_id in entity_ids:
            if paused:
                reasons[entity_id] = reason
            else:
                reasons.pop(entity_id, None)
        await self._store.async_save(updated)
        self.data = updated

    async def async_set_zone(self, entity_id: str, zone_data: dict[str, Any]) -> None:
        self.data.setdefault("zones", {})[entity_id] = deepcopy(zone_data)
        await self.async_save()

    def as_dict(self) -> dict[str, Any]:
        return deepcopy(self.data)
