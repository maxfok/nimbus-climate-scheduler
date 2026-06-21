from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import DEFAULT_SCAN_INTERVAL
from .store import NimbusClimateSchedulerStore

_LOGGER = logging.getLogger(__name__)

DAY_START_MINUTES = 5 * 60
DAY_LENGTH_MINUTES = 24 * 60
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
ACTIVE_MODES = {"heat", "cool"}


@dataclass(slots=True)
class ClimateConfig:
    entity: str
    name: str | None = None


@dataclass(slots=True)
class ApplyPlan:
    entity_id: str
    action: str
    mode: str | None
    target_temp: float | int | None
    current_hvac_mode: str
    current_target_temp: float | int | None


class NimbusClimateScheduler:
    """Apply saved Nimbus climate schedules from Home Assistant backend."""

    def __init__(
        self,
        hass: HomeAssistant,
        store: NimbusClimateSchedulerStore,
        climates: list[ClimateConfig],
        scan_interval: int = DEFAULT_SCAN_INTERVAL,
    ) -> None:
        self.hass = hass
        self.store = store
        self.climates = climates
        self.scan_interval = max(10, int(scan_interval or DEFAULT_SCAN_INTERVAL))
        self.last_run: str | None = None
        self._remove_interval = None
        self._lock = asyncio.Lock()

    def start(self) -> None:
        """Start the backend scheduler loop."""
        self.stop()
        self._remove_interval = async_track_time_interval(
            self.hass,
            self._async_periodic_tick,
            timedelta(seconds=self.scan_interval),
        )
        self.hass.async_create_task(self.async_tick())

    def stop(self) -> None:
        """Stop the backend scheduler loop."""
        if self._remove_interval:
            self._remove_interval()
            self._remove_interval = None

    async def _async_periodic_tick(self, now=None) -> dict[str, Any]:
        """Run a scheduled tick, skipping it when another tick is active."""
        if self._lock.locked():
            return {"applied": [], "failed": [], "running": True}
        return await self.async_tick(now)

    async def async_tick(self, now=None) -> dict[str, Any]:
        """Apply all configured zones once, waiting for any active tick.

        Explicit save-and-apply calls use this path so they run immediately after
        an in-progress periodic tick. Periodic callbacks use
        _async_periodic_tick() and are skipped instead of accumulating.
        """
        applied: list[str] = []
        failed: list[str] = []
        async with self._lock:
            now = now or dt_util.now()
            plans = []
            for entity_id in self.scheduled_entity_ids():
                try:
                    plan = self.build_plan(entity_id, now)
                except Exception:  # noqa: BLE001 — bad data for one zone must not crash the tick
                    failed.append(entity_id)
                    _LOGGER.warning(
                        "Nimbus scheduler skipped %s (could not build plan)", entity_id, exc_info=True
                    )
                    continue
                if plan is not None:
                    plans.append(plan)
            for plan in plans:
                if not self.plan_needs_apply(plan):
                    continue
                try:
                    await self.async_apply_plan(plan)
                    applied.append(plan.entity_id)
                except Exception:  # noqa: BLE001 — one bad zone must not block the others
                    failed.append(plan.entity_id)
                    _LOGGER.warning(
                        "Nimbus scheduler could not apply %s", plan.entity_id, exc_info=True
                    )
            self.last_run = dt_util.utcnow().isoformat()
        return {"applied": applied, "failed": failed, "running": False}

    def scheduled_entity_ids(self) -> list[str]:
        """Return configured and storage-backed climate entity ids."""
        entity_ids = [climate.entity for climate in self.climates]
        for entry in self.store.get_climates():
            entity_id = entry.get("entity")
            if entity_id and entity_id not in entity_ids:
                entity_ids.append(entity_id)
        for entity_id in self.store.zone_entity_ids():
            if entity_id not in entity_ids:
                entity_ids.append(entity_id)
        return entity_ids

    def build_plan(self, entity_id: str, now) -> ApplyPlan | None:
        """Build the desired HA service plan for a climate entity."""
        state = self.hass.states.get(entity_id)
        if state is None:
            return None

        zone = self.store.get_zone(entity_id) or self.default_zone_data(state)
        active_mode = zone.get("activeScheduleMode")
        current_hvac_mode = str(state.state)
        current_target_temp = state.attributes.get("temperature")

        if active_mode not in ACTIVE_MODES:
            # Schedule disabled for this zone: leave manual control alone.
            # (The "off" plan machinery stays for an explicit turn-off action later.)
            return None

        week = (
            zone.get("modes", {})
            .get(active_mode, {})
            .get("savedWeek")
        )
        schedule = get_schedule_point_for_time(week, now)
        if schedule is None:
            return None

        return ApplyPlan(
            entity_id=entity_id,
            action="set_temperature",
            mode=active_mode,
            target_temp=schedule["current"]["temp"],
            current_hvac_mode=current_hvac_mode,
            current_target_temp=current_target_temp,
        )

    def plan_needs_apply(self, plan: ApplyPlan) -> bool:
        """Return true only when Home Assistant is not already in desired state."""
        if plan.action == "off":
            return is_climate_on(plan.current_hvac_mode)

        if plan.current_hvac_mode != plan.mode:
            return True

        try:
            return float(plan.current_target_temp) != float(plan.target_temp)
        except (TypeError, ValueError):
            return True

    async def async_apply_plan(self, plan: ApplyPlan) -> None:
        """Send Home Assistant climate service calls for a plan."""
        if plan.action == "off":
            await self.hass.services.async_call(
                "climate",
                "set_hvac_mode",
                {"entity_id": plan.entity_id, "hvac_mode": "off"},
                blocking=True,
            )
            _LOGGER.debug("Turned off %s from Nimbus scheduler", plan.entity_id)
            return

        if plan.current_hvac_mode != plan.mode:
            await self.hass.services.async_call(
                "climate",
                "set_hvac_mode",
                {"entity_id": plan.entity_id, "hvac_mode": plan.mode},
                blocking=True,
            )
            # Give the device a moment to switch modes so the setpoint that
            # follows lands on the new mode — Z-Wave units otherwise drop it,
            # which is why a second "apply" used to be needed.
            await asyncio.sleep(1)

        await self.hass.services.async_call(
            "climate",
            "set_temperature",
            {"entity_id": plan.entity_id, "temperature": plan.target_temp},
            blocking=True,
        )
        _LOGGER.debug(
            "Applied %s target %s to %s from Nimbus scheduler",
            plan.mode,
            plan.target_temp,
            plan.entity_id,
        )

    async def async_set_zone(self, entity_id: str, zone_data: dict[str, Any]) -> None:
        """Persist a zone schedule from the frontend."""
        await self.store.async_set_zone(entity_id, zone_data)

    def as_dict(self) -> dict[str, Any]:
        """Return public scheduler state for the frontend."""
        return {
            **self.store.as_dict(),
            "configured_climates": [
                {"entity": climate.entity, "name": climate.name}
                for climate in self.climates
            ],
            "scan_interval": self.scan_interval,
            "last_run": self.last_run,
        }

    def temperature_unit(self) -> str:
        return getattr(self.hass.config.units, "temperature_unit", "°C")

    def default_zone_data(self, state) -> dict[str, Any]:
        """Create a conservative fallback schedule for first boot."""
        fahrenheit = self.temperature_unit() == "°F"
        fallback = 68 if fahrenheit else 20
        setback = 4 if fahrenheit else 2
        floor = 41 if fahrenheit else 5
        base_temp = coerce_number(state.attributes.get("temperature"), fallback)
        if base_temp <= 0:
            base_temp = fallback
        heat_day = normalize_setpoints(
            [
                {"minute": 0, "temp": base_temp},
                {"minute": time_to_schedule_minute("07:00"), "temp": base_temp},
                {"minute": time_to_schedule_minute("09:00"), "temp": max(floor, base_temp - setback)},
                {"minute": time_to_schedule_minute("14:15"), "temp": base_temp},
                {"minute": time_to_schedule_minute("18:30"), "temp": max(floor, base_temp - setback)},
            ]
        )
        return {
            "scheduleMode": "heat",
            "activeScheduleMode": None,
            "modes": {
                "heat": make_mode_schedule(heat_day),
                "cool": make_mode_schedule(make_cool_setpoints(heat_day, self.temperature_unit())),
            },
        }


def is_climate_on(hvac_mode: str) -> bool:
    return hvac_mode not in {"off", "unavailable", "unknown"}


def coerce_number(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def make_mode_schedule(base_day: list[dict[str, float | int]]) -> dict[str, Any]:
    week = {day: clone_setpoints(base_day) for day in DAYS}
    return {
        "savedWeek": clone_week(week),
        "draftWeek": clone_week(week),
    }


def clone_week(week: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    return {day: clone_setpoints(week[day]) for day in DAYS}


def clone_setpoints(setpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(point) for point in setpoints]


def make_cool_setpoints(
    heat_setpoints: list[dict[str, Any]], unit: str = "°C"
) -> list[dict[str, Any]]:
    return [
        {"minute": point["minute"], "temp": heat_temp_to_cool_temp(point["temp"], unit)}
        for point in heat_setpoints
    ]


def heat_temp_to_cool_temp(temp: float | int, unit: str = "°C") -> float:
    # The comfort mapping is defined in Celsius; convert in and out for °F.
    celsius = (temp - 32) * 5 / 9 if unit == "°F" else temp
    if celsius <= 18:
        cool_celsius = 27
    elif celsius >= 22:
        cool_celsius = 24
    elif celsius >= 20.5:
        cool_celsius = 25
    else:
        cool_celsius = 26
    cool = cool_celsius * 9 / 5 + 32 if unit == "°F" else cool_celsius
    return round(cool * 2) / 2


def normalize_setpoints(setpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = sorted(setpoints, key=lambda point: point["minute"])
    normalized[0]["minute"] = 0
    return normalized


def time_to_schedule_minute(value: str) -> int:
    hour, minute = [int(part) for part in value.split(":", 1)]
    return clock_minute_to_schedule_minute((hour * 60) + minute)


def clock_minute_to_schedule_minute(clock_minute: int) -> int:
    return (clock_minute - DAY_START_MINUTES + DAY_LENGTH_MINUTES) % DAY_LENGTH_MINUTES


def schedule_minute_to_clock_minute(schedule_minute: int) -> int:
    return (schedule_minute + DAY_START_MINUTES) % DAY_LENGTH_MINUTES


def get_schedule_point_for_time(week, now) -> dict[str, Any] | None:
    clock_minute = (now.hour * 60) + now.minute
    day_index = now.weekday()
    # The schedule day runs 05:00 -> 05:00, so early-morning hours still
    # belong to the previous day's row.
    if clock_minute < DAY_START_MINUTES:
        day_index = (day_index - 1) % 7
    day = DAYS[day_index]
    setpoints = week.get(day) if isinstance(week, dict) else None
    if not isinstance(setpoints, list) or not setpoints:
        return None

    schedule_minute = clock_minute_to_schedule_minute(clock_minute)
    active_index = 0
    for index, point in enumerate(setpoints):
        if point.get("minute", 0) <= schedule_minute:
            active_index = index

    current = setpoints[active_index]
    next_point = setpoints[(active_index + 1) % len(setpoints)]
    return {
        "day": day,
        "current": current,
        "next": next_point,
        "nextTime": minutes_to_time(schedule_minute_to_clock_minute(next_point["minute"])),
    }


def minutes_to_time(total_minutes: int) -> str:
    hour = (total_minutes // 60) % 24
    minute = total_minutes % 60
    return f"{hour:02d}:{minute:02d}"
