"""Temporary external setpoint override behaviour."""
from datetime import datetime

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Context
from homeassistant.util import dt as dt_util

from custom_components.nimbus_climate_scheduler.scheduler import NimbusClimateScheduler, next_schedule_boundary
from custom_components.nimbus_climate_scheduler.store import NimbusClimateSchedulerStore
from tests.test_scheduler import make_week, make_zone


def test_next_boundary_uses_next_day_at_five():
    week = make_week()
    assert next_schedule_boundary(week, datetime(2026, 6, 22, 23, 30)) == datetime(2026, 6, 23, 5)
    assert next_schedule_boundary(week, datetime(2026, 6, 23, 4, 59)) == datetime(2026, 6, 23, 5)


async def test_external_attribute_change_holds_and_restarts(hass):
    entity = "climate.room"
    store = NimbusClimateSchedulerStore(hass)
    store.data = {"zones": {entity: make_zone()}}
    scheduler = NimbusClimateScheduler(hass, store, [])
    remove = hass.bus.async_listen(EVENT_STATE_CHANGED, scheduler._state_changed)
    hass.states.async_set(entity, "heat", {"temperature": 20})
    await hass.async_block_till_done()
    hass.states.async_set(entity, "heat", {"temperature": 22})
    await hass.async_block_till_done()
    assert scheduler._overrides[entity]["temperature"] == 22
    assert store.data["temporary_overrides"][entity]["temperature"] == 22
    restored = NimbusClimateScheduler(hass, store, [])
    assert restored._overrides == scheduler._overrides
    plan = scheduler.build_plan(entity, dt_util.now())
    assert plan is not None
    result = await scheduler.async_tick()
    assert entity not in result["applied"]
    remove()


async def test_own_context_and_delayed_target_are_ignored(hass):
    entity = "climate.room"
    store = NimbusClimateSchedulerStore(hass)
    store.data = {"zones": {entity: make_zone()}}
    scheduler = NimbusClimateScheduler(hass, store, [])
    remove = hass.bus.async_listen(EVENT_STATE_CHANGED, scheduler._state_changed)
    hass.states.async_set(entity, "heat", {"temperature": 18})
    await hass.async_block_till_done()
    context = Context()
    scheduler._own_contexts.add(context.id)
    hass.states.async_set(entity, "heat", {"temperature": 19}, context=context)
    await hass.async_block_till_done()
    scheduler._pending_targets[entity] = (20, dt_util.utcnow().timestamp() + 120)
    hass.states.async_set(entity, "heat", {"temperature": 20})
    await hass.async_block_till_done()
    assert not scheduler._overrides
    remove()


async def test_override_expires_and_schedule_resumes(hass):
    entity = "climate.room"
    store = NimbusClimateSchedulerStore(hass)
    store.data = {"zones": {entity: make_zone()}}
    scheduler = NimbusClimateScheduler(hass, store, [])
    hass.states.async_set(entity, "heat", {"temperature": 22})
    now = dt_util.now()
    scheduler._overrides[entity] = {"temperature": 22, "until": now.isoformat(), "mode": "heat"}
    calls = []
    async def apply(plan):
        calls.append(plan)
    scheduler.async_apply_plan = apply
    result = await scheduler.async_tick(now)
    assert result["applied"] == [entity]
    assert entity not in scheduler._overrides
    await hass.async_block_till_done()
    assert entity not in store.data["temporary_overrides"]


async def test_unknown_recovery_and_non_target_updates_do_not_hold(hass):
    entity = "climate.room"
    store = NimbusClimateSchedulerStore(hass)
    store.data = {"zones": {entity: make_zone()}}
    scheduler = NimbusClimateScheduler(hass, store, [])
    remove = hass.bus.async_listen(EVENT_STATE_CHANGED, scheduler._state_changed)
    hass.states.async_set(entity, "unavailable", {})
    hass.states.async_set(entity, "heat", {"temperature": 22})
    await hass.async_block_till_done()
    hass.states.async_set(entity, "heat", {"temperature": 22, "current_temperature": 19})
    await hass.async_block_till_done()
    assert not scheduler._overrides
    remove()


async def test_listener_lifecycle_holds_then_applies_at_next_point(hass):
    from datetime import timedelta
    from custom_components.nimbus_climate_scheduler.scheduler import get_schedule_point_for_time

    entity = "climate.room"
    zone = make_zone()
    store = NimbusClimateSchedulerStore(hass)
    store.data = {"zones": {entity: zone}}
    now = dt_util.now()
    scheduled = get_schedule_point_for_time(zone["modes"]["heat"]["savedWeek"], now)["current"]["temp"]
    hass.states.async_set(entity, "heat", {"temperature": scheduled})
    scheduler = NimbusClimateScheduler(hass, store, [])
    calls = []
    async def apply(plan):
        calls.append(plan)
    scheduler.async_apply_plan = apply
    scheduler.start()
    await hass.async_block_till_done()
    hass.states.async_set(entity, "heat", {"temperature": scheduled + 3})
    await hass.async_block_till_done()
    assert entity in scheduler._overrides
    await scheduler.async_tick(now + timedelta(seconds=1))
    assert not calls
    until = dt_util.parse_datetime(scheduler._overrides[entity]["until"])
    await scheduler.async_tick(until)
    assert len(calls) == 1
    scheduler.stop()
    await hass.async_block_till_done()
