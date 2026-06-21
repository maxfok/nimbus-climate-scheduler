"""Tests for scheduler WebSocket payload validation."""

import pytest
import voluptuous as vol

from custom_components.nimbus_climate_scheduler.scheduler import DAYS
from custom_components.nimbus_climate_scheduler.websocket import _ZONE_DATA_SCHEMA


def make_payload(minute=0, temp=20) -> dict:
    """Return a complete zone payload."""
    week = {day: [{"minute": minute, "temp": temp}] for day in DAYS}
    return {
        "scheduleMode": "heat",
        "activeScheduleMode": "heat",
        "modes": {
            "heat": {"savedWeek": week, "draftWeek": week},
        },
    }


def test_valid_zone_payload() -> None:
    """A panel-generated payload passes validation."""
    validated = _ZONE_DATA_SCHEMA(make_payload())
    assert validated["activeScheduleMode"] == "heat"


@pytest.mark.parametrize(
    ("minute", "temp"),
    [(-1, 20), (1440, 20), (0, "warm")],
)
def test_invalid_setpoint_is_rejected(minute, temp) -> None:
    """Invalid times and temperatures never reach persistent storage."""
    with pytest.raises(vol.Invalid):
        _ZONE_DATA_SCHEMA(make_payload(minute=minute, temp=temp))
