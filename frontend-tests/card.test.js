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

  it("uses the scheduler tune icon in the narrow open control", () => {
    const card = document.createElement("nimbus-climate-scheduler-card");
    card.setConfig({ entity: ENTITY_ID });
    card._zones = { [ENTITY_ID]: makeZone() };
    card._zonesFetchedAt = Date.now();
    card.hass = makeHass(undefined);

    expect(
      card.shadowRoot.querySelector(".open-icon ha-icon").getAttribute("icon"),
    ).toBe("mdi:tune-variant");
  });
});
