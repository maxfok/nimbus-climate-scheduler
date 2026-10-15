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
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("Nimbus Climate Scheduler panel", () => {
  function editingPanel() {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.render = vi.fn();
    panel.persistZone = vi.fn();
    panel._hass = { states: { "climate.room": climateState("heat") } };
    const zone = panel.makeZoneFromClimate({ entity: "climate.room" });
    panel.zones = [zone];
    return { panel, zone, schedule: zone.modes.heat };
  }

  function membershipPanel() {
    const result = editingPanel();
    const { panel, zone } = result;
    zone.groupId = "living-room";
    zone.name = "Living room";
    panel.backendSyncComplete = true;
    panel.getOrCreateStoreEntry(zone.id).revision = 4;
    panel.serverClimates = [
      { entity: "climate.room", name: "Living room", zone_id: "living-room" },
      { entity: "climate.bedroom", name: "Bedroom", zone_id: "bedroom" },
    ];
    panel._hass.states["climate.room"].attributes.friendly_name = "Living room radiator 1";
    panel._hass.states["climate.additional"] = climateState("heat");
    panel._hass.states["climate.additional"].attributes.friendly_name = "Living room radiator 2";
    panel._hass.states["climate.bedroom"] = climateState("heat");
    panel.openZoneMembers(zone);
    return result;
  }

  it("offers explicit member selection and prevents empty or duplicate zone assignments", () => {
    const { panel, zone } = membershipPanel();
    const editor = panel.renderZoneMembers(zone);
    document.body.append(editor);
    const current = editor.querySelector('input[value="climate.room"]');
    const additional = editor.querySelector('input[value="climate.additional"]');
    const elsewhere = editor.querySelector('input[value="climate.bedroom"]');
    const save = editor.querySelector(".setup-confirm");
    expect(current.checked).toBe(true);
    expect(elsewhere.disabled).toBe(true);
    expect(editor.textContent).toContain("Assigned to Bedroom");
    expect(save.disabled).toBe(true);
    current.click();
    expect(save.disabled).toBe(true);
    expect(editor.textContent).toContain("Select at least one thermostat.");
    additional.click();
    expect(save.disabled).toBe(false);
    expect(panel.membersDraft.selected).toEqual(["climate.additional"]);
    expect(zone.entityIds).toEqual(["climate.room"]);
  });

  it("carries drafts and the existing plan when replacing a zone's original thermostat", async () => {
    const { panel, zone, schedule } = membershipPanel();
    const savedModes = structuredClone(zone.modes);
    panel.membersDraft.selected = ["climate.additional"];
    schedule.draftWeek.Mon[0].temp = 22;
    schedule.dirty = true;
    const climates = [
      { entity: "climate.additional", name: "Living room", zone_id: "living-room" },
      panel.serverClimates[1],
    ];
    panel._hass.callWS = vi.fn().mockImplementation(async (command) => {
      if (command.type.endsWith("set_zone_members")) return {
        climates, group: { id: "living-room", name: "Living room", entity_ids: ["climate.additional"] }, revision: 5,
      };
      return { climates, zones: {
        "climate.additional": { modes: savedModes, scheduleMode: "heat", activeScheduleMode: null, revision: 5 },
        "climate.bedroom": { modes: savedModes, scheduleMode: "heat", activeScheduleMode: null, revision: 0 },
      } };
    });
    expect(await panel.saveZoneMembers()).toBe(true);
    const living = panel.zones.find((item) => item.groupId === "living-room");
    expect(living.entityIds).toEqual(["climate.additional"]);
    expect(living.modes.heat.savedWeek.Mon[0].temp).toBe(20);
    expect(living.modes.heat.draftWeek.Mon[0].temp).toBe(22);
    expect(living.modes.heat.dirty).toBe(true);
    expect(living.activeScheduleMode).toBeNull();
    expect(panel.scheduleStore.get("climate.additional").revision).toBe(5);
    expect(panel.selectedZoneId).toBe("climate.additional");
    expect(panel.membersDraft).toBeNull();
    expect(panel._hass.callWS.mock.calls[0][0]).toEqual({
      type: "nimbus_climate_scheduler/set_zone_members", zone_id: "living-room",
      source_entity_id: "climate.room", entity_ids: ["climate.additional"],
      expected_entity_ids: ["climate.room"], expected_revision: 4,
    });
    expect(panel._hass.callWS).toHaveBeenCalledTimes(2);
  });

  it("keeps the member selection and schedules on a failed save", async () => {
    const { panel, zone } = membershipPanel();
    const before = structuredClone(zone.modes);
    panel.membersDraft.selected.push("climate.additional");
    panel._hass.callWS = vi.fn().mockRejectedValue({ message: "Schedule changed elsewhere" });
    expect(await panel.saveZoneMembers()).toBe(false);
    expect(panel.membersDraft.error).toBe("Schedule changed elsewhere");
    expect(panel.membersDraft.selected).toEqual(["climate.room", "climate.additional"]);
    expect(zone.entityIds).toEqual(["climate.room"]);
    expect(zone.modes).toEqual(before);
    expect(panel.applying).toBe(false);
  });

  it("keeps missing configured thermostats visible for replacement", () => {
    const { panel } = membershipPanel();
    delete panel._hass.states["climate.room"];
    panel.syncZonesFromHass();
    const zone = panel.zones.find((item) => item.groupId === "living-room");
    expect(zone.entityIds).toEqual(["climate.room"]);
    expect(zone.unavailableEntities).toEqual(["climate.room"]);
    const checkbox = panel.renderZoneMembers(zone).querySelector('input[value="climate.room"]');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });

  it("edits matching days together without changing saved schedules", () => {
    const { panel, zone, schedule } = editingPanel();
    const saved = structuredClone(schedule.savedWeek);
    expect(panel.getDayGroups(zone)).toEqual([["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]]);

    for (let i = 0; i < 7; i++) panel.addSetpoint(zone, "Mon");

    expect(schedule.draftWeek.Mon).toHaveLength(8);
    expect(schedule.draftWeek.Sun).toEqual(schedule.draftWeek.Mon);
    expect(schedule.draftWeek.Sun).not.toBe(schedule.draftWeek.Mon);
    expect(schedule.savedWeek).toEqual(saved);
    expect(schedule.dirty).toBe(true);

    for (let i = 0; i < 7; i++) panel.removeSetpoint(zone, "Mon", 1);
    panel.removeSetpoint(zone, "Mon", 0);
    expect(schedule.draftWeek.Mon).toHaveLength(1);
    expect(schedule.draftWeek.Mon[0].minute).toBe(0);
  });

  it("preserves distinct days and only saves the chosen days", async () => {
    const { panel, zone, schedule } = editingPanel();
    schedule.savedWeek.Sun[0].temp = schedule.draftWeek.Sun[0].temp = 17;
    expect(panel.getDayGroups(zone)).toHaveLength(2);
    panel.daySelection = { zoneId: zone.id, mode: "heat", sourceDay: "Mon", days: ["Mon", "Wed"] };
    panel.updateDraftDay(zone, "Mon", (points) => { points[0].temp = 22; });
    expect(schedule.draftWeek.Wed[0].temp).toBe(22);
    expect(schedule.draftWeek.Tue[0].temp).toBe(20);
    expect(schedule.draftWeek.Sun[0].temp).toBe(17);
    panel.backendSyncComplete = true;
    panel._hass.callWS = vi.fn().mockResolvedValue({ revision: 1 });
    await panel.saveZoneDays(zone, "heat", ["Mon"]);
    expect(schedule.savedWeek.Mon[0].temp).toBe(22);
    expect(schedule.savedWeek.Wed[0].temp).toBe(20);
    expect(schedule.dirty).toBe(true);
    expect(panel._hass.callWS.mock.calls[0][0].data).not.toHaveProperty("activeScheduleMode");
  });

  it("selects only weekend days even when the editor was opened on Monday", () => {
    const { panel, zone, schedule } = editingPanel();
    const selector = panel.renderDaySelection(zone, "Mon");
    [...selector.querySelectorAll("button")].find((button) => button.textContent === "Weekend").click();
    expect(panel.daySelection.days).toEqual(["Sat", "Sun"]);
    expect(panel.selectedDay).toBe("Sat");
    panel.updateDraftDay(zone, panel.selectedDay, (points) => { points[0].temp = 22; });
    expect(schedule.draftWeek.Mon[0].temp).toBe(20);
    expect(schedule.draftWeek.Sat[0].temp).toBe(22);
    expect(schedule.draftWeek.Sun[0].temp).toBe(22);
  });

  it("inserts at a chosen time, including a short interval or after midnight", () => {
    const { panel, zone, schedule } = editingPanel();
    panel.groupDays = false;
    schedule.draftWeek.Mon = [0, 120, 240, 555, 810].map((minute) => ({ minute, temp: 19 }));
    expect(panel.addSetpoint(zone, "Mon", 180)).toBe(true); // 08:00
    expect(panel.addSetpoint(zone, "Mon", 1200)).toBe(true); // 01:00 the following day
    expect(panel.addSetpoint(zone, "Mon", 180)).toBe(false);
    expect(panel.addSetpoint(zone, "Mon", 0)).toBe(false);
    expect(schedule.draftWeek.Mon.map((point) => point.minute)).toEqual([0, 120, 180, 240, 555, 810, 1200]);
    expect(schedule.draftWeek.Tue).toHaveLength(1);
    expect(schedule.savedWeek.Mon).toHaveLength(1);
  });

  it("keeps failed saves as editable drafts", async () => {
    const { panel, zone, schedule } = editingPanel();
    panel.backendSyncComplete = true;
    panel._hass.callWS = vi.fn().mockRejectedValue({ code: "conflict", message: "Changed elsewhere" });
    panel.updateDraftDay(zone, "Mon", (points) => { points[0].temp = 22; });

    expect(await panel.saveZoneMode(zone, "heat")).toBe(false);
    expect(schedule.savedWeek.Mon[0].temp).toBe(20);
    expect(schedule.draftWeek.Mon[0].temp).toBe(22);
    expect(schedule.dirty).toBe(true);
    expect(panel.conflictZoneId).toBe(zone.id);
    expect(panel._hass.callWS).toHaveBeenCalledTimes(1);
  });

  it("receives automation pauses without overwriting drafts or writing back", async () => {
    const { panel, zone, schedule } = editingPanel();
    const data = {
      scheduleMode: "heat", activeScheduleMode: null, resumeScheduleMode: "heat", revision: 3,
      modes: structuredClone(zone.modes),
    };
    panel.getOrCreateStoreEntry(zone.id).revision = 3;
    panel.updateDraftDay(zone, "Mon", (points) => { points[0].temp = 22; });
    panel._hass.callWS = vi.fn().mockResolvedValue({
      climates: [{ entity: zone.entityId, name: "Room" }], zones: { [zone.entityId]: data },
    });

    await panel.syncBackendSchedules();

    expect(panel.zones[0].activeScheduleMode).toBeNull();
    expect(panel.zones[0].modes.heat.draftWeek.Mon[0].temp).toBe(22);
    expect(schedule.savedWeek.Mon[0].temp).toBe(20);
    expect(panel._hass.callWS).toHaveBeenCalledExactlyOnceWith({ type: "nimbus_climate_scheduler/get_zones" });
  });

  it("saves zone setup without writing existing schedules or local drafts back", async () => {
    const { panel, zone, schedule } = editingPanel();
    const data = { scheduleMode: "heat", activeScheduleMode: null, modes: structuredClone(zone.modes), revision: 3 };
    panel.getOrCreateStoreEntry(zone.id).revision = 3;
    panel.updateDraftDay(zone, "Mon", (points) => { points[0].temp = 22; });
    panel.backendSyncComplete = true;
    panel.climatesRevision = 7;
    panel.openSetup();
    panel.setupDraft = [{ entity: zone.entityId, name: "Renamed", checked: true }];
    const climates = [{ entity: zone.entityId, name: "Renamed", zone_id: "room" }];
    panel._hass.callWS = vi.fn().mockImplementation(async (command) => (
      command.type.endsWith("set_climates") ? { climates, revision: 8 }
        : { climates, climates_revision: 8, zones: { [zone.entityId]: data } }
    ));
    await panel.applySetup();
    expect(panel._hass.callWS.mock.calls.map(([command]) => command.type)).toEqual([
      "nimbus_climate_scheduler/set_climates", "nimbus_climate_scheduler/get_zones",
    ]);
    expect(panel._hass.callWS.mock.calls[0][0].expected_revision).toBe(7);
    expect(panel.zones[0].name).toBe("Renamed");
    expect(panel.zones[0].modes.heat).toBe(schedule);
    expect(schedule.savedWeek.Mon[0].temp).toBe(20);
    expect(schedule.draftWeek.Mon[0].temp).toBe(22);
    expect(panel.zones[0].activeScheduleMode).toBeNull();
  });

  it("keeps a conflicting zone selection tied to the revision that was opened", async () => {
    const { panel, zone } = editingPanel();
    panel.backendSyncComplete = true;
    panel.climatesRevision = 7;
    panel.openSetup();
    panel.setupDraft = [{ entity: zone.entityId, name: "Renamed", checked: true }];
    panel.climatesRevision = 8; // A live notification arrived while setup was open.
    const data = { modes: structuredClone(zone.modes), activeScheduleMode: null };
    panel._hass.callWS = vi.fn().mockImplementation(async (command) => {
      if (command.type.endsWith("set_climates")) throw { message: "The zone list changed elsewhere." };
      return { climates: [{ entity: zone.entityId }], climates_revision: 8, zones: { [zone.entityId]: data } };
    });
    await panel.applySetup();
    expect(panel._hass.callWS.mock.calls[0][0].expected_revision).toBe(7);
    expect(panel.showSetup).toBe(true);
    expect(panel.setupDraft[0].name).toBe("Renamed");
    expect(panel.applyResultData.failed[0].error).toContain("changed elsewhere");
  });

  it("defers live synchronization while a temperature input is being edited", async () => {
    const { panel } = editingPanel();
    window.matchMedia = vi.fn(() => ({ addEventListener() {}, removeEventListener() {} }));
    document.body.append(panel);
    const zone = panel.zones[0];
    const schedule = zone.modes.heat;
    panel.getOrCreateStoreEntry(zone.id).revision = 3;
    const remote = { modes: structuredClone(zone.modes), activeScheduleMode: null, revision: 4 };
    remote.modes.heat.savedWeek.Mon[0].temp = 21;
    panel._hass.callWS = vi.fn().mockResolvedValue({
      climates: [{ entity: zone.entityId }], zones: { [zone.entityId]: remote },
    });
    const editor = document.createElement("div");
    panel.renderSetpointPanel(editor, zone, "Mon", schedule.draftWeek.Mon, schedule.savedWeek.Mon, true);
    panel.root.append(editor);
    const input = editor.querySelector('input[type="number"]');
    input.focus();
    input.value = "22";
    await panel.syncBackendSchedules();
    expect(panel._hass.callWS).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("change"));
    input.blur();
    await vi.waitFor(() => expect(panel._hass.callWS).toHaveBeenCalledTimes(1));
    expect(panel.zones[0].modes.heat.draftWeek.Mon[0].temp).toBe(22);
    expect(panel.scheduleStore.get(zone.id).revision).toBe(3);
  });

  it("keeps a drag draft when a backend response arrives after dragging starts", async () => {
    const { panel, zone, schedule } = editingPanel();
    panel.getOrCreateStoreEntry(zone.id).revision = 3;
    let finish;
    panel._hass.callWS = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = panel.syncBackendSchedules();
    panel.activeDrag = { zoneId: zone.id };
    schedule.draftWeek.Mon[0].temp = 22;
    finish({ climates: [{ entity: zone.entityId }], zones: {
      [zone.entityId]: { modes: structuredClone(zone.modes), revision: 4 },
    } });
    await pending;
    expect(panel.scheduleStore.get(zone.id).revision).toBe(3);
    expect(panel.zones[0].modes.heat).toBe(schedule);
    expect(panel._syncQueued).toBe(true);
  });

  it("does not bring back an old server draft after it was discarded locally", async () => {
    const { panel, zone } = editingPanel();
    const data = { scheduleMode: "heat", activeScheduleMode: "heat", modes: structuredClone(zone.modes) };
    data.modes.heat.draftWeek.Mon[0].temp = 23;
    window.localStorage.setItem("nimbus-climate-scheduler:v1:climate.room", JSON.stringify({
      scheduleMode: "heat", activeScheduleMode: "heat", modes: zone.modes,
    }));
    panel._hass.callWS = vi.fn().mockResolvedValue({
      climates: [{ entity: zone.entityId, name: "Room" }], zones: { [zone.entityId]: data },
    });
    await panel.syncBackendSchedules();
    expect(panel.zones[0].modes.heat.draftWeek.Mon[0].temp).toBe(20);
    expect(panel.zones[0].modes.heat.dirty).toBe(false);
  });

  it("restores existing five-interval schedules and drafts without changing times", () => {
    const points = [0, 120, 240, 555, 810].map((minute) => ({ minute, temp: 19.5 }));
    const week = Object.fromEntries(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => [day, points]));
    const draft = structuredClone(week);
    draft.Tue[1].temp = 21;
    window.localStorage.setItem("nimbus-climate-scheduler:v1:climate.room", JSON.stringify({
      scheduleMode: "heat", activeScheduleMode: null,
      modes: { heat: { savedWeek: week, draftWeek: draft } },
    }));
    const { zone, schedule } = editingPanel();
    expect(schedule.savedWeek).toEqual(week);
    expect(schedule.draftWeek).toEqual(draft);
    expect(zone.activeScheduleMode).toBeNull();
    expect(schedule.dirty).toBe(true);
  });

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

  it("allows pausing a saved active schedule when thermostat capabilities become incompatible", () => {
    const { panel, zone } = editingPanel();
    panel.backendSyncComplete = true;
    panel.getOrCreateStoreEntry(zone.id).activeScheduleMode = "heat";
    panel._hass.states[zone.entityId].attributes.hvac_modes = ["off", "fan_only"];
    const current = panel.makeZoneFromClimate({ entity: zone.entityId });
    expect(current.capabilitiesCompatible).toBe(false);
    expect(current.supportedScheduleModes).toEqual([]);
    expect(current.activeScheduleMode).toBe("heat");
    expect(panel.renderZoneSwitch(current).disabled).toBe(false);
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
