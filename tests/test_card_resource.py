"""Tests for race-free scheduler card resource registration."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from homeassistant.components.lovelace.const import (
    CONF_RESOURCE_TYPE_WS,
    LOVELACE_DATA,
    MODE_STORAGE,
    MODE_YAML,
)
from homeassistant.const import CONF_ID, CONF_TYPE, CONF_URL

from custom_components.nimbus_climate_scheduler import (
    _async_register_card_resource,
    _sync_card_asset,
)
from custom_components.nimbus_climate_scheduler.const import (
    CARD_FALLBACK_MODULE_URL,
    CARD_JS_FILENAME,
    CARD_MODULE_URL,
    CARD_PUBLIC_PATH,
)


def make_hass(items, resource_mode=MODE_STORAGE):
    """Return a minimal hass object with a lazy resource collection."""
    resources = SimpleNamespace(
        async_get_info=AsyncMock(return_value={"resources": len(items)}),
        async_items=Mock(return_value=items),
        async_create_item=AsyncMock(),
        async_update_item=AsyncMock(),
    )
    hass = SimpleNamespace(data={
        LOVELACE_DATA: SimpleNamespace(
            resource_mode=resource_mode,
            resources=resources,
        ),
    })
    return hass, resources


@pytest.mark.asyncio
async def test_registers_missing_card_as_module_resource() -> None:
    """Storage mode creates the awaited card resource exactly once."""
    hass, resources = make_hass([])

    assert await _async_register_card_resource(hass) is True
    resources.async_create_item.assert_awaited_once_with({
        CONF_RESOURCE_TYPE_WS: "module",
        CONF_URL: CARD_MODULE_URL,
    })


@pytest.mark.asyncio
async def test_current_card_resource_is_left_unchanged() -> None:
    """Repeated setup does not rewrite or duplicate the current resource."""
    hass, resources = make_hass([{
        CONF_ID: "resource-id",
        CONF_TYPE: "module",
        CONF_URL: CARD_MODULE_URL,
    }])

    assert await _async_register_card_resource(hass) is True
    resources.async_create_item.assert_not_awaited()
    resources.async_update_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_versioned_card_resource_is_updated_not_duplicated() -> None:
    """A cache query is updated in place when the card version changes."""
    hass, resources = make_hass([{
        CONF_ID: "resource-id",
        CONF_TYPE: "module",
        CONF_URL: f"{CARD_PUBLIC_PATH}?v=0.2.10",
    }])

    assert await _async_register_card_resource(hass) is True
    resources.async_create_item.assert_not_awaited()
    resources.async_update_item.assert_awaited_once_with(
        "resource-id",
        {
            CONF_RESOURCE_TYPE_WS: "module",
            CONF_URL: CARD_MODULE_URL,
        },
    )


@pytest.mark.asyncio
async def test_existing_legacy_resource_is_upgraded_to_module() -> None:
    """The matching resource uses module semantics required by Lovelace."""
    hass, resources = make_hass([{
        CONF_ID: "resource-id",
        CONF_TYPE: "js",
        CONF_URL: CARD_FALLBACK_MODULE_URL,
    }])

    assert await _async_register_card_resource(hass) is True
    resources.async_update_item.assert_awaited_once_with(
        "resource-id",
        {
            CONF_RESOURCE_TYPE_WS: "module",
            CONF_URL: CARD_MODULE_URL,
        },
    )
    resources.async_create_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_yaml_resource_mode_keeps_frontend_fallback() -> None:
    """YAML resources are user-managed and must not be mutated."""
    hass, resources = make_hass([], resource_mode=MODE_YAML)

    assert await _async_register_card_resource(hass) is False
    resources.async_get_info.assert_not_awaited()
    resources.async_create_item.assert_not_awaited()


def test_card_asset_is_published_atomically_and_only_when_changed(tmp_path) -> None:
    """The startup-safe /local copy is stable across unchanged reloads."""
    source = tmp_path / "frontend" / CARD_JS_FILENAME
    target = tmp_path / "www" / CARD_JS_FILENAME
    source.parent.mkdir()
    source.write_text("version one", encoding="utf-8")

    assert _sync_card_asset(source, target) is True
    assert target.read_text(encoding="utf-8") == "version one"
    assert _sync_card_asset(source, target) is False

    source.write_text("version two", encoding="utf-8")
    assert _sync_card_asset(source, target) is True
    assert target.read_text(encoding="utf-8") == "version two"
    assert not target.with_name(f".{target.name}.tmp").exists()
