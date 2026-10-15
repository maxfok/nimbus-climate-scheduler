"""Shared lifecycle for zone controls."""
from __future__ import annotations

from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import DeviceInfo, Entity
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN, SIGNAL_UPDATED


@callback
def async_setup_zone_entities(hass, entry, async_add_entities, entity_class):
    """Discover new groups and remove controls for explicitly deleted groups."""
    store = hass.data[DOMAIN]["store"]
    entities = {}

    @callback
    def update():
        groups = {group["id"]: group for group in store.zone_groups()}
        added = []
        for zone_id in groups.keys() - entities.keys():
            entity = entities[zone_id] = entity_class(hass.data[DOMAIN]["scheduler"], zone_id)
            added.append(entity)
        if added:
            async_add_entities(added)
        for zone_id in entities.keys() - groups.keys():
            entity = entities.pop(zone_id)
            if entity.entity_id:
                registry = er.async_get(hass)
                if registry.async_get(entity.entity_id):
                    registry.async_remove(entity.entity_id)
        devices = dr.async_get(hass)
        for group in groups.values():
            if device := devices.async_get_device(identifiers={(DOMAIN, group["id"])}):
                if device.name != group["name"]:
                    devices.async_update_device(device.id, name=group["name"])

    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_UPDATED, update))
    update()


class NimbusZoneEntity(Entity):
    """A push-based control with a stable identity independent of zone names."""

    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, scheduler, zone_id: str) -> None:
        self.scheduler = scheduler
        self.zone_id = zone_id

    @property
    def zone_group(self):
        return self.scheduler.store.get_group(self.zone_id)

    @property
    def zones(self):
        return [self.scheduler.store.get_zone(entity_id) or {} for entity_id in (self.zone_group or {}).get("entity_ids", [])]

    @property
    def available(self) -> bool:
        return bool(self.zone_group) and all(zone.get("modes") for zone in self.zones)

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self.zone_id)},
            name=(self.zone_group or {}).get("name", "Nimbus zone"),
            manufacturer="Nimbus",
            model="Climate schedule",
        )

    @property
    def extra_state_attributes(self):
        return {"climate_entities": (self.zone_group or {}).get("entity_ids", [])}

    async def async_added_to_hass(self) -> None:
        self._remove_state_listener = None
        self._tracked_entities = None
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._async_update))
        self.async_on_remove(self._remove_climate_listener)
        self._async_update()

    @callback
    def _remove_climate_listener(self):
        if self._remove_state_listener:
            self._remove_state_listener()
            self._remove_state_listener = None

    @callback
    def _async_update(self):
        entity_ids = tuple((self.zone_group or {}).get("entity_ids", []))
        if entity_ids != self._tracked_entities:
            self._remove_climate_listener()
            self._tracked_entities = entity_ids
            if entity_ids:
                self._remove_state_listener = async_track_state_change_event(
                    self.hass, entity_ids, self._async_climate_changed,
                )
        self.async_write_ha_state()

    @callback
    def _async_climate_changed(self, event):
        self.async_write_ha_state()
