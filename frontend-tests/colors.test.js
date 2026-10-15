import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(async () => {
  await import("../custom_components/nimbus_climate_scheduler/frontend/nimbus-climate-scheduler-panel.js");
  await import("../custom_components/nimbus_climate_scheduler/frontend/nimbus-climate-scheduler-card.js");
});

describe("Global temperature colors", () => {
  it.each(["°C", "°F"])("uses the same saved bands in the panel and card (%s)", async (unit) => {
    const thresholds = {
      heat: { cold: 12, warm: 14, hot: 16 },
      cool: { cold: 21, warm: 23.5, hot: 26 },
    };
    const hass = {
      states: {}, config: { unit_system: { temperature: unit } },
      callWS: vi.fn().mockResolvedValue({ zones: {}, climates: [], settings: { color_thresholds: thresholds } }),
    };
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    const card = document.createElement("nimbus-climate-scheduler-card");
    panel._hass = card._hass = hass;
    panel.temperatureUnit = unit;
    await panel.syncBackendSchedules();
    await card._maybeFetchZones();

    for (const [mode, { cold, warm, hot }] of Object.entries(thresholds)) {
      for (const [celsius, expected] of [[cold, "#52dce9"], [cold + 0.1, "#6df338"], [warm, "#9afb3b"], [hot, "#f3d24e"]]) {
        const value = unit === "°F" ? celsius * 9 / 5 + 32 : celsius;
        expect(panel.colorForTemp(value, mode)).toBe(expected);
        expect(card._colorForTemp(value, mode)).toBe(expected);
      }
    }
  });

  it("rejects reversed bands without sending a save or losing the form", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.renderSettings = vi.fn();
    panel._hass = { callWS: vi.fn() };
    panel.settingsDraft = structuredClone(panel.colorThresholds);
    panel.settingsDraft.heat.cold = 30;
    await panel.saveSettings();
    expect(panel._hass.callWS).not.toHaveBeenCalled();
    expect(panel.settingsDraft.heat.cold).toBe(30);
    expect(panel.colorThresholds.heat.cold).toBe(18);
    expect(panel.settingsMessage).toContain("ascending order");
  });
});
