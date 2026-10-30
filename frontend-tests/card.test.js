import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ENTITY_ID = "climate.nursery";

function makeWeek() {
  return Object.fromEntries(
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => [
      day,
      [
        { minute: 0, temp: 20 },
        { minute: 17 * 60, temp: 18 },
      ],
    ]),
  );
}

function makeHass(callWS) {
  return {
    language: "en",
    config: { unit_system: { temperature: "°C" } },
    states: {
      [ENTITY_ID]: {
        state: "heat",
        attributes: {
          friendly_name: "Nursery",
          current_temperature: 19,
          temperature: 20,
        },
      },
    },
    callWS,
  };
}

function makeZone(week = makeWeek()) {
  return {
    activeScheduleMode: "heat",
    modes: {
      heat: { savedWeek: week, draftWeek: week },
    },
  };
}

beforeAll(async () => {
  await import(
    "../custom_components/nimbus_climate_scheduler/frontend/nimbus-climate-scheduler-card.js"
  );
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Nimbus Climate Scheduler card", () => {
  it("installs a prepaint surface before the card renders", () => {
    const style = document.getElementById("nimbus-climate-scheduler-card-prepaint");

    expect(style?.textContent).toContain("nimbus-climate-scheduler-card");
    expect(style?.textContent).toContain("linear-gradient");
  });

  it("escapes user-controlled zone names", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID, name: '<img id="xss" src=x>' });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);

    expect(card.shadowRoot.querySelector("#xss")).toBeNull();
    expect(card.shadowRoot.querySelector(".name").textContent).toBe(
      '<img id="xss" src=x>',
    );
  });

  it("uses tomorrow's 05:00 setpoint after the final setpoint", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 22, 23, 0)); // Monday
    const week = makeWeek();
    week.Tue[0].temp = 21;
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone(week) };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);

    expect(card.shadowRoot.textContent).toContain("21° at 05:00");
  });

  it("refreshes schedules every five minutes without a hass state update", async () => {
    vi.useFakeTimers();
    const callWS = vi.fn().mockResolvedValue({ zones: { [ENTITY_ID]: makeZone() } });
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card.hass = makeHass(callWS);
    document.body.append(card);
    await Promise.resolve();

    expect(callWS).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(callWS).toHaveBeenCalledTimes(2);

    card.remove();
  });

  it("shows a sequential-dot loading state and retries the integration", async () => {
    vi.useFakeTimers();
    const callWS = vi.fn()
      .mockRejectedValueOnce(new Error("command not registered yet"))
      .mockResolvedValue({ zones: { [ENTITY_ID]: makeZone() } });
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card.hass = makeHass(callWS);
    document.body.append(card);
    await Promise.resolve();
    await Promise.resolve();

    expect(card.shadowRoot.textContent).toContain(
      "Nimbus Climate Scheduler is loading",
    );
    expect(card.shadowRoot.querySelectorAll(".loading-dot")).toHaveLength(3);
    expect(card.shadowRoot.textContent).not.toContain("Schedule off");
    expect(callWS).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(callWS).toHaveBeenCalledTimes(2);
    expect(card.shadowRoot.querySelector(".loading-state")).toBeNull();

    card.remove();
  });

  it("uses the scheduler tune icon in the narrow axis open control", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);

    expect(
      card.shadowRoot.querySelector(".axis .open-icon ha-icon").getAttribute("icon"),
    ).toBe("mdi:tune-variant");
  });

  it("sends haptic feedback when the narrow axis open control is tapped", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);
    document.body.append(card);

    const onHaptic = vi.fn();
    card.addEventListener("haptic", onHaptic);
    card.shadowRoot.querySelector(".open-icon").click();

    expect(onHaptic).toHaveBeenCalledTimes(1);
    expect(onHaptic.mock.calls[0][0].detail).toBe("selection");

    card.remove();
  });

  it("does not rebuild the card for unrelated hass updates", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);
    const renderedCard = card.shadowRoot.querySelector("ha-card");

    const nextHass = makeHass(undefined);
    nextHass.states["sensor.unrelated"] = {
      state: "changed",
      attributes: { friendly_name: "Unrelated" },
    };
    card.hass = nextHass;

    expect(card.shadowRoot.querySelector("ha-card")).toBe(renderedCard);
  });

  it("can restore scroll position after a zone tab switch render", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    const scroller = document.createElement("div");
    document.body.append(scroller);
    scroller.append(card);
    scroller.scrollTop = 42;
    scroller.scrollLeft = 7;

    const snapshot = card._snapshotScroll({
      composedPath: () => [card, scroller, document.body, document.documentElement],
    });
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    card._restoreScroll(snapshot);

    expect(scroller.scrollTop).toBe(42);
    expect(scroller.scrollLeft).toBe(7);
  });
  it("updates timeline and room temperature in place, and renders at a setpoint boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 22, 12, 0));
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);
    const rendered = card.shadowRoot.querySelector("ha-card");
    const bubble = card.shadowRoot.querySelector("[data-ncs-bubble]");
    const originalTime = bubble.textContent;
    vi.setSystemTime(new Date(2026, 5, 22, 12, 10));
    card._updateTimeline();
    expect(card.shadowRoot.querySelector("ha-card")).toBe(rendered);
    expect(bubble.textContent).not.toBe(originalTime);
    const next = makeHass(undefined);
    next.states[ENTITY_ID].attributes.current_temperature = 19.5;
    card.hass = next;
    expect(card.shadowRoot.querySelector("ha-card")).toBe(rendered);
    expect(card.shadowRoot.querySelector("[data-ncs-room-temperature]").textContent).toContain("19.5");
    vi.setSystemTime(new Date(2026, 5, 22, 23, 0));
    card._updateTimeline();
    expect(card.shadowRoot.querySelector("ha-card")).not.toBe(rendered);
  });

  it("updates pause reason when the backend switch changes", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);
    const paused = makeHass(undefined);
    paused.states["switch.nursery_schedule"] = { state: "off", attributes: {
      nimbus_schedule_zone: "nursery", climate_entities: [ENTITY_ID], pause_reason: "automation",
    } };
    card.hass = paused;
    expect(card.shadowRoot.textContent).toContain("Paused due to control by automation");
    const manual = makeHass(undefined);
    manual.states["switch.nursery_schedule"] = { state: "off", attributes: {
      nimbus_schedule_zone: "nursery", climate_entities: [ENTITY_ID], pause_reason: "manual",
    } };
    card.hass = manual;
    expect(card.shadowRoot.textContent).toContain("Paused");
    expect(card.shadowRoot.textContent).not.toContain("Paused due to control by automation");
    card.hass = makeHass(undefined);
    expect(card.shadowRoot.textContent).not.toContain("Paused");
  });

  it.each([
    [null, "on", null, "No active schedule", false],
    ["heat", "on", null, null, true],
    ["heat", "off", "manual", "Paused", false],
    ["heat", "off", "automation", "Paused due to control by automation", false],
    [null, "off", "manual", "No active schedule · Paused", false],
    [null, "off", "automation", "No active schedule · Paused due to control by automation", false],
  ])("displays schedule and switch state separately (%s, %s, %s)", (mode, state, reason, expected, active) => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: { ...makeZone(), activeScheduleMode: mode } };
    card._zonesFetchedAt = Date.now();
    const hass = makeHass(undefined);
    hass.states["switch.nursery_schedule"] = { state, attributes: {
      nimbus_schedule_zone: "nursery", climate_entities: [ENTITY_ID], pause_reason: reason,
    } };
    card.hass = hass;
    const status = card.shadowRoot.querySelector("[data-ncs-status]").textContent;
    if (expected) expect(status).toBe(expected);
    expect(card.shadowRoot.querySelector(".head").dataset.state === "active").toBe(active);
  });

});
