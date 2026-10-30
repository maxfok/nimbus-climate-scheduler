"""Regression tests for persisted, zone-wide scheduler pauses."""
from copy import deepcopy
from datetime import datetime
from unittest.mock import AsyncMock, Mock

import pytest

from custom_components.nimbus_climate_scheduler.scheduler import NimbusClimateScheduler
from custom_components.nimbus_climate_scheduler.store import NimbusClimateSchedulerStore
from custom_components.nimbus_climate_scheduler.switch import NimbusScheduleSwitch
from tests.test_scheduler import make_hass, make_state, make_zone


@pytest.fixture
def backend(monkeypatch):
    monkeypatch.setattr("custom_components.nimbus_climate_scheduler.store.async_dispatcher_send", lambda *args: None)
    hass = make_hass({name: make_state() for name in ('climate.left', 'climate.right', 'climate.bedroom')})
    store = NimbusClimateSchedulerStore.__new__(NimbusClimateSchedulerStore)
    store.hass = hass
    store.data = {'zones': {name: make_zone() for name in ('climate.left', 'climate.right', 'climate.bedroom')},
                  'climates': [{'entity': 'climate.left', 'name': 'Living', 'zone_id': 'living'},
                               {'entity': 'climate.right', 'name': 'Living', 'zone_id': 'living'},
                               {'entity': 'climate.bedroom', 'name': 'Bedroom', 'zone_id': 'bedroom'}]}
    store._store = Mock()
    store._store.async_save = AsyncMock()
    scheduler = NimbusClimateScheduler(hass, store, [])
    return hass, store, scheduler


@pytest.mark.asyncio
async def test_pause_group_and_other_zone_remains_active(backend):
    _, store, scheduler = backend
    await scheduler.async_set_automation_pause(['climate.left', 'climate.right'], True, 'automation')
    assert scheduler.build_plan('climate.left', datetime(2026, 6, 22, 12)) is None
    assert scheduler.build_plan('climate.right', datetime(2026, 6, 22, 12)) is None
    assert scheduler.build_plan('climate.bedroom', datetime(2026, 6, 22, 12)) is not None
    assert store.pause_reason('climate.left') == 'automation'


@pytest.mark.asyncio
async def test_single_zone_pause_preserves_manual_change(backend):
    hass, _, scheduler = backend
    await scheduler.async_set_automation_pause(['climate.bedroom'], True)
    hass.states._states['climate.bedroom'].attributes['temperature'] = 17
    assert scheduler.build_plan('climate.bedroom', datetime(2026, 6, 22, 12)) is None
    assert hass.states.get('climate.bedroom').attributes['temperature'] == 17


@pytest.mark.asyncio
async def test_restart_and_resume_clear_reason(backend):
    _, store, scheduler = backend
    await scheduler.async_set_automation_pause(['climate.bedroom'], True, 'automation')
    snapshot = deepcopy(store._store.async_save.await_args.args[0])
    reloaded = NimbusClimateSchedulerStore.__new__(NimbusClimateSchedulerStore)
    reloaded._store = Mock(async_load=AsyncMock(return_value=snapshot))
    await reloaded.async_load()
    assert reloaded.is_automation_paused('climate.bedroom')
    assert reloaded.pause_reason('climate.bedroom') == 'automation'
    scheduler.async_tick = AsyncMock()
    await scheduler.async_set_automation_pause(['climate.bedroom'], False)
    assert not store.is_automation_paused('climate.bedroom')
    assert store.pause_reason('climate.bedroom') is None
    assert 'climate.bedroom' not in store.data['pause_reasons']
    scheduler.async_tick.assert_awaited_once()


@pytest.mark.asyncio
async def test_resume_applies_current_time_not_old_setpoint(backend, monkeypatch):
    _, store, scheduler = backend
    scheduler.async_apply_plan = AsyncMock()
    await scheduler.async_set_automation_pause(['climate.bedroom'], True, 'automation')
    from homeassistant.util import dt as dt_util
    monkeypatch.setattr(dt_util, 'now', lambda: datetime(2026, 6, 22, 23, 0))
    await scheduler.async_set_automation_pause(['climate.bedroom'], False)
    calls = [call.args[0] for call in scheduler.async_apply_plan.await_args_list]
    bedroom = next(plan for plan in calls if plan.entity_id == 'climate.bedroom')
    assert bedroom.target_temp == 18


@pytest.mark.asyncio
async def test_switch_explicit_service_and_attributes(backend):
    _, _, scheduler = backend
    switch = NimbusScheduleSwitch(scheduler, 'living')
    switch.async_write_ha_state = Mock()
    await switch.async_pause_with_reason('automation')
    assert not switch.is_on
    assert switch.extra_state_attributes == {'nimbus_schedule_zone': 'living', 'climate_entities': ['climate.left', 'climate.right'], 'pause_reason': 'automation'}
    scheduler.async_tick = AsyncMock()
    await switch.async_turn_on()
    assert switch.is_on
    assert switch.extra_state_attributes['pause_reason'] is None
    await switch.async_turn_off()
    assert switch.extra_state_attributes['pause_reason'] == 'manual'


@pytest.mark.usefixtures('enable_custom_integrations')
@pytest.mark.asyncio
async def test_real_home_assistant_nimbus_pause_service(hass, hass_storage):
    from homeassistant.helpers import entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from custom_components.nimbus_climate_scheduler.const import DOMAIN

    original = {'climates': [{'entity': 'climate.one', 'name': 'Room'}],
                'zones': {'climate.one': make_zone()}}
    hass_storage[DOMAIN] = {'version': 1, 'minor_version': 1, 'key': DOMAIN, 'data': original}
    store = NimbusClimateSchedulerStore(hass)
    await store.async_load()
    await store.async_initialize_groups([])
    scheduler = NimbusClimateScheduler(hass, store, [])
    scheduler.async_tick = AsyncMock()
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler, 'source': 'config_entry'}
    hass.config.components.update({'frontend', 'http', 'lovelace', 'panel_custom', 'websocket_api'})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    zone_id = store.zone_groups()[0]['id']
    entity_id = er.async_get(hass).async_get_entity_id('switch', DOMAIN, f'{zone_id}_schedule')
    assert entity_id is not None
    hass.states.async_set('climate.one', 'heat', {'temperature': 20, 'hvac_modes': ['off', 'heat']})
    async def manual_temperature(call):
        hass.states.async_set('climate.one', 'heat', {'temperature': call.data['temperature'], 'hvac_modes': ['off', 'heat']})
    hass.services.async_register('climate', 'set_temperature', manual_temperature)
    await hass.services.async_call('switch', 'nimbus_pause', {'entity_id': entity_id, 'pause_reason': 'automation'}, blocking=True)
    assert hass.states.get(entity_id).state == 'off'
    assert hass.states.get(entity_id).attributes['pause_reason'] == 'automation'
    await hass.services.async_call('climate', 'set_temperature', {'entity_id': 'climate.one', 'temperature': 17}, blocking=True)
    assert hass.states.get('climate.one').attributes['temperature'] == 17
    assert scheduler.build_plan('climate.one', datetime(2026, 6, 22, 12)) is None
    reloaded = NimbusClimateSchedulerStore(hass)
    await reloaded.async_load()
    assert reloaded.is_automation_paused('climate.one')
    assert reloaded.pause_reason('climate.one') == 'automation'
    await hass.services.async_call('switch', 'turn_on', {'entity_id': entity_id}, blocking=True)
    assert hass.states.get(entity_id).state == 'on'
    assert hass.states.get(entity_id).attributes['pause_reason'] is None
    import voluptuous as vol
    for service_domain in ('switch', DOMAIN):
        for reason in ('manual', 'automation'):
            await hass.services.async_call(service_domain, 'nimbus_pause', {'entity_id': entity_id, 'pause_reason': reason}, blocking=True)
            assert hass.states.get(entity_id).state == 'off'
            assert hass.states.get(entity_id).attributes['pause_reason'] == reason
            await hass.services.async_call('switch', 'turn_on', {'entity_id': entity_id}, blocking=True)
        with pytest.raises(vol.Invalid):
            await hass.services.async_call(service_domain, 'nimbus_pause', {'entity_id': entity_id, 'pause_reason': 'invalid'}, blocking=True)
        with pytest.raises(vol.Invalid):
            await hass.services.async_call(service_domain, 'nimbus_pause', {'entity_id': entity_id}, blocking=True)


@pytest.mark.usefixtures('enable_custom_integrations')
@pytest.mark.asyncio
async def test_migration_rename_delete_and_reload(hass, hass_storage):
    from homeassistant.helpers import entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    from custom_components.nimbus_climate_scheduler.const import DOMAIN

    original = {'climates': [{'entity': 'climate.one', 'name': 'Room'}],
                'zones': {'climate.one': make_zone()}, 'other_setting': {'keep': 42}}
    snapshot = deepcopy(original)
    hass_storage[DOMAIN] = {'version': 1, 'minor_version': 1, 'key': DOMAIN, 'data': original}
    store = NimbusClimateSchedulerStore(hass)
    await store.async_load()
    await store.async_initialize_groups([])
    assert store.get_zone('climate.one') == snapshot['zones']['climate.one']
    assert store.data['other_setting'] == snapshot['other_setting']
    scheduler = NimbusClimateScheduler(hass, store, [])
    scheduler.async_tick = AsyncMock()
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler, 'source': 'config_entry'}
    hass.config.components.update({'frontend', 'http', 'lovelace', 'panel_custom', 'websocket_api'})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    registry = er.async_get(hass)
    group_id = store.zone_groups()[0]['id']
    unique_id = f'{group_id}_schedule'
    entity_id = registry.async_get_entity_id('switch', DOMAIN, unique_id)
    assert entity_id
    await store.async_set_climates([{'entity': 'climate.one', 'name': 'Renamed'}])
    await hass.async_block_till_done()
    assert store.zone_groups()[0]['id'] == group_id
    assert registry.async_get_entity_id('switch', DOMAIN, unique_id) == entity_id
    assert hass.states.get(entity_id).name == 'Renamed schedule'
    assert store.get_zone('climate.one') == snapshot['zones']['climate.one']
    assert await hass.config_entries.async_unload(entry.entry_id)
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler, 'source': 'config_entry'}
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert registry.async_get_entity_id('switch', DOMAIN, unique_id) == entity_id
    assert len([state for state in hass.states.async_all('switch') if state.attributes.get('nimbus_schedule_zone') == group_id]) == 1
    await store.async_set_climates([])
    await hass.async_block_till_done()
    assert registry.async_get(entity_id) is None
    assert hass.states.get(entity_id) is None


@pytest.mark.usefixtures('enable_custom_integrations')
@pytest.mark.asyncio
async def test_yaml_switch_platform(hass, hass_storage):
    from homeassistant.helpers.discovery import async_load_platform
    from custom_components.nimbus_climate_scheduler.const import DOMAIN
    store = NimbusClimateSchedulerStore(hass)
    await store.async_load()
    await store.async_initialize_groups([{'entity': 'climate.one', 'name': 'Room'}])
    scheduler = NimbusClimateScheduler(hass, store, [])
    scheduler.async_tick = AsyncMock()
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler, 'source': 'yaml'}
    hass.config.components.update({'frontend', 'http', 'lovelace', 'panel_custom', 'websocket_api'})
    await async_load_platform(hass, 'switch', DOMAIN, {}, {})
    await hass.async_block_till_done()
    switches = [state for state in hass.states.async_all('switch') if state.attributes.get('nimbus_schedule_zone')]
    assert len(switches) == 1
    await hass.services.async_call('switch', 'turn_off', {'entity_id': switches[0].entity_id}, blocking=True)
    assert store.is_automation_paused('climate.one')
