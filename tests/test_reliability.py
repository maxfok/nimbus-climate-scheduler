"""Atomic group schedule persistence and stale-write regressions."""
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from homeassistant.exceptions import HomeAssistantError

from custom_components.nimbus_climate_scheduler.scheduler import NimbusClimateScheduler
from custom_components.nimbus_climate_scheduler.store import NimbusClimateSchedulerStore
from tests.test_scheduler import make_zone


@pytest.fixture
async def group_backend(hass):
    store = NimbusClimateSchedulerStore(hass)
    store.data = {
        'climates': [
            {'entity': 'climate.one', 'name': 'Room', 'zone_id': 'room'},
            {'entity': 'climate.two', 'name': 'Room', 'zone_id': 'room'},
        ],
        'zones': {'climate.one': make_zone(), 'climate.two': make_zone()},
    }
    return store, NimbusClimateScheduler(hass, store, [])


async def test_group_schedule_write_is_atomic_and_rejects_stale(group_backend):
    store, scheduler = group_backend
    updated = make_zone()
    updated['modes']['heat']['draftWeek']['Mon'][0]['temp'] = 21
    assert await scheduler.async_set_group_schedule('room', 0, updated) == 1
    assert store.get_zone('climate.one') == updated
    assert store.get_zone('climate.two') == updated
    snapshot = deepcopy(store.data)
    with pytest.raises(HomeAssistantError, match='changed elsewhere'):
        await scheduler.async_set_group_schedule('room', 0, make_zone())
    assert store.data == snapshot


async def test_group_schedule_failed_persistence_keeps_committed_state(group_backend):
    store, scheduler = group_backend
    snapshot = deepcopy(store.data)
    store._store.async_save = AsyncMock(side_effect=OSError('disk full'))
    with pytest.raises(OSError, match='disk full'):
        await scheduler.async_set_group_schedule('room', 0, make_zone())
    assert store.data == snapshot


async def test_two_simultaneous_saves_only_one_wins(group_backend):
    import asyncio

    store, scheduler = group_backend
    first, second = make_zone(), make_zone()
    first['modes']['heat']['draftWeek']['Mon'][0]['temp'] = 21
    second['modes']['heat']['draftWeek']['Mon'][0]['temp'] = 22
    results = await asyncio.gather(
        scheduler.async_set_group_schedule('room', 0, first),
        scheduler.async_set_group_schedule('room', 0, second),
        return_exceptions=True,
    )
    assert sum(result == 1 for result in results) == 1
    assert sum(isinstance(result, HomeAssistantError) for result in results) == 1
    assert store.get_zone('climate.one') == store.get_zone('climate.two')


async def test_membership_rejects_snapshot_older_than_schedule_write(group_backend):
    store, scheduler = group_backend
    before_revision = store.data.get('store_revision', 0)
    await scheduler.async_set_group_schedule('room', 0, make_zone())
    before = deepcopy(store.data)
    with pytest.raises(HomeAssistantError, match='changed elsewhere'):
        await scheduler.async_set_climates([{'entity': 'climate.one', 'name': 'Room'}], before_revision)
    assert store.data == before


async def test_membership_change_invalidates_old_schedule_revision(group_backend):
    store, scheduler = group_backend
    before_revision = store.data.get('store_revision', 0)
    await scheduler.async_set_climates([{'entity': 'climate.one', 'name': 'Room'}], before_revision)
    assert store.zone_groups()[0]['id'] == 'room'
    assert store.data['schedule_revisions']['room'] == 1
    before = deepcopy(store.data)
    with pytest.raises(HomeAssistantError, match='changed elsewhere'):
        await scheduler.async_set_group_schedule('room', 0, make_zone())
    assert store.data == before


async def test_membership_failed_persistence_is_atomic(group_backend):
    store, scheduler = group_backend
    before = deepcopy(store.data)
    store._store.async_save = AsyncMock(side_effect=OSError('disk full'))
    with pytest.raises(OSError, match='disk full'):
        await scheduler.async_set_climates([{'entity': 'climate.one', 'name': 'Room'}], 0)
    assert store.data == before


@pytest.mark.timeout(10)
async def test_websocket_rejects_stale_membership_and_preserves_data(hass, group_backend, hass_ws_client):
    from custom_components.nimbus_climate_scheduler.const import DOMAIN
    from custom_components.nimbus_climate_scheduler.websocket import async_setup_websocket_api

    store, scheduler = group_backend
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler}
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    await client.send_json({'id': 1, 'type': f'{DOMAIN}/get_zones'})
    read = await client.receive_json()
    assert read['success']
    await client.send_json({'id': 2, 'type': f'{DOMAIN}/save_group_schedule', 'zone_id': 'room', 'expected_revision': 0, 'data': make_zone()})
    assert (await client.receive_json())['success']
    before = deepcopy(store.data)
    await client.send_json({'id': 3, 'type': f'{DOMAIN}/set_climates', 'expected_store_revision': 0,
                            'climates': [{'entity': 'climate.one', 'name': 'Room'}]})
    reply = await client.receive_json()
    assert not reply['success'] and reply['error']['code'] == 'conflict'
    assert store.data == before


@pytest.mark.timeout(10)
async def test_websocket_subscription_notifies_for_schedule_and_pause(hass, group_backend, hass_ws_client):
    from custom_components.nimbus_climate_scheduler.const import DOMAIN
    from custom_components.nimbus_climate_scheduler.websocket import async_setup_websocket_api

    store, scheduler = group_backend
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler}
    client = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    await client.send_json({'id': 1, 'type': f'{DOMAIN}/subscribe'})
    assert (await client.receive_json())['success']
    await client.send_json({'id': 2, 'type': f'{DOMAIN}/save_group_schedule', 'zone_id': 'room',
                            'expected_revision': 0, 'data': make_zone()})
    messages = [await client.receive_json(), await client.receive_json()]
    assert any(m.get('type') == 'event' and m.get('id') == 1 for m in messages)
    assert any(m.get('id') == 2 and m.get('success') for m in messages)
    await scheduler.async_set_automation_pause(['climate.one', 'climate.two'], True, 'automation')
    event = await client.receive_json()
    assert event['type'] == 'event' and event['id'] == 1


@pytest.mark.timeout(10)
async def test_two_websocket_editors_receive_notification_and_reject_stale_write(hass, group_backend, hass_ws_client):
    from custom_components.nimbus_climate_scheduler.const import DOMAIN
    from custom_components.nimbus_climate_scheduler.websocket import async_setup_websocket_api

    store, scheduler = group_backend
    hass.data[DOMAIN] = {'store': store, 'scheduler': scheduler}
    first = await hass_ws_client(hass)
    second = await hass_ws_client(hass)
    async_setup_websocket_api(hass)
    for client in (first, second):
        await client.send_json({'id': 1, 'type': f'{DOMAIN}/get_zones'})
        assert (await client.receive_json())['success']
    await second.send_json({'id': 2, 'type': f'{DOMAIN}/subscribe'})
    assert (await second.receive_json())['success']
    changed = make_zone()
    changed['modes']['heat']['savedWeek']['Mon'][0]['temp'] = 22
    await first.send_json({'id': 2, 'type': f'{DOMAIN}/save_group_schedule', 'zone_id': 'room',
                           'expected_revision': 0, 'data': changed})
    assert (await first.receive_json())['success']
    assert (await second.receive_json())['type'] == 'event'
    await second.send_json({'id': 3, 'type': f'{DOMAIN}/get_zones'})
    result = await second.receive_json()
    assert result['result']['zones']['climate.one']['modes']['heat']['savedWeek']['Mon'][0]['temp'] == 22
    draft = make_zone(); draft['modes']['heat']['draftWeek']['Mon'][0]['temp'] = 24
    await second.send_json({'id': 4, 'type': f'{DOMAIN}/save_group_schedule', 'zone_id': 'room',
                            'expected_revision': 0, 'data': draft})
    reply = await second.receive_json()
    assert not reply['success'] and reply['error']['code'] == 'conflict'
    assert store.get_zone('climate.one') == changed


async def test_distinct_zones_save_with_independent_schedule_revisions(group_backend):
    store, scheduler = group_backend
    store.data['climates'].append({'entity': 'climate.other', 'name': 'Other', 'zone_id': 'other'})
    store.data['zones']['climate.other'] = make_zone()
    assert await scheduler.async_set_group_schedule('room', 0, make_zone()) == 1
    assert await scheduler.async_set_group_schedule('other', 0, make_zone()) == 1
    assert store.data['schedule_revisions'] == {'room': 1, 'other': 1}
    assert store.data['store_revision'] == 2


@pytest.mark.parametrize('attributes', [
    {'hvac_modes': ['cool'], 'min_temp': 5, 'max_temp': 35, 'target_temp_step': 0.5},
    {'hvac_modes': ['heat'], 'min_temp': 25, 'max_temp': 30, 'target_temp_step': 0.5},
    {'hvac_modes': ['heat'], 'min_temp': 5, 'max_temp': 35, 'target_temp_step': 3},
])
async def test_adding_incompatible_thermostat_is_rejected_atomically(hass, group_backend, attributes):
    store, scheduler = group_backend
    base = {'hvac_modes': ['heat'], 'min_temp': 5, 'max_temp': 35, 'target_temp_step': 0.5}
    hass.states.async_set('climate.one', 'heat', base)
    hass.states.async_set('climate.two', 'heat', base)
    hass.states.async_set('climate.new', 'heat', attributes)
    before = deepcopy(store.data)
    climates = [{'entity': e, 'name': 'Room'} for e in ('climate.one', 'climate.two', 'climate.new')]
    with pytest.raises(HomeAssistantError):
        await scheduler.async_set_climates(climates, 0)
    assert store.data == before


async def test_adding_compatible_thermostat_preserves_schedule_and_pause(hass, group_backend):
    store, scheduler = group_backend
    attrs = {'hvac_modes': ['heat', 'cool'], 'min_temp': 5, 'max_temp': 35, 'target_temp_step': 0.5}
    for entity in ('climate.one', 'climate.two', 'climate.new'):
        hass.states.async_set(entity, 'heat', attrs)
    before = store.get_zone('climate.one')
    await scheduler.async_set_automation_pause(['climate.one', 'climate.two'], True, 'automation')
    climates = [{'entity': e, 'name': 'Room'} for e in ('climate.one', 'climate.two', 'climate.new')]
    await scheduler.async_set_climates(climates, store.data['store_revision'])
    assert store.get_zone('climate.new') == before
    assert store.pause_reason('climate.new') == 'automation'
    assert store.zone_groups()[0]['id'] == 'room'


async def test_recovered_thermostat_stays_manual_while_paused(hass, group_backend):
    from datetime import datetime
    store, scheduler = group_backend
    attrs = {'temperature': 16, 'hvac_modes': ['heat'], 'min_temp': 5, 'max_temp': 35, 'target_temp_step': 0.5}
    hass.states.async_set('climate.one', 'unavailable', attrs)
    assert scheduler.build_plan('climate.one', datetime(2026, 6, 22, 12)) is None
    await scheduler.async_set_automation_pause(['climate.one', 'climate.two'], True, 'automation')
    hass.states.async_set('climate.one', 'heat', attrs)
    assert scheduler.build_plan('climate.one', datetime(2026, 6, 22, 12)) is None
    scheduler.async_tick = AsyncMock()
    await scheduler.async_set_automation_pause(['climate.one', 'climate.two'], False)
    plan = scheduler.build_plan('climate.one', datetime(2026, 6, 22, 12))
    assert plan is not None and plan.target_temp == 20
    scheduler.async_tick.assert_awaited_once()


async def test_renaming_group_does_not_require_unavailable_members(hass, group_backend):
    store, scheduler = group_backend
    original = deepcopy(store.data['zones'])
    await scheduler.async_set_climates([
        {'entity': 'climate.one', 'name': 'Renamed'},
        {'entity': 'climate.two', 'name': 'Renamed'},
    ], 0)
    assert store.zone_groups()[0]['id'] == 'room'
    assert store.data['zones'] == original
