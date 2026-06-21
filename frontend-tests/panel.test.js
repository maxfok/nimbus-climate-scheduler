import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function climateState(mode, minTemp = 5, maxTemp = 35) {
  return {
    state: mode,
    attributes: {
      friendly_name: mode,
      current_temperature: 20,
      temperature: 20,
      hvac_modes: ["off", mode],
      min_temp: minTemp,
      max_temp: maxTemp,
      target_temp_step: 0.5,
    },
  };
}

beforeAll(async () => {
  await import(
    "../custom_components/nimbus_climate_scheduler/frontend/nimbus-climate-scheduler-panel.js"
  );
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
});

describe("Nimbus Climate Scheduler panel", () => {
  it("restores connection listeners after a disconnect", () => {
    const media = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    window.matchMedia = vi.fn(() => media);
    const panel = document.createElement("nimbus-climate-scheduler-panel");

    document.body.append(panel);
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    panel.remove();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    document.body.append(panel);
    expect(media.addEventListener).toHaveBeenCalledTimes(2);
  });

  it("disables a grouped zone with no common HVAC mode", () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel._hass = {
      states: {
        "climate.heat_only": climateState("heat"),
        "climate.cool_only": climateState("cool"),
      },
    };

    const zone = panel.makeZoneFromClimate(
      { entity: "climate.heat_only" },
      {
        name: "Mixed",
        entityIds: ["climate.heat_only", "climate.cool_only"],
      },
    );

    expect(zone.capabilitiesCompatible).toBe(false);
    expect(zone.activeScheduleMode).toBeNull();
    expect(panel.renderZoneSwitch(zone).disabled).toBe(true);
    panel.zones = [zone];
    expect(panel.buildApplyPlans()).toEqual([]);
  });

  it("disables a grouped zone without a common temperature range", () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel._hass = {
      states: {
        "climate.low_range": climateState("heat", 5, 15),
        "climate.high_range": climateState("heat", 20, 30),
      },
    };

    const zone = panel.makeZoneFromClimate(
      { entity: "climate.low_range" },
      {
        name: "No overlap",
        entityIds: ["climate.low_range", "climate.high_range"],
      },
    );

    expect(zone.capabilitiesCompatible).toBe(false);
    expect(zone.capabilityIssues.join(" ")).toContain("temperature range");
    expect(panel.renderZoneSwitch(zone).disabled).toBe(true);
  });

  it("does not apply the previous schedule when saving fails", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel._hass = { callWS: vi.fn() };
    panel.saveZoneToBackend = vi.fn().mockRejectedValue(new Error("save failed"));
    panel.renderIfReady = vi.fn();
    panel.render = vi.fn();

    await panel.saveAndApply({ name: "Living room" });

    expect(panel._hass.callWS).not.toHaveBeenCalled();
    expect(panel.applyResultData.failed).toHaveLength(1);
  });

  it("leaves manual control alone in the frontend fallback", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel._hass = { callService: vi.fn() };
    panel.backendSyncComplete = false;
    panel.zones = [{
      id: "climate.manual",
      entityId: "climate.manual",
      entityIds: ["climate.manual"],
      activeScheduleMode: null,
      hvacMode: "heat",
      targetTemp: 20,
      capabilitiesCompatible: true,
    }];

    await panel.runSchedulerTick();

    expect(panel._hass.callService).not.toHaveBeenCalled();
  });
});
