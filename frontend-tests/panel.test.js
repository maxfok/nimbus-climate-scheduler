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
  it.each([
    [null, "on", null, "No active schedule"],
    ["heat", "on", null, "Heating"],
    ["heat", "off", "manual", "Paused"],
    ["heat", "off", "automation", "Paused due to control by automation"],
    [null, "off", "manual", "No active schedule · Paused"],
    [null, "off", "automation", "No active schedule · Paused due to control by automation"],
  ])("shows schedule and pause independently (%s, %s, %s)", (mode, state, reason, expected) => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel._hass = { states: { "switch.room_schedule": { state, attributes: {
      nimbus_schedule_zone: "room", climate_entities: ["climate.room"], pause_reason: reason,
    } } } };
    expect(panel.zoneStatusText({ entityIds: ["climate.room"], activeScheduleMode: mode, hvacMode: "heat" })).toBe(expected);
  });

  it("saves a zone atomically with the last confirmed revision", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
    panel.scheduleRevisions = { room: 4 };
    const callWS = vi.fn().mockResolvedValue({ revision: 5 });
    panel._hass = { callWS };
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const zone = { entityId: "climate.room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat: { savedWeek: week, draftWeek: week } } };
    await panel.saveZoneToBackend(zone);
    expect(callWS).toHaveBeenCalledWith(expect.objectContaining({ type: "nimbus_climate_scheduler/save_group_schedule", zone_id: "room", expected_revision: 4 }));
    expect(panel.scheduleRevisions.room).toBe(5);
  });

  it.each(["save failed", "conflict: newer changes"])('keeps draft and dirty state on %s', async (message) => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
    panel.scheduleRevisions = { room: 2 };
    panel._hass = { callWS: vi.fn().mockRejectedValue(new Error(message)) };
    panel.render = vi.fn(); panel.renderIfReady = vi.fn();
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const draft = structuredClone(week); draft.Mon[0].temp = 22;
    const schedule = { savedWeek: structuredClone(week), draftWeek: draft, dirty: true };
    const zone = { entityId: "climate.room", name: "Room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat: schedule } };
    await panel.saveZoneMode(zone, "heat");
    expect(schedule.draftWeek.Mon[0].temp).toBe(22);
    expect(schedule.savedWeek.Mon[0].temp).toBe(20);
    expect(schedule.dirty).toBe(true);
    expect(panel.scheduleRevisions.room).toBe(2);
    expect(panel.applyResultData.failed[0].error).toBe(message);
  });

  it("keeps newer draft edits dirty while a save is pending", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
    panel.scheduleRevisions = { room: 0 };
    let resolveSave;
    panel._hass = { callWS: vi.fn().mockImplementation(({ type }) => type.endsWith("save_group_schedule") ? new Promise(resolve => { resolveSave = resolve; }) : Promise.resolve({})) };
    panel.render = vi.fn(); panel.renderIfReady = vi.fn();
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const schedule = { savedWeek: structuredClone(week), draftWeek: structuredClone(week), dirty: true };
    schedule.draftWeek.Mon[0].temp = 21;
    const zone = { entityId: "climate.room", name: "Room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat: schedule } };
    const saving = panel.saveZoneMode(zone, "heat");
    await Promise.resolve();
    schedule.draftWeek.Mon[0].temp = 22;
    resolveSave({ revision: 1 });
    await saving;
    expect(schedule.savedWeek.Mon[0].temp).toBe(21);
    expect(schedule.draftWeek.Mon[0].temp).toBe(22);
    expect(schedule.dirty).toBe(true);
  });

  it("serializes automatic and manual saves without reverting the confirmed week", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true; panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
    panel.scheduleRevisions = { room: 0 }; panel.render = vi.fn(); panel.renderIfReady = vi.fn();
    let release; const writes = [];
    panel._hass = { callWS: vi.fn(async msg => {
      if (msg.type.endsWith("apply_now")) return {};
      writes.push(structuredClone(msg));
      if (writes.length === 1) await new Promise(resolve => { release = resolve; });
      return { revision: writes.length };
    }) };
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const schedule = { savedWeek: structuredClone(week), draftWeek: structuredClone(week), dirty: true };
    schedule.draftWeek.Mon[0].temp = 21;
    const zone = { entityId: "climate.room", name: "Room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat: schedule } };
    const saved = panel.saveZoneMode(zone, "heat"); await Promise.resolve();
    schedule.draftWeek.Mon[0].temp = 22;
    const next = panel.saveZoneToBackend(zone);
    release(); await Promise.all([saved, next]);
    expect(writes).toHaveLength(2);
    expect(writes[1].expected_revision).toBe(1);
    expect(writes[1].data.modes.heat.savedWeek.Mon[0].temp).toBe(21);
    expect(writes[1].data.modes.heat.draftWeek.Mon[0].temp).toBe(22);
    expect(schedule.dirty).toBe(true);
  });

  it("rejects stale independent sessions without discarding the other draft", async () => {
    let revision = 0;
    const backend = vi.fn(async msg => {
      if (msg.type.endsWith("apply_now")) return {};
      if (msg.expected_revision !== revision) throw new Error("conflict: newer changes");
      return { revision: ++revision };
    });
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const makeSession = (temp) => {
      const panel = document.createElement("nimbus-climate-scheduler-panel");
      panel.backendSyncComplete = true; panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
      panel.scheduleRevisions = { room: 0 }; panel._hass = { callWS: backend }; panel.render = vi.fn(); panel.renderIfReady = vi.fn();
      const schedule = { savedWeek: structuredClone(week), draftWeek: structuredClone(week), dirty: true };
      schedule.draftWeek.Mon[0].temp = temp;
      return { panel, schedule, zone: { entityId: "climate.room", name: "Room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat: schedule } } };
    };
    const a = makeSession(21), b = makeSession(22);
    await a.panel.saveZoneMode(a.zone, "heat"); await b.panel.saveZoneMode(b.zone, "heat");
    expect(revision).toBe(1); expect(b.panel.scheduleRevisions.room).toBe(0);
    expect(b.schedule.draftWeek.Mon[0].temp).toBe(22); expect(b.schedule.savedWeek.Mon[0].temp).toBe(20);
    expect(b.schedule.dirty).toBe(true); expect(b.panel.applyResultData.failed[0].error).toContain("conflict");
  });

  it("keeps heat and cool saves bound to their original mode while queued", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true; panel.serverClimates = [{ entity: "climate.room", zone_id: "room" }];
    panel.scheduleRevisions = { room: 0 }; panel.render = vi.fn(); panel.renderIfReady = vi.fn();
    let release; const writes = [];
    panel._hass = { callWS: vi.fn(async msg => {
      if (msg.type.endsWith("apply_now")) return {};
      writes.push(structuredClone(msg)); if (writes.length === 1) await new Promise(resolve => { release = resolve; });
      return { revision: writes.length };
    }) };
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const mode = () => ({ savedWeek: structuredClone(week), draftWeek: structuredClone(week), dirty: true });
    const heat = mode(), cool = mode(); heat.draftWeek.Mon[0].temp = 21; cool.draftWeek.Mon[0].temp = 25;
    const zone = { entityId: "climate.room", name: "Room", scheduleMode: "heat", activeScheduleMode: "heat", modes: { heat, cool } };
    const first = panel.saveZoneMode(zone, "heat"); await Promise.resolve(); zone.scheduleMode = "cool";
    const second = panel.saveZoneMode(zone, "cool"); release(); await Promise.all([first, second]);
    expect(writes[1].data.modes.heat.savedWeek.Mon[0].temp).toBe(21);
    expect(writes[1].data.modes.cool.savedWeek.Mon[0].temp).toBe(25);
    expect(heat.dirty).toBe(false); expect(cool.dirty).toBe(false);
  });

  it("initializes a new zone without rewriting an existing schedule", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel.setupDraft = [{ entity: "climate.old", name: "Old", checked: true }, { entity: "climate.new", name: "New", checked: true }];
    const oldZone = { entityId: "climate.old", entityIds: ["climate.old"] };
    const newZone = { entityId: "climate.new", entityIds: ["climate.new"] };
    panel.syncZonesFromHass = vi.fn(() => { panel.zones = [oldZone, newZone]; });
    panel.render = vi.fn(); panel.saveZoneToBackend = vi.fn().mockResolvedValue({});
    panel._hass = { callWS: vi.fn(async msg => msg.type.endsWith("set_climates")
      ? { climates: [{ entity: "climate.old", name: "Old", zone_id: "old" }, { entity: "climate.new", name: "New", zone_id: "new" }] }
      : { zones: { "climate.old": { modes: {} } }, schedule_revisions: { old: 7 } }) };
    await panel.applySetup();
    expect(panel.saveZoneToBackend).toHaveBeenCalledTimes(1);
    expect(panel.saveZoneToBackend).toHaveBeenCalledWith(newZone);
    expect(panel.scheduleRevisions.old).toBe(7);
    expect(panel._hass.callWS.mock.calls[0][0]).toEqual(expect.objectContaining({ expected_store_revision: 0 }));
  });

  it("keeps zone setup open and unchanged when membership revision conflicts", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.setupDraft = [{ entity: "climate.new", name: "New", checked: true }];
    panel.showSetup = true; panel.setupStoreRevision = 3; panel.storeRevision = 5;
    panel._hass = { callWS: vi.fn().mockRejectedValue(new Error("Zone configuration changed elsewhere")) };
    panel.renderIfReady = vi.fn();
    await panel.applySetup();
    expect(panel._hass.callWS).toHaveBeenCalledWith(expect.objectContaining({ expected_store_revision: 3 }));
    expect(panel.showSetup).toBe(true);
    expect(panel.setupDraft[0].entity).toBe("climate.new");
    expect(panel.applyResultData.failed[0].error).toContain("changed elsewhere");
  });

  it("defers subscription refresh while a local draft is dirty", () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    panel.scheduleStore.set("climate.room", { modes: { heat: { dirty: true } } });
    panel.syncBackendSchedules = vi.fn().mockResolvedValue();
    panel.requestBackendRefresh();
    expect(panel.syncBackendSchedules).not.toHaveBeenCalled();
    expect(panel._refreshPending).toBe(true);
    panel.scheduleStore.get("climate.room").modes.heat.dirty = false;
    panel.flushBackendRefresh();
    expect(panel.syncBackendSchedules).toHaveBeenCalledTimes(1);
  });

  it("keeps a refresh pending after a failed save while the draft remains dirty", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    panel.backendSyncComplete = true;
    const entry = { modes: { heat: { dirty: true } } };
    panel.scheduleStore.set("climate.room", entry);
    panel.syncBackendSchedules = vi.fn().mockResolvedValue();
    panel.zoneSaveQueues = new Map([["room", Promise.reject(new Error("save failed"))]]);
    panel.zoneSaveQueues.get("room").catch(() => {});
    panel.requestBackendRefresh();
    panel.zoneSaveQueues.clear(); panel.flushBackendRefresh();
    expect(panel._refreshPending).toBe(true);
    expect(panel.syncBackendSchedules).not.toHaveBeenCalled();
    entry.modes.heat.dirty = false;
    panel.flushBackendRefresh();
    expect(panel.syncBackendSchedules).toHaveBeenCalledTimes(1);
  });

  it("rechecks pending refresh after the Home Assistant connection becomes ready", () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    const connection = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    panel._hass = { connection }; panel.backendSyncComplete = true;
    panel.syncBackendSchedules = vi.fn().mockResolvedValue();
    panel.bindBackendConnection();
    const ready = connection.addEventListener.mock.calls.find(([type]) => type === "ready")[1];
    ready();
    expect(panel.syncBackendSchedules).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a dirty draft when reconnect fetch completes", async () => {
    const panel = document.createElement("nimbus-climate-scheduler-panel");
    const week = Object.fromEntries(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => [day, [{ minute: 0, temp: 20 }]]));
    const draft = structuredClone(week); draft.Mon[0].temp = 23;
    const entry = { modes: { heat: { savedWeek: structuredClone(week), draftWeek: draft, dirty: true } } };
    panel.scheduleStore.set("climate.room", entry);
    panel._hasBackendSnapshot = true; panel.backendSyncComplete = false;
    panel._hass = { callWS: vi.fn().mockResolvedValue({ zones: { "climate.room": { modes: { heat: { savedWeek: week, draftWeek: week } } } }, climates: [] }) };
    await panel.syncBackendSchedules();
    expect(entry.modes.heat.draftWeek.Mon[0].temp).toBe(23);
    expect(entry.modes.heat.dirty).toBe(true);
    expect(panel._refreshPending).toBe(true);
    expect(panel._hass.callWS).toHaveBeenCalledTimes(1);
  });

});
