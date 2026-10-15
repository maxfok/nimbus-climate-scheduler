"""Migration, real HA automation controls, and scheduler/control ordering."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock, patch

import pytest
import voluptuous as vol
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.util.unit_system import US_CUSTOMARY_SYSTEM
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.nimbus_climate_scheduler.const import DOMAIN
from custom_components.nimbus_climate_scheduler.scheduler import NimbusClimateScheduler
from custom_components.nimbus_climate_scheduler.store import NimbusClimateSchedulerStore
from custom_components.nimbus_climate_scheduler.websocket import async_setup_websocket_api

from .test_scheduler import make_zone

pytestmark = pytest.mark.usefixtures("enable_custom_integrations")


@pytest.fixture
async def backend(hass, hass_storage):
    original = {
        "climates": [{"entity": entity, "name": "Living room"} for entity in ("climate.left", "climate.right")],
        "zones": {entity: make_zone() for entity in ("climate.left", "climate.right")},
    }
    original["zones"]["climate.left"]["modes"]["heat"]["draftWeek"] = deepcopy(original["zones"]["climate.left"]["modes"]["heat"]["savedWeek"])
    original["zones"]["climate.left"]["modes"]["heat"]["draftWeek"]["Tue"][0]["temp"] = 23
    hass_storage[DOMAIN] = {"version": 1, "minor_version": 1, "key": DOMAIN, "data": deepcopy(original)}
    store = NimbusClimateSchedulerStore(hass)
    await store.async_load()
    for entity in original["zones"]:
        hass.states.async_set(entity, "heat", {
            "hvac_modes": ["off", "heat", "cool"], "temperature": 20,
            "min_temp": 5, "max_temp": 35,
        })
    scheduler = NimbusClimateScheduler(hass, store, [])
    hass.data[DOMAIN] = {"store": store, "scheduler": scheduler}
    return store, scheduler, original


async def test_additive_migration_and_stable_group_identity(hass, backend):
    store, _, original = backend
    assert store.as_dict()["zones"] == original["zones"]
    group_id = store.zone_groups()[0]["id"]
    assert len(store.zone_groups()) == 1

    await store.async_set_climates([
        {"entity": "climate.right", "name": "Renamed"},
        {"entity": "climate.left", "name": "Renamed"},
    ])
    assert store.zone_groups()[0]["id"] == group_id
    assert store.as_dict()["zones"] == original["zones"]
    await store.async_set_climates([{"entity": "climate.right", "name": "Renamed"}])
    reloaded = NimbusClimateSchedulerStore(hass)
    await reloaded.async_load()
    assert reloaded.zone_groups()[0]["id"] == group_id
    assert reloaded.get_zone("climate.right") == {**original["zones"]["climate.right"], "revision": 1}


async def test_zone_setup_inherits_existing_plan_even_when_new_member_sorts_first(hass, backend):
    store, scheduler, original = backend
    hass.states.async_set("climate.additional", "heat", {
        "hvac_modes": ["heat"], "temperature": 15, "min_temp": 5, "max_temp": 30,
    })
    group_id = store.zone_groups()[0]["id"]
    await scheduler.async_set_climates([
        {"entity": entity, "name": "Living room"}
        for entity in ("climate.additional", "climate.right", "climate.left")
    ], expected_revision=0)
    assert store.zone_groups()[0]["id"] == group_id
    assert store.get_zone("climate.additional") == {**original["zones"]["climate.left"], "revision": 1}
    for entity in original["zones"]:
        assert store.get_zone(entity) == {**original["zones"][entity], "revision": 1}
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await scheduler.async_set_zone("climate.left", original["zones"]["climate.left"], expected_revision=0)


async def test_stale_zone_setup_cannot_undo_membership_changes(backend):
    store, scheduler, _ = backend
    climates = store.get_climates()
    await change_members(backend, ["climate.left"])
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="zone list changed"):
        await scheduler.async_set_climates(climates, expected_revision=0)
    assert store.as_dict() == before


async def test_zone_setup_rejects_duplicate_thermostats_and_merging_existing_plans(backend):
    store, scheduler, _ = backend
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="only appear once"):
        await scheduler.async_set_climates([{"entity": "climate.left"}, {"entity": "climate.left"}])
    assert store.as_dict() == before
    await scheduler.async_set_climates([
        {"entity": "climate.left", "name": "Living room"},
        {"entity": "climate.right", "name": "Bedroom"},
    ])
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="distinct names"):
        await scheduler.async_set_climates([
            {"entity": "climate.left", "name": "Merged"},
            {"entity": "climate.right", "name": "Merged"},
        ])
    assert store.as_dict() == before


async def test_zone_setup_applies_the_same_member_compatibility_checks(hass, backend):
    store, scheduler, _ = backend
    hass.states.async_set("climate.additional", "cool", {"hvac_modes": ["cool"]})
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="schedule mode"):
        await scheduler.async_set_climates([
            *store.get_climates(), {"entity": "climate.additional", "name": "Living room"},
        ])
    assert store.as_dict() == before


async def test_failed_write_keeps_last_committed_state(backend):
    store, scheduler, _ = backend
    before = store.as_dict()
    store._store.async_save = AsyncMock(side_effect=OSError("disk full"))
    with pytest.raises(OSError):
        await scheduler.async_set_control("climate.left", enabled=False)
    assert store.as_dict() == before


async def test_pause_resume_and_mode_preserve_schedules(hass, backend):
    store, scheduler, original = backend
    scheduler.async_tick = AsyncMock()
    await scheduler.async_set_control("climate.left", enabled=False)
    scheduler.async_tick.assert_not_awaited()
    for entity in original["zones"]:
        zone = store.get_zone(entity)
        assert zone["activeScheduleMode"] is None
        assert zone["resumeScheduleMode"] == "heat"
        assert zone["modes"] == original["zones"][entity]["modes"]
    await scheduler.async_set_control("climate.right", mode="cool")
    assert all(store.get_zone(entity)["activeScheduleMode"] is None for entity in original["zones"])
    scheduler.async_tick.assert_not_awaited()
    await scheduler.async_set_control("climate.left", enabled=True)
    assert all(store.get_zone(entity)["activeScheduleMode"] == "cool" for entity in original["zones"])
    scheduler.async_tick.assert_awaited_once()


async def test_pause_waits_for_in_flight_tick(hass, backend):
    store, scheduler, _ = backend
    started, release = asyncio.Event(), asyncio.Event()
    applied = []

    async def apply(plan):
        started.set()
        await release.wait()
        applied.append(plan.entity_id)

    scheduler.plan_needs_apply = lambda plan: True
    scheduler.async_apply_plan = apply
    tick = asyncio.create_task(scheduler.async_tick())
    await started.wait()
    pause = asyncio.create_task(scheduler.async_set_control("climate.left", enabled=False))
    await asyncio.sleep(0)
    assert not pause.done()
    release.set()
    await tick
    await pause
    applied.clear()
    await scheduler.async_tick()
    assert applied == []


async def test_save_cannot_resume_a_paused_schedule_and_rejects_stale_drafts(backend):
    store, scheduler, _ = backend
    await scheduler.async_set_control("climate.left", enabled=False)
    update = {"modes": deepcopy(store.get_zone("climate.left")["modes"])}
    update["modes"]["heat"]["savedWeek"]["Mon"][0]["temp"] = 21
    await scheduler.async_set_zone("climate.left", update, expected_revision=0)
    assert store.get_zone("climate.left")["activeScheduleMode"] is None
    assert store.get_zone("climate.right")["modes"] == update["modes"]
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await scheduler.async_set_zone("climate.left", update, expected_revision=0)


async def test_unsupported_group_mode_is_rejected_atomically(hass, backend):
    store, scheduler, _ = backend
    hass.states.async_set("climate.right", "heat", {"hvac_modes": ["off", "heat"]})
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="not supported"):
        await scheduler.async_set_control("climate.left", mode="cool")
    assert store.as_dict() == before


async def test_stale_browser_cannot_resurrect_a_deleted_zone(backend):
    store, scheduler, _ = backend
    draft = store.get_zone("climate.left")
    await scheduler.async_set_climates([])
    with pytest.raises(HomeAssistantError, match="Unknown Nimbus zone"):
        await scheduler.async_set_zone("climate.left", draft, expected_revision=0)
    assert store.zone_entity_ids() == []


async def test_real_ha_switch_select_lifecycle(hass, backend):
    store, scheduler, _ = backend
    scheduler.async_tick = AsyncMock()
    hass.config.language = "de"
    # Browser assets are exercised separately; keep this a real HA entity and
    # config-entry lifecycle test without loading the optional frontend wheel.
    hass.config.components.update({"frontend", "http", "lovelace", "panel_custom", "websocket_api"})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    group_id = store.zone_groups()[0]["id"]
    switch_id = registry.async_get_entity_id("switch", DOMAIN, f"{group_id}_schedule")
    select_id = registry.async_get_entity_id("select", DOMAIN, f"{group_id}_schedule_mode")
    assert hass.states.get(switch_id).state == "on"
    assert hass.states.get(select_id).state == "heat"
    assert hass.states.get(switch_id).attributes["friendly_name"] == "Living room Zeitplan"
    assert hass.states.get(select_id).attributes["friendly_name"] == "Living room Zeitplanmodus"

    await hass.services.async_call("switch", "turn_off", {"entity_id": switch_id}, blocking=True)
    await hass.services.async_call("select", "select_option", {"entity_id": select_id, "option": "cool"}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(switch_id).state == "off"
    assert hass.states.get(select_id).state == "cool"
    await hass.services.async_call("switch", "turn_on", {"entity_id": switch_id}, blocking=True)
    await hass.async_block_till_done()
    assert store.get_zone("climate.right")["activeScheduleMode"] == "cool"

    with patch("homeassistant.components.frontend.async_remove_panel"):
        assert await hass.config_entries.async_unload(entry.entry_id)
    hass.data[DOMAIN] = {"store": store, "scheduler": scheduler}
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert len(hass.states.async_all("switch")) == 1
    assert hass.states.get(switch_id).state == "on"
    await scheduler.async_set_climates([])
    await hass.async_block_till_done()
    assert registry.async_get(switch_id) is None
    assert registry.async_get(select_id) is None
    with patch("homeassistant.components.frontend.async_remove_panel"):
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.timeout(10)
async def test_websocket_control_notifies_subscribers(hass, backend, hass_ws_client):
    store, _, _ = backend
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    await client.send_json({"id": 1, "type": f"{DOMAIN}/subscribe"})
    assert (await client.receive_json())["success"]
    await client.send_json({"id": 2, "type": f"{DOMAIN}/set_control", "entity_id": "climate.left", "enabled": False})
    messages = [await client.receive_json(), await client.receive_json()]
    assert any(message.get("success") and message["id"] == 2 for message in messages)
    assert {"id": 1, "type": "event", "event": {}} in messages
    assert store.get_zone("climate.right")["activeScheduleMode"] is None


@pytest.mark.timeout(10)
async def test_readonly_client_cannot_change_schedules(hass, backend, hass_ws_client, hass_read_only_access_token):
    store, _, _ = backend
    client = await hass_ws_client(hass, hass_read_only_access_token)
    async_setup_websocket_api(hass)
    before = store.as_dict()
    await client.send_json({"id": 1, "type": f"{DOMAIN}/get_zones"})
    assert (await client.receive_json())["success"]
    await client.send_json({"id": 2, "type": f"{DOMAIN}/set_control", "entity_id": "climate.left", "enabled": False})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 3, "type": f"{DOMAIN}/set_settings", "settings": {"color_thresholds": {"heat": {"cold": 17}}}})
    assert not (await client.receive_json())["success"]
    assert store.as_dict() == before


async def test_color_settings_validation_persistence_and_conflicts(hass, backend):
    store, _, original = backend
    assert store.get_settings()["color_thresholds"]["heat"] == {"cold": 18, "warm": 20.5, "hot": 22}
    await store.async_set_settings({"color_thresholds": {"heat": {"cold": 12, "warm": 14, "hot": 16}}}, 0)
    valid = store.as_dict()
    for value in (float("nan"), float("inf"), True, 17, 14):
        with pytest.raises(vol.Invalid):
            await store.async_set_settings({"color_thresholds": {"heat": {"cold": value}}})
        assert store.as_dict() == valid
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await store.async_set_settings({"color_thresholds": {"heat": {"cold": 10}}}, 0)
    reloaded = NimbusClimateSchedulerStore(hass)
    await reloaded.async_load()
    assert reloaded.get_settings() == store.get_settings()
    assert reloaded.as_dict()["zones"] == original["zones"]


async def test_number_automation_converts_fahrenheit_to_celsius(hass, backend):
    store, _, _ = backend
    hass.config.units = US_CUSTOMARY_SYSTEM
    hass.config.components.update({"frontend", "http", "lovelace", "panel_custom", "websocket_api"})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    number_id = er.async_get(hass).async_get_entity_id("number", DOMAIN, f"{DOMAIN}_heat_cold_color_threshold")
    state = hass.states.get(number_id)
    assert state.attributes["unit_of_measurement"] == "°F"
    assert float(state.state) == pytest.approx(64.4)
    await hass.services.async_call("number", "set_value", {"entity_id": number_id, "value": 59}, blocking=True)
    await hass.async_block_till_done()
    assert store.get_settings()["color_thresholds"]["heat"]["cold"] == pytest.approx(15)
    assert float(hass.states.get(number_id).state) == pytest.approx(59)
    with pytest.raises(HomeAssistantError, match="ordered"):
        await hass.services.async_call("number", "set_value", {"entity_id": number_id, "value": 80}, blocking=True)
    assert store.get_settings()["color_thresholds"]["heat"]["cold"] == pytest.approx(15)
    with patch("homeassistant.components.frontend.async_remove_panel"):
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.timeout(10)
async def test_websocket_saves_validate_and_return_revisions(hass, backend, hass_ws_client):
    store, _, _ = backend
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    data = {"modes": store.get_zone("climate.left")["modes"]}
    data["modes"]["heat"]["savedWeek"]["Mon"][0]["temp"] = 21
    command = {"type": f"{DOMAIN}/save_zone", "entity_id": "climate.left", "data": data, "expected_revision": 0}
    await client.send_json({"id": 1, **command})
    result = await client.receive_json()
    assert result["success"]
    assert result["result"]["revision"] == 1
    await client.send_json({"id": 2, **command})
    assert (await client.receive_json())["error"]["code"] == "conflict"

    await client.send_json({"id": 3, "type": f"{DOMAIN}/set_settings", "settings": {"color_thresholds": {"heat": {"cold": 30}}}})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 4, "type": f"{DOMAIN}/set_settings", "settings": {"color_thresholds": {"heat": {"cold": 17}}}, "expected_revision": 0})
    result = await client.receive_json()
    assert result["success"]
    assert result["result"]["settings"]["color_thresholds"]["heat"]["cold"] == 17
    assert result["result"]["revision"] == 1


@pytest.mark.timeout(10)
async def test_zone_setup_websocket_rejects_stale_selection(hass, backend, hass_ws_client):
    store, _, _ = backend
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    command = {
        "type": f"{DOMAIN}/set_climates", "expected_revision": 0,
        "climates": [{"entity": "climate.left", "name": "Renamed"}],
    }
    await client.send_json({"id": 1, **command})
    result = await client.receive_json()
    assert result["success"]
    assert result["result"]["revision"] == 1
    before = store.as_dict()
    await client.send_json({"id": 2, **command})
    assert (await client.receive_json())["error"]["code"] == "conflict"
    assert store.as_dict() == before


async def change_members(backend, members, **overrides):
    """Submit the member selection shown by the current editor."""
    store, scheduler, _ = backend
    group = store.zone_groups()[0]
    arguments = {
        "zone_id": group["id"], "source_entity_id": group["entity_ids"][0],
        "entity_ids": members, "expected_entity_ids": group["entity_ids"],
        "expected_revision": store.get_zone(group["entity_ids"][0]).get("revision", 0),
    }
    return await scheduler.async_set_zone_members(**(arguments | overrides))


async def test_new_thermostat_inherits_existing_schedule_and_receives_same_target(hass, backend):
    store, scheduler, _ = backend
    attributes = {"hvac_modes": ["off", "heat"], "temperature": 15, "min_temp": 5, "max_temp": 30}
    for entity in ("climate.left", "climate.new"):
        hass.states.async_set(entity, "heat", attributes)
    original = store.get_zone("climate.left")
    group_id = store.zone_groups()[0]["id"]
    scheduler.async_apply_plan = AsyncMock()
    await change_members(backend, ["climate.new", "climate.left"])
    assert store.zone_groups() == [{"id": group_id, "name": "Living room", "entity_ids": ["climate.left", "climate.new"]}]
    for entity in ("climate.left", "climate.new"):
        saved = store.get_zone(entity)
        assert saved == {**original, "revision": 1}
    plans = [call.args[0] for call in scheduler.async_apply_plan.await_args_list]
    assert {plan.entity_id for plan in plans} == {"climate.left", "climate.new"}
    assert plans[0].target_temp == plans[1].target_temp
    assert plans[0].mode == plans[1].mode == "heat"
    assert store.get_zone("climate.right") is None
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await scheduler.async_set_zone("climate.left", original, expected_revision=0)


async def test_replace_all_members_keeps_paused_plan_and_stable_identity_on_reload(hass, backend):
    store, scheduler, _ = backend
    group_id = store.zone_groups()[0]["id"]
    await scheduler.async_set_control(group_id, enabled=False)
    source = store.get_zone("climate.left")
    hass.states.async_set("climate.replacement", "heat", {
        "hvac_modes": ["off", "heat"], "temperature": 15, "min_temp": 5, "max_temp": 30,
    })
    scheduler.async_tick = AsyncMock()
    await change_members(backend, ["climate.replacement"])
    scheduler.async_tick.assert_not_awaited()
    assert store.get_zone("climate.replacement") == {**source, "revision": 1}
    assert store.get_zone("climate.left") is None
    reloaded = NimbusClimateSchedulerStore(hass)
    await reloaded.async_load()
    assert reloaded.zone_groups()[0]["id"] == group_id
    assert reloaded.as_dict() == store.as_dict()


async def test_membership_failure_and_concurrent_edit_leave_original_state(backend):
    store, scheduler, _ = backend
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await change_members(backend, ["climate.left"], expected_entity_ids=["climate.left"])
    with pytest.raises(HomeAssistantError, match="changed elsewhere"):
        await change_members(backend, ["climate.left"], expected_revision=99)
    store._store.async_save = AsyncMock(side_effect=OSError("disk full"))
    scheduler.async_tick = AsyncMock()
    with pytest.raises(OSError):
        await change_members(backend, ["climate.left"])
    assert store.as_dict() == before
    scheduler.async_tick.assert_not_awaited()


@pytest.mark.parametrize(("state", "attributes", "error"), [
    ("unavailable", {"hvac_modes": ["off", "heat"]}, "unavailable"),
    ("cool", {"hvac_modes": ["off", "cool"]}, "schedule mode"),
    ("fan_only", {"hvac_modes": ["off", "fan_only"]}, "no common"),
    ("heat", {"hvac_modes": ["off", "heat"], "min_temp": 40, "max_temp": 50}, "no overlapping"),
    ("heat", {"hvac_modes": ["off", "heat"], "min_temp": 19, "max_temp": 22}, "existing heat plan"),
])
async def test_incompatible_new_member_does_not_change_the_zone(hass, backend, state, attributes, error):
    store, _, _ = backend
    hass.states.async_set("climate.new", state, attributes)
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match=error):
        await change_members(backend, ["climate.left", "climate.new"])
    assert store.as_dict() == before


async def test_cannot_assign_a_thermostat_from_another_zone(hass, backend):
    store, _, _ = backend
    await store.async_set_climates([
        {"entity": "climate.left", "name": "Living room"},
        {"entity": "climate.right", "name": "Bedroom"},
    ])
    before = store.as_dict()
    with pytest.raises(HomeAssistantError, match="already belongs to Bedroom"):
        await change_members(backend, ["climate.left", "climate.right"])
    assert store.as_dict() == before


async def test_membership_change_updates_the_existing_automation_entities(hass, backend):
    store, scheduler, _ = backend
    scheduler.async_tick = AsyncMock()
    hass.config.components.update({"frontend", "http", "lovelace", "panel_custom", "websocket_api"})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    group_id = store.zone_groups()[0]["id"]
    registry = er.async_get(hass)
    switch_id = registry.async_get_entity_id("switch", DOMAIN, f"{group_id}_schedule")
    select_id = registry.async_get_entity_id("select", DOMAIN, f"{group_id}_schedule_mode")
    hass.states.async_set("climate.new", "heat", {"hvac_modes": ["off", "heat"], "temperature": 20})
    await change_members(backend, ["climate.left", "climate.new"])
    await hass.async_block_till_done()
    assert hass.states.get(switch_id).attributes["climate_entities"] == ["climate.left", "climate.new"]
    assert hass.states.get(select_id).attributes["options"] == ["heat"]
    assert len(hass.states.async_all("switch")) == 1
    await hass.services.async_call("switch", "turn_off", {"entity_id": switch_id}, blocking=True)
    assert store.get_zone("climate.new")["activeScheduleMode"] is None
    assert store.get_zone("climate.left")["activeScheduleMode"] is None
    with patch("homeassistant.components.frontend.async_remove_panel"):
        assert await hass.config_entries.async_unload(entry.entry_id)


@pytest.mark.timeout(10)
async def test_member_selection_websocket_schema_and_permissions(hass, backend, hass_ws_client, hass_read_only_access_token):
    store, scheduler, _ = backend
    scheduler.async_tick = AsyncMock(return_value={"applied": [], "failed": []})
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    group = store.zone_groups()[0]
    message = {
        "type": f"{DOMAIN}/set_zone_members", "zone_id": group["id"], "source_entity_id": "climate.left",
        "entity_ids": ["climate.left"], "expected_entity_ids": group["entity_ids"], "expected_revision": 0,
    }
    before = store.as_dict()
    readonly = await hass_ws_client(hass, hass_read_only_access_token)
    await readonly.send_json({"id": 1, **message})
    assert not (await readonly.receive_json())["success"]
    for request_id, members in enumerate([[], ["climate.left", "climate.left"], ["switch.left"]], 1):
        await client.send_json({"id": request_id, **message, "entity_ids": members})
        assert not (await client.receive_json())["success"]
    assert store.as_dict() == before
    await client.send_json({"id": 4, **message})
    result = await client.receive_json()
    assert result["success"]
    assert result["result"]["group"]["entity_ids"] == ["climate.left"]
    assert result["result"]["revision"] == 1
    await client.send_json({"id": 5, **message})
    assert (await client.receive_json())["error"]["code"] == "invalid_members"
