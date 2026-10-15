"""Unit-independent color settings shared by the panel, card and HA entities."""
from __future__ import annotations

from copy import deepcopy
import math

import voluptuous as vol

DEFAULT_COLOR_THRESHOLDS = {
    "heat": {"cold": 18.0, "warm": 20.5, "hot": 22.0},
    "cool": {"cold": 24.0, "warm": 25.5, "hot": 27.0},
}


def _threshold(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not -100 <= value <= 100:
        raise vol.Invalid("Color thresholds must be finite numbers between -100 and 100 °C")
    return float(value)


SETTINGS_SCHEMA = vol.Schema({
    vol.Required("color_thresholds"): {
        vol.Optional(mode): {vol.Optional(band): _threshold for band in ("cold", "warm", "hot")}
        for mode in ("heat", "cool")
    },
})


def merge_settings(current: dict, update: dict) -> dict:
    """Validate a partial update against the complete, canonical Celsius values."""
    update = SETTINGS_SCHEMA(update)
    result = deepcopy(current)
    thresholds = result.setdefault("color_thresholds", deepcopy(DEFAULT_COLOR_THRESHOLDS))
    for mode, values in update["color_thresholds"].items():
        thresholds[mode].update(values)
    for values in thresholds.values():
        if not values["cold"] < values["warm"] < values["hot"]:
            raise vol.Invalid("Color thresholds must be ordered: cold < warm < hot")
    return result
