"""Tests for the Nimbus backend scheduler."""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from custom_components.nimbus_climate_scheduler.scheduler import (
    DAYS,
    ApplyPlan,
    NimbusClimateScheduler,
    get_schedule_point_for_time,
    time_to_schedule_minute,
)


class FakeStates:
    """Minimal Home Assistant state machine used by unit tests."""

    def __init__(self, states: dict[str, object] | None = None) -> None:
        self._states = states or {}

    def get(self, entity_id: str):
        return self._states.get(entity_id)


class FakeStore:
    """In-memory scheduler store used by unit tests."""

    def __init__(self, zones: dict[str, dict] | None = None) -> None:
        self.zones = zones or {}

    def get_zone(self, entity_id: str):
        return self.zones.get(entity_id)

    def get_climates(self) -> list[dict]:
        return []

    def zone_entity_ids(self) -> list[str]:
        return list(self.zones)

    def as_dict(self) -> dict:
        return {"zones": self.zones}


def make_hass(states: dict[str, object] | None = None):
    """Return the subset of HomeAssistant used by NimbusClimateScheduler."""
    return SimpleNamespace(
        states=FakeStates(states),
        services=SimpleNamespace(async_call=AsyncMock()),
        config=SimpleNamespace(units=SimpleNamespace(temperature_unit="°C")),
    )


def make_state(mode: str = "heat", temperature: float = 20):
    """Return a minimal climate state."""
    return SimpleNamespace(
        state=mode,
        attributes={
            "temperature": temperature,
            "current_temperature": temperature,
            "hvac_modes": ["off", "heat", "cool"],
            "min_temp": 5,
            "max_temp": 35,
            "target_temp_step": 0.5,
        },
    )


def make_week(default_temp: float = 20) -> dict[str, list[dict]]:
    """Return a complete seven-day saved schedule."""
    return {
        day: [
            {"minute": 0, "temp": default_temp},
            {"minute": time_to_schedule_minute("22:00"), "temp": default_temp - 2},
        ]
        for day in DAYS
    }


def make_zone(active_mode: str | None = "heat") -> dict:
    """Return persisted zone data."""
    week = make_week()
    return {
        "scheduleMode": "heat",
        "activeScheduleMode": active_mode,
        "modes": {
            "heat": {"savedWeek": week, "draftWeek": week},
            "cool": {"savedWeek": week, "draftWeek": week},
        },
    }


def test_schedule_day_changes_at_0500() -> None:
    """Early morning belongs to the previous schedule day."""
    week = make_week()
    week["Sun"][0]["temp"] = 17
    week["Sun"][1]["temp"] = 15
    week["Mon"][0]["temp"] = 21

    before_boundary = get_schedule_point_for_time(
        week, datetime(2026, 6, 22, 4, 59)
    )
    at_boundary = get_schedule_point_for_time(
        week, datetime(2026, 6, 22, 5, 0)
    )

    assert before_boundary["day"] == "Sun"
    assert before_boundary["current"]["temp"] == 15
    assert at_boundary["day"] == "Mon"
    assert at_boundary["current"]["temp"] == 21


def test_disabled_schedule_leaves_manual_control_alone() -> None:
    """A disabled schedule must never produce an off plan."""
    entity_id = "climate.living_room"
    scheduler = NimbusClimateScheduler(
        make_hass({entity_id: make_state()}),
        FakeStore({entity_id: make_zone(active_mode=None)}),
        [],
    )

    assert scheduler.build_plan(entity_id, datetime(2026, 6, 22, 12, 0)) is None


@pytest.mark.asyncio
async def test_one_failed_zone_does_not_block_the_rest() -> None:
    """A service failure is isolated to the affected climate entity."""
    scheduler = NimbusClimateScheduler(make_hass(), FakeStore(), [])
    entity_ids = ["climate.bad", "climate.good"]
    plans = {
        entity_id: ApplyPlan(
            entity_id=entity_id,
            action="set_temperature",
            mode="heat",
            target_temp=21,
            current_hvac_mode="heat",
            current_target_temp=20,
        )
        for entity_id in entity_ids
    }
    applied: list[str] = []

    scheduler.scheduled_entity_ids = lambda: entity_ids
    scheduler.build_plan = lambda entity_id, now: plans[entity_id]

    async def apply_plan(plan: ApplyPlan) -> None:
        if plan.entity_id == "climate.bad":
            raise RuntimeError("device unavailable")
        applied.append(plan.entity_id)

    scheduler.async_apply_plan = apply_plan

    result = await scheduler.async_tick(datetime(2026, 6, 22, 12, 0))

    assert result["failed"] == ["climate.bad"]
    assert result["applied"] == ["climate.good"]
    assert applied == ["climate.good"]


@pytest.mark.asyncio
async def test_periodic_tick_skips_but_explicit_tick_waits() -> None:
    """Periodic work cannot queue while save-and-apply waits for the lock."""
    scheduler = NimbusClimateScheduler(make_hass(), FakeStore(), [])
    await scheduler._lock.acquire()

    periodic_result = await scheduler._async_periodic_tick()
    explicit_tick = asyncio.create_task(scheduler.async_tick())
    await asyncio.sleep(0)

    assert periodic_result == {"applied": [], "failed": [], "running": True}
    assert not explicit_tick.done()

    scheduler._lock.release()
    explicit_result = await explicit_tick

    assert explicit_result == {"applied": [], "failed": [], "running": False}
