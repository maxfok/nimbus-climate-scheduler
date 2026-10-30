"""Home Assistant switch for each Nimbus schedule zone."""
import voluptuous as vol

from homeassistant.components.switch import SwitchEntity
from homeassistant.helpers import config_validation as cv
from homeassistant.exceptions import HomeAssistantError
from homeassistant.core import callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN


async def async_setup_entry(hass, entry, async_add_entities):
    _setup_switches(hass, async_add_entities, entry)


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    _setup_switches(hass, async_add_entities)


def _setup_switches(hass, async_add_entities, entry=None):
    scheduler = hass.data[DOMAIN]["scheduler"]
    entities = {}

    @callback
    def update():
        groups = {group["id"]: group for group in scheduler.store.zone_groups()}
        new = []
        for group_id in groups.keys() - entities.keys():
            entity = entities[group_id] = NimbusScheduleSwitch(scheduler, group_id)
            new.append(entity)
        if new:
            async_add_entities(new)
        for group_id in entities.keys() - groups.keys():
            entity = entities.pop(group_id)
            if entity.entity_id:
                registry = er.async_get(hass)
                if registry.async_get(entity.entity_id):
                    registry.async_remove(entity.entity_id)
        for group_id, entity in entities.items():
            if entity.hass:
                entity.async_write_ha_state()

    async def pause_service(call):
        entity = next((item for item in entities.values() if item.entity_id == call.data["entity_id"]), None)
        if entity is None or not entity.available:
            raise HomeAssistantError("Unknown Nimbus schedule switch")
        await entity.async_pause_with_reason(call.data["pause_reason"])

    pause_schema = vol.Schema({
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("pause_reason"): vol.In(["manual", "automation"]),
    })
    hass.services.async_register("switch", "nimbus_pause", pause_service, schema=pause_schema)
    hass.services.async_register(DOMAIN, "nimbus_pause", pause_service, schema=pause_schema)
    cleanup = async_dispatcher_connect(hass, f"{DOMAIN}_groups_updated", update)
    if entry:
        entry.async_on_unload(lambda: hass.services.async_remove("switch", "nimbus_pause"))
        entry.async_on_unload(lambda: hass.services.async_remove(DOMAIN, "nimbus_pause"))
        entry.async_on_unload(cleanup)
    update()


class NimbusScheduleSwitch(SwitchEntity):
    _attr_should_poll = False
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, scheduler, group_id):
        self.scheduler = scheduler
        self.zone_group_id = group_id
        self._attr_unique_id = f"{group_id}_schedule"

    @property
    def zone_group(self):
        return next((g for g in self.scheduler.store.zone_groups() if g["id"] == self.zone_group_id), None)

    @property
    def name(self):
        return f"{self.zone_group['name']} schedule" if self.zone_group else "Nimbus schedule"

    @property
    def available(self):
        return self.zone_group is not None

    @property
    def is_on(self):
        return bool(self.zone_group) and not any(self.scheduler.store.is_automation_paused(e) for e in self.zone_group["entities"])

    @property
    def extra_state_attributes(self):
        return {"nimbus_schedule_zone": self.zone_group_id, "climate_entities": self.zone_group["entities"] if self.zone_group else [],
                "pause_reason": self.pause_reason}

    @property
    def pause_reason(self):
        if not self.zone_group:
            return None
        reasons = [self.scheduler.store.pause_reason(e) for e in self.zone_group["entities"]]
        return "automation" if "automation" in reasons else "manual" if "manual" in reasons else None

    async def async_pause_with_reason(self, pause_reason):
        if self.zone_group:
            await self.scheduler.async_set_automation_pause(self.zone_group["entities"], True, pause_reason)
            self.async_write_ha_state()

    async def async_turn_on(self, **kwargs):
        if self.zone_group:
            await self.scheduler.async_set_automation_pause(self.zone_group["entities"], False)
            self.async_write_ha_state()

    async def async_turn_off(self, **kwargs):
        if self.zone_group:
            await self.scheduler.async_set_automation_pause(self.zone_group["entities"], True)
            self.async_write_ha_state()
