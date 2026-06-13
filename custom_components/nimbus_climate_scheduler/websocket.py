from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .scheduler import NimbusClimateScheduler


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
        scheduler: NimbusClimateScheduler = hass.data[DOMAIN]["scheduler"]
        connection.send_result(msg["id"], scheduler.as_dict())

    @websocket_api.websocket_command({
        vol.Required("type"): f"{DOMAIN}/save_zone",
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("data"): dict,
    })
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
                vol.Required("entity"): cv.entity_id,
                vol.Optional("name"): vol.Any(None, str),
            }, extra=vol.ALLOW_EXTRA)
        ],
    })
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
