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
