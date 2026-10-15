from __future__ import annotations

import asyncio
from collections import Counter
from copy import deepcopy
from typing import Any
from uuid import uuid4

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import SIGNAL_UPDATED, STORAGE_KEY, STORAGE_VERSION
from .settings import DEFAULT_COLOR_THRESHOLDS, merge_settings


class NimbusClimateSchedulerStore:
    """Persist scheduler configuration in Home Assistant storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._lock = asyncio.Lock()
        self.data: dict[str, Any] = {"zones": {}}

    async def async_load(self, climates: list[dict] | None = None) -> None:
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            self.data = deepcopy(stored)
        self.data.setdefault("zones", {})
        # Add stable group identities without rewriting a single saved/draft
        # setpoint. Version 1 remains readable by older releases on rollback.
        configs = self.data.get("climates")
        if configs is None:
            configs = climates or [{"entity": entity_id} for entity_id in self.zone_entity_ids()]
        self.data["climates"] = self._with_zone_ids(configs, configs)
        if self.data != stored:
            await self._store.async_save(self.data)

    async def _async_commit(self, data: dict) -> None:
        """Publish only after persistence succeeds; callers hold the store lock."""
        await self._store.async_save(data)
        self.data = data
        async_dispatcher_send(self.hass, SIGNAL_UPDATED)

    def get_zone(self, entity_id: str) -> dict[str, Any] | None:
        zone = self.data.get("zones", {}).get(entity_id)
        return deepcopy(zone) if isinstance(zone, dict) else None

    def get_climates(self) -> list[dict[str, Any]]:
        climates = self.data.get("climates")
        return deepcopy(climates) if isinstance(climates, list) else []

    async def async_set_climates(
        self, climates: list[dict[str, Any]], expected_revision: int | None = None,
    ) -> None:
        async with self._lock:
            revision = self.data.get("climates_revision", 0)
            if expected_revision is not None and expected_revision != revision:
                raise HomeAssistantError("The zone list changed elsewhere. Reopen zone setup before saving.")
            if len({item["entity"] for item in climates}) != len(climates):
                raise HomeAssistantError("Each thermostat can only appear once in the zone list.")
            previous = self.get_climates()
            data = deepcopy(self.data)
            data["climates"] = self._with_zone_ids(climates, previous)
            groups: dict[str, list[str]] = {}
            for item in data["climates"]:
                groups.setdefault(item["zone_id"], []).append(item["entity"])
            for members in groups.values():
                existing = [item for item in previous if item["entity"] in members]
                if len({item["zone_id"] for item in existing}) > 1:
                    raise HomeAssistantError("Existing zones need distinct names so their plans are preserved.")
                source = next((zone for item in existing
                               if (zone := self.get_zone(item["entity"])) is not None), None)
                if source is None:
                    continue  # The panel initializes genuinely new zones.
                old_members = self.get_group(existing[0]["zone_id"])["entity_ids"]
                if set(old_members) == set(members):
                    continue  # Renaming/reordering never rewrites a plan or draft.
                schedule_revision = max(
                    (data["zones"].get(entity, {}).get("revision", 0) for entity in {*old_members, *members}),
                    default=0,
                ) + 1
                for entity in members:
                    data["zones"].setdefault(entity, deepcopy(source))["revision"] = schedule_revision
            # An explicit removal deletes only the deselected thermostats.
            allowed = {entry["entity"] for entry in climates}
            data["zones"] = {key: value for key, value in data["zones"].items() if key in allowed}
            if data == self.data:
                return
            data["climates_revision"] = revision + 1
            await self._async_commit(data)

    @staticmethod
    def _with_zone_ids(climates: list[dict], previous: list[dict]) -> list[dict]:
        """Keep identities across rename, reorder and membership changes."""
        old_ids = {item["entity"]: item.get("zone_id") for item in previous}
        groups: dict[str, list[dict]] = {}
        for item in climates:
            groups.setdefault(item.get("name") or item["entity"], []).append(item)
        used = set()
        result = []
        for members in groups.values():
            candidates = Counter(old_ids.get(item["entity"]) for item in members)
            zone_id = next((key for key, _ in candidates.most_common() if key and key not in used), None)
            zone_id = zone_id or uuid4().hex
            used.add(zone_id)
            result.extend({**item, "zone_id": zone_id} for item in members)
        return result

    def zone_groups(self) -> list[dict]:
        groups: dict[str, dict] = {}
        for config in self.get_climates():
            zone_id = config["zone_id"]
            group = groups.setdefault(zone_id, {
                "id": zone_id,
                "name": config.get("name") or config["entity"],
                "entity_ids": [],
            })
            group["entity_ids"].append(config["entity"])
        return list(groups.values())

    def get_group(self, zone_or_entity_id: str) -> dict | None:
        return next((group for group in self.zone_groups()
                     if zone_or_entity_id == group["id"] or zone_or_entity_id in group["entity_ids"]), None)

    async def async_set_zone_members(
        self, zone_id: str, source_entity_id: str, entity_ids: list[str],
        expected_entity_ids: list[str], expected_revision: int,
    ) -> dict:
        """Change membership and inherit the existing plan in one transaction."""
        async with self._lock:
            group = self.get_group(zone_id)
            if group is None or group["id"] != zone_id:
                raise HomeAssistantError("This zone no longer exists. Reload the zone list.")
            previous = group["entity_ids"]
            if set(previous) != set(expected_entity_ids) or source_entity_id not in previous:
                raise HomeAssistantError("The zone's thermostats changed elsewhere. Reopen the thermostat selection.")
            source = self.get_zone(source_entity_id)
            if source is None or source.get("revision", 0) != expected_revision:
                raise HomeAssistantError("This schedule changed elsewhere. Reopen the thermostat selection.")
            if not entity_ids or len(entity_ids) != len(set(entity_ids)):
                raise HomeAssistantError("Select at least one thermostat, without duplicates.")
            for entity_id in entity_ids:
                owner = self.get_group(entity_id)
                if owner and owner["id"] != zone_id:
                    raise HomeAssistantError(f"{entity_id} already belongs to {owner['name']}.")
            if set(previous) == set(entity_ids):
                return group

            # Keep the representative thermostat/order where possible. A full
            # replacement still retains the zone's identity and its schedule.
            members = [entity for entity in previous if entity in entity_ids]
            members.extend(entity for entity in entity_ids if entity not in previous)
            data = deepcopy(self.data)
            existing = {item["entity"]: item for item in data["climates"]}
            replacements = [
                {**existing.get(entity, {}), "entity": entity, "name": group["name"], "zone_id": zone_id}
                for entity in members
            ]
            configs = []
            for item in data["climates"]:
                if item["zone_id"] == zone_id:
                    if replacements:
                        configs.extend(replacements)
                        replacements = []
                else:
                    configs.append(item)
            data["climates"] = configs
            data["climates_revision"] = data.get("climates_revision", 0) + 1
            # Invalidate old editors even if the saved temperatures are unchanged.
            revision = max(
                (data["zones"].get(entity, {}).get("revision", 0) for entity in {*previous, *members}),
                default=0,
            ) + 1
            for entity in previous:
                if entity not in members:
                    data["zones"].pop(entity, None)
            for entity in members:
                data["zones"][entity] = {**deepcopy(source), "revision": revision}
            await self._async_commit(data)
            return self.get_group(zone_id)

    def zone_entity_ids(self) -> list[str]:
        return list(self.data.get("zones", {}).keys())

    async def async_set_zones(
        self, updates: dict[str, dict], expected_revision: int | None = None,
    ) -> None:
        """Atomically merge a group update, retaining unrelated state and fields."""
        async with self._lock:
            data = deepcopy(self.data)
            for entity_id, update in updates.items():
                zone = data["zones"].setdefault(entity_id, {})
                revision = zone.get("revision", 0)
                if expected_revision is not None and revision != expected_revision:
                    raise HomeAssistantError("This schedule changed elsewhere. Reload it before saving.")
                if "modes" in update and update["modes"] != zone.get("modes"):
                    revision += 1
                zone.update(deepcopy(update))
                zone["revision"] = revision
            await self._async_commit(data)

    async def async_set_zone(self, entity_id: str, zone_data: dict[str, Any]) -> None:
        await self.async_set_zones({entity_id: zone_data})

    def get_settings(self) -> dict:
        return deepcopy(self.data.get("settings", {"color_thresholds": DEFAULT_COLOR_THRESHOLDS}))

    async def async_set_settings(self, update: dict, expected_revision: int | None = None) -> None:
        async with self._lock:
            revision = self.data.get("settings_revision", 0)
            if expected_revision is not None and revision != expected_revision:
                raise HomeAssistantError("Color settings changed elsewhere. Reopen Settings before saving.")
            data = deepcopy(self.data)
            data["settings"] = merge_settings(self.get_settings(), update)
            data["settings_revision"] = revision + 1
            await self._async_commit(data)

    def as_dict(self) -> dict[str, Any]:
        return {
            **deepcopy(self.data), "climates_revision": self.data.get("climates_revision", 0),
            "settings": self.get_settings(), "settings_revision": self.data.get("settings_revision", 0),
        }
