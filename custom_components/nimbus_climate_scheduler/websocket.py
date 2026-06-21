from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .scheduler import DAY_LENGTH_MINUTES, NimbusClimateScheduler

# Validate persisted schedules at the boundary so a malformed payload can never
# be stored and then crash the scheduler tick on every run.
_SETPOINT_SCHEMA = vol.Schema({
    vol.Required("minute"): vol.All(vol.Coerce(int), vol.Range(min=0, max=DAY_LENGTH_MINUTES - 1)),
    vol.Required("temp"): vol.Any(int, float),
}, extra=vol.ALLOW_EXTRA)

_WEEK_SCHEMA = vol.Schema({str: [_SETPOINT_SCHEMA]})

_MODE_SCHEMA = vol.Schema({
    vol.Optional("savedWeek"): _WEEK_SCHEMA,
    vol.Optional("draftWeek"): _WEEK_SCHEMA,
}, extra=vol.ALLOW_EXTRA)

_ZONE_DATA_SCHEMA = vol.Schema({
    vol.Optional("scheduleMode"): vol.Any(None, str),
    vol.Optional("activeScheduleMode"): vol.Any(None, str),
    vol.Optional("modes"): vol.Schema({str: _MODE_SCHEMA}),
}, extra=vol.ALLOW_EXTRA)


def async_setup_websocket_api(hass: HomeAssistant) -> None:
    """Register websocket commands for the scheduler panel."""

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/get_zones",
    })
    @websocket_api.async_response
    async def websocket_get_zones(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        # Read endpoint — NOT admin-only, because the read-only dashboard card
        # calls it from any user's dashboard. A non-admin only gets zones for
        # climate entities they're allowed to read (mutating commands stay admin).
        scheduler: NimbusClimateScheduler = hass.data[DOMAIN]["scheduler"]
        data = scheduler.as_dict()
        user = connection.user
        if not user.is_admin:
            perms = user.permissions
            zones = data.get("zones") or {}
            data["zones"] = {
                entity_id: zone
                for entity_id, zone in zones.items()
                if perms.check_entity(entity_id, POLICY_READ)
            }
            for key in ("climates", "configured_climates"):
                items = data.get(key)
                if isinstance(items, list):
                    data[key] = [
                        entry for entry in items
                        if entry.get("entity") and perms.check_entity(entry["entity"], POLICY_READ)
                    ]
        connection.send_result(msg["id"], data)

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/save_zone",
        vol.Required("entity_id"): cv.entity_domain("climate"),
        vol.Required("data"): _ZONE_DATA_SCHEMA,
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_save_zone(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        scheduler: NimbusClimateScheduler = hass.data[DOMAIN]["scheduler"]
        await scheduler.async_set_zone(msg["entity_id"], msg["data"])
        connection.send_result(msg["id"], {"saved": msg["entity_id"]})

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/set_climates",
        vol.Required("climates"): [
            vol.Schema({
                vol.Required("entity"): cv.entity_domain("climate"),
                vol.Optional("name"): vol.Any(None, str),
            }, extra=vol.ALLOW_EXTRA)
        ],
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_set_climates(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        store = hass.data[DOMAIN]["store"]
        await store.async_set_climates(msg["climates"])
        connection.send_result(msg["id"], {"climates": store.get_climates()})

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/apply_now",
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_apply_now(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        scheduler: NimbusClimateScheduler = hass.data[DOMAIN]["scheduler"]
        connection.send_result(msg["id"], await scheduler.async_tick())

    websocket_api.async_register_command(hass, websocket_get_zones)
    websocket_api.async_register_command(hass, websocket_save_zone)
    websocket_api.async_register_command(hass, websocket_set_climates)
    websocket_api.async_register_command(hass, websocket_apply_now)
