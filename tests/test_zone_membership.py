"""Zone membership changes must carry destination, not thermostat, state."""
from copy import deepcopy

import pytest
from custom_components.nimbus_climate_scheduler.store import NimbusClimateSchedulerStore
from tests.test_scheduler import make_zone


@pytest.fixture
async def zones(hass):
    store = NimbusClimateSchedulerStore(hass)
    a, b = make_zone(), make_zone()
    for day in a['modes']['heat']['savedWeek'].values():
        day[0]['temp'] = 18
    for day in b['modes']['heat']['savedWeek'].values():
        day[0]['temp'] = 23
    store.data = {'climates': [
        {'entity': 'climate.a1', 'name': 'Away', 'zone_id': 'a'},
        {'entity': 'climate.a2', 'name': 'Away', 'zone_id': 'a'},
        {'entity': 'climate.b1', 'name': 'Home', 'zone_id': 'b'},
        {'entity': 'climate.b2', 'name': 'Home', 'zone_id': 'b'}],
        'zones': {'climate.a1': deepcopy(a), 'climate.a2': deepcopy(a),
                  'climate.b1': deepcopy(b), 'climate.b2': deepcopy(b)}}
    await store.async_set_automation_pause(['climate.a1', 'climate.a2'], True, 'automation')
    return store, a, b


def configs(store, move=None, add=None, remove=()):
    result = [{'entity': item['entity'], 'name': move.get(item['entity'], item['name']) if move else item['name']}
              for item in store.get_climates() if item['entity'] not in remove]
    if add:
        result.append(add)
    return result


async def test_move_paused_to_active(zones):
    store, _, active = zones
    await store.async_set_climates(configs(store, move={'climate.a1': 'Home'}))
    assert not store.is_automation_paused('climate.a1')
    assert store.pause_reason('climate.a1') is None
    assert store.get_zone('climate.a1') == active
    assert store.is_automation_paused('climate.a2')
    assert next(g for g in store.zone_groups() if g['name'] == 'Home')['id'] == 'b'


async def test_move_active_to_paused(zones):
    store, paused, _ = zones
    await store.async_set_climates(configs(store, move={'climate.b1': 'Away'}))
    assert store.is_automation_paused('climate.b1')
    assert store.pause_reason('climate.b1') == 'automation'
    assert store.get_zone('climate.b1') == paused
    assert not store.is_automation_paused('climate.b2')


async def test_add_thermostat_to_paused_zone(zones):
    store, paused, _ = zones
    await store.async_set_climates(configs(store, add={'entity': 'climate.new', 'name': 'Away'}))
    assert store.is_automation_paused('climate.new')
    assert store.pause_reason('climate.new') == 'automation'
    assert store.get_zone('climate.new') == paused


async def test_delete_last_member_clears_pause(zones):
    store, _, _ = zones
    await store.async_set_climates(configs(store, remove={'climate.a1', 'climate.a2'}))
    assert not store.is_automation_paused('climate.a1')
    assert not store.is_automation_paused('climate.a2')
    assert store.pause_reason('climate.a1') is None
    assert store.get_zone('climate.a1') is None
    assert all(group['id'] != 'a' for group in store.zone_groups())
    await store.async_set_climates(configs(store, add={'entity': 'climate.a1', 'name': 'Home'}))
    assert not store.is_automation_paused('climate.a1')
