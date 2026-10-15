<img src="docs/icon.svg" width="64" align="right" alt="">

# Nimbus Climate Scheduler

A weekly heating & cooling scheduler for Home Assistant — a full sidebar panel
where you draw each zone's plan on a visual timeline, and a small backend loop
keeps your thermostats on schedule. No automations to write.

![Nimbus Climate Scheduler](docs/nimbus-scheduler.gif)

## Why I made this

For many years a smart-home enthusiast, I've been through many platforms before
dropping my anchor at Home Assistant. On some of the other platforms I really
admired the way they handled the climate / HVAC controller — they let you build
your own weekly schedule plan easily, without putting much effort into it. So I
tried to make the Nimbus Climate Scheduler sidebar integration, to bring to Home
Assistant all those characteristics I love:

- You can handle **heat and cool modes separately**.
- **Matching days share one row**. Edit weekdays, weekends, every day, or a custom
  selection together; switch off grouping to work on individual days.
- **Add or remove intervals** as needed, with a separate temperature for each.
  Choose **New interval starts** to insert anywhere in the day. Drag an existing
  boundary, use the arrow keys (Shift for one-minute steps), or enter its start
  time directly. The first interval always starts at 05:00.

Building this around a full-time job in another profession and two toddlers
isn't easy — I've spent a lot of hours debugging. I'd genuinely love your
feedback, and any corrections or additions that make it better are very welcome.

— **@maxfok**

## Dashboard card

Sometimes you just want to know what the heating is supposed to be doing right
now.

The built-in read-only dashboard card shows the current and next setpoints on the
familiar colored schedule timeline, complete with a marker that smoothly follows
the current time throughout the day.

Use it with a single zone for a compact overview, or add multiple zones to get
convenient tabs for quick switching between rooms.

The card loads automatically once the integration is set up — there's no
Lovelace resource to add. Drop it on a dashboard with a single zone:

```yaml
type: custom:nimbus-climate-scheduler-card
entity: climate.nursery_thermostat
```

…or list several zones to get tabs:

```yaml
type: custom:nimbus-climate-scheduler-card
entities:
  - climate.bedroom_thermostat
  - climate.nursery_thermostat
  - climate.kitchen_thermostat
```

Adding it from the dashboard UI works too — it shows up as *Nimbus Climate
Scheduler Card* with a built-in editor. Tap **open scheduler** on the card to
jump to the panel.

> **Companion card** — for full thermostat control (modes, target, live graph)
> see [Nimbus Climate card](https://github.com/maxfok/nimbus-climate-card).

## Under the hood

- **Backend scheduler** — a Home Assistant-side loop (default every 30 s) applies
  the saved schedule via `climate.set_hvac_mode` / `climate.set_temperature`. It
  works with the panel closed, and a disabled zone is left under manual control —
  the scheduler never overrides it.
- **Zones, not just entities** — group several thermostats into one zone with a
  shared schedule; the setup wizard suggests the room (HA Area) each thermostat
  lives in.
- **°C and °F aware** — limits, step and resolution come from each device
  (`min_temp`, `max_temp`, `target_temp_step`); color bands and default schedules
  adapt to your unit system.
- **Mobile friendly** — narrow layout and a sidebar button for phones.
- Schedules persist in HA storage, shared across all your browsers and devices.

## Installation

### HACS (custom repository)

1. HACS → Integrations → ⋮ → *Custom repositories*.
2. Add `https://github.com/maxfok/nimbus-climate-scheduler` as type
   **Integration** and install.
3. Restart Home Assistant.

### Manual

Copy `custom_components/nimbus_climate_scheduler/` into your Home Assistant
`config/custom_components/` folder and restart.

## Setup

Settings → Devices & Services → **Add Integration** → *Nimbus Climate
Scheduler*. Open the **Climate Schedule** panel from the sidebar; on first run a
wizard helps you pick your thermostats and place each one in a zone.

That's it — no YAML required.

### Multiple thermostats in one zone

Use **Thermostats (1)** on a zone to add another radiator or thermostat. Select
all devices for the room, then **Save thermostats**. For example, add both living
room radiator thermostats to the Living room zone: they receive the same saved
temperature plan and are paused/resumed together by its existing Schedule switch.

New members inherit the zone's saved schedules, drafts and active/paused state.
You can add a second radiator later without recreating the zone or changing its
automation entity IDs. Thermostats assigned to another zone are shown with that
zone's name. Removing a member leaves that thermostat under manual control;
keep at least one member selected. Available Heat/Cool modes and temperature
ranges must support the existing plan.

The setup wizard also preserves existing plans when renaming zones or adding
thermostats. Existing zones need distinct names so their separate schedules are
not accidentally merged. Concurrent changes to the zone list are rejected;
reopen setup to start from the current selection.

## How it works

- The panel saves each zone's schedule to Home Assistant storage over the
  websocket API. Drafts you're still editing are never applied — only what you
  **save**. New drafts are cached in the editing browser until saved. A failed
  save leaves the draft editable; a conflicting edit from another client must
  be reloaded rather than silently overwritten.
- The backend loop resolves the active setpoint for the current time (schedule
  days run 05:00 → 05:00) and only calls a service when the thermostat differs
  from the target, so it won't spam your devices.
- The toggle on each zone enables or disables its schedule. Disabled means
  hands-off: your manual thermostat control is never touched.
- New schedules start with one all-day interval. Existing schedules, including
  separate weekday plans and unsaved drafts, are preserved. Grouping is only an
  editing view; saving selected days leaves the other days unchanged.

## Temperature colors

Open the panel's **Settings** tab to change the Cold, Warm and Hot thresholds
for heating and cooling. The intermediate Comfort band fills the gap between
Cold and Warm. A legend shows the exact ranges next to each schedule.

These global settings apply to every zone and the dashboard card; they only
change colors, never thermostat targets. Values are displayed in your HA unit
system and stored in Celsius so changing units does not change their meaning.
Existing installations keep the original colors until you save new thresholds.

The six thresholds are also available as **Number** configuration entities.
Use `number.set_value` in an automation (in the entity's displayed unit). Each
update must keep `Cold < Warm < Hot`; invalid updates leave the settings intact.

## Automations

Each zone has a **Schedule** switch and a **Schedule mode** select, under
Settings → Devices & Services → Nimbus Climate Scheduler. A grouped zone has
one pair of controls for all its thermostats. Entity IDs are assigned by Home
Assistant; use the entity picker to find yours.

- `switch.turn_off` pauses scheduling. It does **not** turn thermostats off or
  change their targets. Once the action returns, any in-flight scheduler work
  has finished, so a following automation action can safely take control.
- `switch.turn_on` resumes the last selected mode and applies the **saved** plan.
- `select.select_option` with `heat` or `cool` changes the schedule mode. While
  paused, it selects the mode to use on resume and leaves thermostats alone.
- Editing the Heat/Cool tabs only selects the plan being edited. The separate
  **Run schedule** selector and switch control what actually runs.

For example, before a grid peak event (replace the example entity IDs):

```yaml
actions:
  - action: switch.turn_off
    target:
      entity_id: switch.living_room_schedule
  - action: climate.set_temperature
    target:
      entity_id: climate.living_room
    data:
      temperature: 18
```

When the event ends, call `switch.turn_on` on the same schedule switch. The
panel and dashboard card receive updates when automations change these controls.
Controls and schedules survive restarts; renaming a zone or changing its member
order preserves the zone's entity identity.

## Notes

- Requires Home Assistant 2024.6 or newer.
- Tested at home on Z-Wave thermostats (heat + cool), and on a separate heat-only
  setup. It's a hobby project I run in my own house — use it at your own risk,
  and please open an issue if something misbehaves.

## Development and tests

Backend tests use the Home Assistant custom-component pytest harness:

```bash
uv venv --python 3.14
uv pip install --python .venv/bin/python -r requirements_test.txt
.venv/bin/pytest --cov
```

Frontend card and panel tests use Vitest with jsdom:

```bash
npm ci
npm test
```

Both suites also run automatically for every push and pull request.
