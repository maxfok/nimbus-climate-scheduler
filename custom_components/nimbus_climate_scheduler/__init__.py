from __future__ import annotations

from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import (
    CONF_CLIMATES,
    CONF_ENTITY,
    CONF_NAME,
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    FRONTEND_PATH,
    PANEL_COMPONENT_NAME,
    PANEL_ICON,
    PANEL_MODULE_URL,
    PANEL_TITLE,
    PANEL_URL,
)
from .scheduler import ClimateConfig, NimbusClimateScheduler
from .store import NimbusClimateSchedulerStore
from .websocket import async_setup_websocket_api

CLIMATE_SCHEMA = vol.Schema({
    vol.Required(CONF_ENTITY): cv.entity_id,
    vol.Optional(CONF_NAME): cv.string,
})

DOMAIN_SCHEMA = vol.Schema({
    vol.Optional(CONF_CLIMATES, default=[]): [CLIMATE_SCHEMA],
    vol.Optional(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): vol.All(
        vol.Coerce(int),
        vol.Range(min=10),
    ),
})

CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Any(None, DOMAIN_SCHEMA),
}, extra=vol.ALLOW_EXTRA)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up from YAML (`nimbus_climate_scheduler:` in configuration.yaml)."""
    hass.data.setdefault(DOMAIN, {})
    if DOMAIN in config:
        await _async_setup_scheduler(hass, config.get(DOMAIN) or {}, config, source="yaml")
    return True


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    """Set up from a config entry (UI)."""
    data = hass.data.setdefault(DOMAIN, {})
    if "scheduler" not in data:
        await _async_setup_scheduler(hass, {}, {}, source="config_entry")
    return True


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload the config entry."""
    data = hass.data.get(DOMAIN) or {}
    if data.get("source") == "config_entry" and "scheduler" in data:
        data["scheduler"].stop()
        frontend.async_remove_panel(hass, PANEL_URL)
        hass.data[DOMAIN] = {}
    return True


async def _async_setup_scheduler(
    hass: HomeAssistant,
    domain_config: dict,
    full_config: dict,
    source: str,
) -> None:
    """Register storage, scheduler loop, websocket API, assets and panel."""
    climates = _configured_climates(domain_config, full_config)

    store = NimbusClimateSchedulerStore(hass)
    await store.async_load()

    scheduler = NimbusClimateScheduler(
        hass=hass,
        store=store,
        climates=climates,
        scan_interval=domain_config.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
    )
    hass.data[DOMAIN] = {
        "store": store,
        "scheduler": scheduler,
        "source": source,
    }
    async_setup_websocket_api(hass)
    scheduler.start()
    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, lambda event: scheduler.stop())

    # Register the static frontend path only once per HA run. It cannot be
    # unregistered, so a config-entry reload must not try to re-add it
    # (that raises RuntimeError and breaks the reload).
    static_flag = f"{DOMAIN}_static_registered"
    if not hass.data.get(static_flag):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    url_path=FRONTEND_PATH,
                    path=str(frontend_dir),
                    cache_headers=False,
                )
            ]
        )
        hass.data[static_flag] = True

    if _panel_custom_is_already_registered(full_config):
        return

    # A previous entry-setup may have left the panel registered (e.g. after a
    # reload); drop it first so re-registration can't raise "Overwriting panel".
    frontend.async_remove_panel(hass, PANEL_URL)

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name=PANEL_COMPONENT_NAME,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=PANEL_MODULE_URL,
        require_admin=False,
        config={
            "domain": DOMAIN,
            CONF_CLIMATES: [
                {"entity": climate.entity, "name": climate.name}
                for climate in climates
            ],
        },
    )


def _configured_climates(domain_config: dict, full_config: dict) -> list[ClimateConfig]:
    entries = domain_config.get(CONF_CLIMATES) or _panel_custom_climates(full_config)
    return [
        ClimateConfig(entity=entry[CONF_ENTITY], name=entry.get(CONF_NAME))
        for entry in entries
        if isinstance(entry, dict) and entry.get(CONF_ENTITY)
    ]


def _panel_custom_climates(config: dict) -> list[dict]:
    for panel in config.get("panel_custom", []) or []:
        panel_config = panel.get("config") or {}
        if panel_config.get("domain") == DOMAIN:
            return panel_config.get(CONF_CLIMATES) or []
    return []


def _panel_custom_is_already_registered(config: dict) -> bool:
    for panel in config.get("panel_custom", []) or []:
        if panel.get("url_path") == PANEL_URL or panel.get("name") == PANEL_COMPONENT_NAME:
            return True
    return False
