from __future__ import annotations

import math
from typing import Any

import voluptuous as vol

from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_UPDATED
from .scheduler import DAYS, DAY_LENGTH_MINUTES, NimbusClimateScheduler
from .settings import SETTINGS_SCHEMA


def _finite_temperature(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise vol.Invalid("Temperature must be a finite number")
    return value


def _ordered_day(points):
    if not points or points[0]["minute"] != 0:
        raise vol.Invalid("The first interval must start at schedule minute 0 (05:00)")
    if any(left["minute"] >= right["minute"] for left, right in zip(points, points[1:])):
        raise vol.Invalid("Interval times must be unique and in increasing order")
    return points


def _schedule_minute(value):
    if type(value) is not int or not 0 <= value < DAY_LENGTH_MINUTES:
        raise vol.Invalid("Schedule minute must be an integer between 0 and 1439")
    return value

# Validate persisted schedules at the boundary so a malformed payload can never
# be stored and then crash the scheduler tick on every run.
_SETPOINT_SCHEMA = vol.Schema({
    vol.Required("minute"): _schedule_minute,
    vol.Required("temp"): _finite_temperature,
}, extra=vol.ALLOW_EXTRA)

_WEEK_SCHEMA = vol.Schema({vol.Required(day): vol.All([_SETPOINT_SCHEMA], _ordered_day) for day in DAYS})

_MODE_SCHEMA = vol.Schema({
    vol.Optional("savedWeek"): _WEEK_SCHEMA,
    vol.Optional("draftWeek"): _WEEK_SCHEMA,
}, extra=vol.ALLOW_EXTRA)

_ZONE_DATA_SCHEMA = vol.Schema({
    vol.Optional("scheduleMode"): vol.In(["heat", "cool"]),
    vol.Optional("activeScheduleMode"): vol.Any(None, vol.In(["heat", "cool"])),
    vol.Optional("modes"): vol.Schema({vol.In(["heat", "cool"]): _MODE_SCHEMA}),
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
        vol.Optional("expected_revision"): vol.All(int, vol.Range(min=0)),
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_save_zone(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        scheduler: NimbusClimateScheduler = hass.data[DOMAIN]["scheduler"]
        try:
            await scheduler.async_set_zone(msg["entity_id"], msg["data"], msg.get("expected_revision"))
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "conflict", str(err))
            return
        zone = scheduler.store.get_zone(msg["entity_id"])
        connection.send_result(msg["id"], {"saved": msg["entity_id"], "revision": zone["revision"]})

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/set_climates",
        vol.Required("climates"): [
            vol.Schema({
                vol.Required("entity"): cv.entity_domain("climate"),
                vol.Optional("name"): vol.Any(None, str),
            }, extra=vol.ALLOW_EXTRA)
        ],
        vol.Optional("expected_revision"): vol.All(int, vol.Range(min=0)),
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_set_climates(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        scheduler = hass.data[DOMAIN]["scheduler"]
        try:
            await scheduler.async_set_climates(msg["climates"], msg.get("expected_revision"))
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "conflict", str(err))
            return
        connection.send_result(msg["id"], {
            "climates": scheduler.store.get_climates(),
            "revision": scheduler.store.data.get("climates_revision", 0),
        })

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/set_zone_members",
        vol.Required("zone_id"): str,
        vol.Required("source_entity_id"): cv.entity_domain("climate"),
        vol.Required("entity_ids"): vol.All([cv.entity_domain("climate")], vol.Length(min=1), vol.Unique()),
        vol.Required("expected_entity_ids"): vol.All([cv.entity_domain("climate")], vol.Length(min=1), vol.Unique()),
        vol.Required("expected_revision"): vol.All(int, vol.Range(min=0)),
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_set_zone_members(hass, connection, msg) -> None:
        scheduler = hass.data[DOMAIN]["scheduler"]
        try:
            result = await scheduler.async_set_zone_members(
                msg["zone_id"], msg["source_entity_id"], msg["entity_ids"],
                msg["expected_entity_ids"], msg["expected_revision"],
            )
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "invalid_members", str(err))
            return
        connection.send_result(msg["id"], result)

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/set_control",
        vol.Required("entity_id"): cv.entity_domain("climate"),
        vol.Optional("enabled"): bool,
        vol.Optional("mode"): vol.In(["heat", "cool"]),
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_set_control(hass, connection, msg) -> None:
        scheduler = hass.data[DOMAIN]["scheduler"]
        try:
            await scheduler.async_set_control(msg["entity_id"], enabled=msg.get("enabled"), mode=msg.get("mode"))
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "invalid_control", str(err))
            return
        connection.send_result(msg["id"])

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/subscribe",
    })
    @callback
    def websocket_subscribe(hass, connection, msg) -> None:
        # Notifications contain no zone data. Each client refetches through the
        # permission-filtered read endpoint, including after a reconnect.
        @callback
        def notify():
            connection.send_event(msg["id"], {})

        connection.subscriptions[msg["id"]] = async_dispatcher_connect(
            hass, SIGNAL_UPDATED, notify,
        )
        connection.send_result(msg["id"])

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/set_settings",
        vol.Required("settings"): SETTINGS_SCHEMA,
        vol.Optional("expected_revision"): vol.All(int, vol.Range(min=0)),
    })
    @websocket_api.require_admin
    @websocket_api.async_response
    async def websocket_set_settings(hass, connection, msg) -> None:
        store = hass.data[DOMAIN]["store"]
        try:
            await store.async_set_settings(msg["settings"], msg.get("expected_revision"))
        except (vol.Invalid, HomeAssistantError) as err:
            connection.send_error(msg["id"], "invalid_settings", str(err))
            return
        connection.send_result(msg["id"], {
            "settings": store.get_settings(), "revision": store.data["settings_revision"],
        })

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
    websocket_api.async_register_command(hass, websocket_set_control)
    websocket_api.async_register_command(hass, websocket_subscribe)
    websocket_api.async_register_command(hass, websocket_set_settings)
    websocket_api.async_register_command(hass, websocket_set_zone_members)
