const DAY_START_MINUTES = 5 * 60;
const DAY_LENGTH_MINUTES = 24 * 60;
const SNAP_MINUTES = 15;
const SCHEDULER_TICK_MS = 30 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_PREFIX = "nimbus-climate-scheduler:v1";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STYLE_URL = new URL(`./styles.css${new URL(import.meta.url).search}`, import.meta.url).href;

const PANEL_HTML = `
  <link rel="stylesheet" href="${STYLE_URL}">
  <main class="schedule-view" id="scheduleView">
    <header class="topbar">
      <div class="topbar-title">
        <button class="menu-button" id="menuButton" type="button" aria-label="Toggle sidebar" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
          </svg>
        </button>
        <div>
          <p class="eyebrow">Nimbus Climate</p>
          <h1>Thermostat Scheduler</h1>
        </div>
      </div>
      <div class="topbar-actions">
        <span class="scheduler-status" id="schedulerStatus">Scheduler idle</span>
        <button class="setup-button" id="setupButton" type="button">Add Zone</button>
      </div>
    </header>

    <section id="guardBar" class="guard-bar" hidden aria-live="polite"></section>
    <section id="setupWizard" class="setup-wizard" hidden></section>
    <section id="applyResult" class="apply-result" hidden aria-live="polite"></section>
    <section id="zones" class="zones" aria-label="Thermostat zones"></section>
  </main>

  <template id="zoneTemplate">
    <article class="zone">
      <button class="zone-header" type="button">
        <span class="thermo-icon" aria-hidden="true"></span>
        <span class="zone-name"></span>
        <span class="zone-temp"></span>
        <span class="zone-mode"></span>
        <span class="zone-switch-slot"></span>
      </button>
      <div class="zone-body"></div>
    </article>
  </template>

  <template id="dayTemplate">
    <section class="day-row">
      <div class="day-meta">
        <button class="day-button" type="button"></button>
        <span class="day-current"></span>
      </div>
      <div class="timeline-wrap">
        <div class="timeline">
          <div class="reference-segments"></div>
          <div class="segments"></div>
          <div class="ticks"></div>
          <div class="reference-handles"></div>
          <div class="handles"></div>
        </div>
      </div>
      <div class="setpoint-panel"></div>
    </section>
  </template>
`;

class NimbusClimateSchedulerPanel extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.selectedZoneId = null;
    this.selectedDay = null;
    this.activeDrag = null;
    this.timeBubble = null;
    this.pendingNavigation = null;
    this.renderPending = false;
    this.temperatureUnit = "°C";
    this.serverClimates = null;
    this.showSetup = false;
    this.setupDraft = null;
    this.applying = false;
    this.applyResultData = null;
    this.schedulerTimer = null;
    this.schedulerTickTimer = null;
    this.lastSchedulerRun = null;
    this.schedulerRunning = false;
    this.backendSyncStarted = false;
    this.backendSyncComplete = false;
    this.zonesSignature = null;
    this.scheduleStore = new Map();
    this.zones = this.adoptZones(createDemoZones());
    this.onPointerMove = this.onPointerMove.bind(this);
    this.stopDrag = this.stopDrag.bind(this);
  }

  set hass(hass) {
    this._hass = hass;
    this.temperatureUnit = hass?.config?.unit_system?.temperature ?? "°C";
    this.updateMenuButton();
    // hass updates arrive for every entity in the house; only re-render
    // when something the panel actually shows has changed.
    if (this.syncZonesFromHass()) {
      this.ensureBackendSync();
      this.renderIfReady();
      this.queueSchedulerTick(500);
    }
  }

  set narrow(narrow) {
    this._narrow = Boolean(narrow);
    this.updateNarrow();
  }

  updateNarrow() {
    // The host carries a desktop min-width, so its own size can't be used to
    // detect a small screen; go by the viewport (plus HA's narrow flag).
    this.toggleAttribute("narrow", this._narrow || Boolean(this.narrowMedia?.matches));
    this.updateMenuButton();
  }

  updateMenuButton() {
    if (!this.menuButton) return;
    // Without it, a hidden sidebar leaves no way to navigate out of the panel.
    const show = this.hasAttribute("narrow") || this._hass?.dockedSidebar === "always_hidden";
    this.menuButton.hidden = !show;
  }

  set route(route) {
    this._route = route;
  }

  set panel(panel) {
    this._panel = panel;
    this.syncZonesFromHass();
    this.renderIfReady();
  }

  connectedCallback() {
    if (this.isConnectedOnce) return;

    this.isConnectedOnce = true;
    this.root.innerHTML = PANEL_HTML;
    this.cacheElements();
    this.setupEvents();
    this.syncZonesFromHass();
    this.ensureBackendSync();
    this.startScheduler();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.stopDrag);
    window.removeEventListener("pointercancel", this.stopDrag);
    this.stopScheduler();
    this.hideBubble();
  }

  cacheElements() {
    this.scheduleView = this.root.querySelector("#scheduleView");
    this.zonesEl = this.root.querySelector("#zones");
    this.guardBar = this.root.querySelector("#guardBar");
    this.applyResult = this.root.querySelector("#applyResult");
    this.setupWizard = this.root.querySelector("#setupWizard");
    this.setupButton = this.root.querySelector("#setupButton");
    this.menuButton = this.root.querySelector("#menuButton");
    this.schedulerStatus = this.root.querySelector("#schedulerStatus");
    this.zoneTemplate = this.root.querySelector("#zoneTemplate");
    this.dayTemplate = this.root.querySelector("#dayTemplate");
  }

  setupEvents() {
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.stopDrag);
    window.addEventListener("pointercancel", this.stopDrag);
    this.setupButton.addEventListener("click", () => this.openSetup());
    this.menuButton.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });

    // Flush a render deferred while a form control was focused.
    this.root.addEventListener("focusout", () => {
      if (!this.renderPending) return;
      queueMicrotask(() => {
        const active = this.root.activeElement?.tagName;
        if (this.renderPending && !this.activeDrag && active !== "SELECT" && active !== "INPUT") {
          this.render();
        }
      });
    });

    this.narrowMedia = window.matchMedia("(max-width: 760px)");
    this.narrowMedia.addEventListener("change", () => this.updateNarrow());
    this.updateNarrow();
  }

  startScheduler() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = window.setInterval(() => this.runSchedulerTick(), SCHEDULER_TICK_MS);
    this.queueSchedulerTick(1000);
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.schedulerTickTimer) {
      window.clearTimeout(this.schedulerTickTimer);
      this.schedulerTickTimer = null;
    }
  }

  queueSchedulerTick(delay = 0) {
    if (!this.isConnectedOnce || this.backendSyncComplete || this.schedulerTickTimer) return;
    this.schedulerTickTimer = window.setTimeout(() => {
      this.schedulerTickTimer = null;
      this.runSchedulerTick();
    }, delay);
  }

  syncZonesFromHass() {
    const climateConfigs = this.getConfiguredClimates();
    if (!climateConfigs.length || !this._hass?.states) return false;

    // Entities sharing a zone name form one zone with a shared schedule.
    const groups = new Map();
    for (const config of climateConfigs) {
      const state = this._hass.states[config.entity];
      if (!state) continue;
      const zoneName = config.name ?? state.attributes.friendly_name ?? config.entity;
      if (!groups.has(zoneName)) groups.set(zoneName, []);
      groups.get(zoneName).push(config);
    }

    const nextZones = [...groups.entries()]
      .map(([zoneName, configs]) => this.makeZoneFromClimate(configs[0], {
        name: zoneName,
        entityIds: configs.map((config) => config.entity),
      }))
      .filter(Boolean);

    if (!nextZones.length) return false;

    this.zones = nextZones;

    const signature = JSON.stringify(nextZones.map((zone) => [
      zone.id,
      zone.name,
      zone.entityIds,
      zone.unavailableEntities,
      zone.currentTemp,
      zone.targetTemp,
      zone.hvacMode,
      zone.activeScheduleMode,
      zone.supportedScheduleModes,
      zone.minTemp,
      zone.maxTemp,
      zone.tempStep,
    ]));
    const changed = signature !== this.zonesSignature;
    this.zonesSignature = signature;
    return changed;
  }

  ensureBackendSync() {
    if (this.backendSyncStarted || !this.isConnectedOnce || !this._hass?.callWS) return;
    this.backendSyncStarted = true;
    this.syncBackendSchedules();
  }

  async syncBackendSchedules() {
    try {
      const result = await this._hass.callWS({ type: "nimbus_climate_scheduler/get_zones" });
      const zones = result?.zones ?? {};
      this.serverClimates = Array.isArray(result?.climates) && result.climates.length
        ? result.climates
        : null;
      let loaded = false;

      for (const [entityId, data] of Object.entries(zones)) {
        const zone = this.findZone(entityId);
        const supportedModes = zone?.supportedScheduleModes ?? ["heat", "cool"];
        const modes = restoreStoredModes(data?.modes);
        if (!modes) continue;

        const entry = this.getOrCreateStoreEntry(entityId);
        entry.modes = modes;
        entry.scheduleMode = this.normalizeScheduleMode(data.scheduleMode, supportedModes);
        entry.activeScheduleMode = this.normalizeActiveScheduleMode(data.activeScheduleMode, supportedModes);
        loaded = true;
      }

      this.backendSyncComplete = true;
      this.stopScheduler();

      // First run: nothing stored and nothing configured — open the setup wizard.
      const yamlClimates = this._panel?.config?.climates ?? this._panel?.config?.zones ?? [];
      if (!Object.keys(zones).length && !this.serverClimates && !yamlClimates.length) {
        this.showSetup = true;
        this.renderIfReady();
        return;
      }

      if (loaded || this.serverClimates) {
        this.zonesSignature = null;
        this.syncZonesFromHass();
        this.renderIfReady();
      }
      await this.pushAllSchedulesToBackend();
    } catch {
      this.backendSyncComplete = false;
    }
  }

  async pushAllSchedulesToBackend() {
    if (!this._hass?.callWS) return;
    await Promise.all(this.zones.map((zone) => this.saveZoneToBackend(zone)));
  }

  openSetup() {
    this.setupDraft = null;
    this.showSetup = true;
    this.render();
  }

  closeSetup() {
    this.showSetup = false;
    this.setupDraft = null;
    this.render();
  }

  areaNameForEntity(entityId) {
    const registryEntry = this._hass?.entities?.[entityId];
    const areaId = registryEntry?.area_id
      ?? (registryEntry?.device_id
        ? this._hass?.devices?.[registryEntry.device_id]?.area_id
        : null);
    return areaId ? this._hass?.areas?.[areaId]?.name ?? null : null;
  }

  buildSetupDraft() {
    const selected = new Map();
    for (const zone of this.zones) {
      for (const entityId of zone.entityIds ?? (zone.entityId ? [zone.entityId] : [])) {
        selected.set(entityId, zone.name);
      }
    }
    const hasSelection = selected.size > 0 && (this.serverClimates ?? this._panel?.config?.climates)?.length;

    return Object.keys(this._hass?.states ?? {})
      .filter((entityId) => entityId.startsWith("climate."))
      .sort()
      .map((entityId) => {
        const area = this.areaNameForEntity(entityId);
        return {
          entity: entityId,
          area,
          // The room the thermostat lives in is the default zone suggestion;
          // an explicit earlier selection keeps its zone name.
          name: (hasSelection ? selected.get(entityId) : null)
            ?? area
            ?? this._hass.states[entityId].attributes.friendly_name
            ?? entityId,
          checked: hasSelection ? selected.has(entityId) : true,
        };
      });
  }

  async applySetup() {
    const chosen = (this.setupDraft ?? []).filter((item) => item.checked);
    if (!chosen.length) return;

    const climates = chosen.map((item) => ({
      entity: item.entity,
      name: item.name?.trim() || null,
    }));

    if (this._hass?.callWS) {
      try {
        await this._hass.callWS({
          type: "nimbus_climate_scheduler/set_climates",
          climates,
        });
      } catch {
        // Backend unavailable; keep the selection client-side anyway.
      }
    }

    this.serverClimates = climates;
    this.showSetup = false;
    this.setupDraft = null;
    this.zonesSignature = null;
    this.syncZonesFromHass();
    this.render();
    await this.pushAllSchedulesToBackend();
  }

  renderSetup() {
    this.setupWizard.replaceChildren();
    this.setupWizard.hidden = !this.showSetup;
    if (!this.showSetup) return;

    this.setupDraft ??= this.buildSetupDraft();

    const title = document.createElement("h2");
    title.className = "setup-title";
    title.textContent = "Set up climate zones";

    const hint = document.createElement("p");
    hint.className = "setup-hint";
    hint.textContent = "Pick the thermostats to schedule and place each one in a zone — the room it lives in is suggested by default. Thermostats sharing a zone name follow one shared schedule. Each zone gets a default Heat and Cool schedule you can fine-tune afterwards.";

    const list = document.createElement("div");
    list.className = "setup-list";

    if (!this.setupDraft.length) {
      const empty = document.createElement("p");
      empty.className = "setup-hint";
      empty.textContent = "No climate entities found in Home Assistant yet.";
      list.append(empty);
    }

    for (const item of this.setupDraft) {
      const row = document.createElement("label");
      row.className = "setup-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.checked;
      checkbox.addEventListener("change", () => {
        item.checked = checkbox.checked;
        row.classList.toggle("selected", item.checked);
        const confirmButton = this.setupWizard.querySelector(".setup-confirm");
        if (confirmButton) {
          confirmButton.disabled = !this.setupDraft.some((entry) => entry.checked);
        }
      });

      const entity = document.createElement("span");
      entity.className = "setup-entity";
      entity.textContent = item.area ? `${item.entity} · 📍 ${item.area}` : item.entity;

      const name = document.createElement("input");
      name.type = "text";
      name.className = "setup-name";
      name.value = item.name;
      name.placeholder = "Zone";
      name.addEventListener("click", (event) => event.preventDefault());
      name.addEventListener("input", () => {
        item.name = name.value;
      });

      row.classList.toggle("selected", item.checked);
      row.append(checkbox, name, entity);
      list.append(row);
    }

    const actions = document.createElement("div");
    actions.className = "setup-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeSetup());

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "setup-confirm";
    confirm.textContent = "Create zones";
    confirm.disabled = !this.setupDraft.some((item) => item.checked);
    confirm.addEventListener("click", () => this.applySetup());

    actions.append(cancel, confirm);
    this.setupWizard.append(title, hint, list, actions);
  }

  async saveZoneToBackend(zone) {
    if (!zone.entityId || !this._hass?.callWS) return;
    // Every entity in the zone carries the shared schedule, so the backend
    // scheduler drives each thermostat in the group.
    const data = serializeZoneSchedule(zone);
    await Promise.all((zone.entityIds ?? [zone.entityId]).map((entityId) =>
      this._hass.callWS({
        type: "nimbus_climate_scheduler/save_zone",
        entity_id: entityId,
        data,
      })));
  }

  getConfiguredClimates() {
    const config = this._panel?.config ?? {};
    // The user's in-panel selection (setup wizard) wins over YAML config.
    const entries = this.serverClimates ?? config.climates ?? config.zones ?? [];

    if (!Array.isArray(entries) || !entries.length) {
      if (!this._hass?.states) return [];
      return Object.keys(this._hass.states)
        .filter((entityId) => entityId.startsWith("climate."))
        .map((entity) => ({ entity }));
    }

    return entries
      .map((entry) => {
        if (typeof entry === "string") return { entity: entry };
        if (entry?.entity) return entry;
        if (entry?.entity_id) return { ...entry, entity: entry.entity_id };
        return null;
      })
      .filter((entry) => entry?.entity?.startsWith("climate."));
  }

  renderZoneColumnHeaders() {
    const head = document.createElement("div");
    head.className = "zone-column-headers";
    head.setAttribute("aria-hidden", "true");

    for (const [cls, text] of [
      ["zch-icon", "Icon"],
      ["zch-name", "Name"],
      ["zch-temp", "Temp"],
      ["zch-mode", "Mode"],
      ["zch-manage", "Active · Manage"],
    ]) {
      const cell = document.createElement("span");
      cell.className = cls;
      cell.textContent = text;
      head.append(cell);
    }

    return head;
  }

  renderZoneStatus(zone) {
    const row = document.createElement("div");
    row.className = "zone-status";

    const label = document.createElement("span");
    label.className = "zone-status-label";
    label.textContent = "Status:";

    const unavailable = zone.unavailableEntities ?? [];
    const value = document.createElement("span");
    value.className = `zone-status-value${unavailable.length ? " warn" : ""}`;
    value.textContent = unavailable.length
      ? `⚠ Unavailable: ${unavailable.join(", ")}`
      : "ℹ️ All thermostats are properly supported";

    row.append(label, value);
    return row;
  }

  renderZoneName(container, zone) {
    container.replaceChildren();

    const name = document.createElement("span");
    name.textContent = zone.name;
    container.append(name);

    if (!zone.entityId) return;

    const entityIds = zone.entityIds ?? [zone.entityId];
    const entity = document.createElement("span");
    entity.className = "zone-entity";
    entity.textContent = entityIds.join(" · ");
    container.append(entity);
    container.title = entityIds.join(", ");
  }

  makeZoneFromClimate(config, group = null) {
    const state = this._hass.states[config.entity];
    if (!state) return null;
    const stored = loadStoredEntitySchedule(config.entity);

    const supportedModes = this.getSupportedScheduleModes(state);
    const entry = this.getOrCreateStoreEntry(config.entity);
    const scheduleMode = this.normalizeScheduleMode(
      entry.scheduleMode ?? stored?.scheduleMode ?? config.schedule_mode,
      supportedModes,
    );
    const activeScheduleMode = this.normalizeActiveScheduleMode(
      entry.activeScheduleMode !== undefined
        ? entry.activeScheduleMode
        : Object.prototype.hasOwnProperty.call(stored ?? {}, "activeScheduleMode")
          ? stored.activeScheduleMode
          : state.state,
      supportedModes,
    );
    const modes = this.getOrCreateSchedules(config.entity, state, stored?.modes);
    this.ensureSchedulesForModes(modes, supportedModes, state);

    // Mutate the entry in place — zone objects from every render generation
    // read scheduleMode through this shared object, so it must never be replaced.
    entry.modes = modes;
    entry.scheduleMode = scheduleMode;
    entry.activeScheduleMode = activeScheduleMode;

    const entityIds = group?.entityIds ?? [config.entity];
    const unavailableEntities = entityIds.filter((entityId) => {
      const entityState = this._hass.states[entityId]?.state;
      return !entityState || entityState === "unavailable" || entityState === "unknown";
    });

    const zone = {
      id: config.entity,
      entityId: config.entity,
      entityIds,
      unavailableEntities,
      name: group?.name ?? config.name ?? state.attributes.friendly_name ?? config.entity,
      currentTemp: formatTemperature(state.attributes.current_temperature ?? state.attributes.temperature),
      targetTemp: formatTemperature(state.attributes.temperature),
      // Limits and resolution come from the device itself (already in the
      // HA-configured unit system, so °F installs get °F numbers).
      minTemp: coerceFiniteNumber(state.attributes.min_temp, this.defaultMinTemp()),
      maxTemp: coerceFiniteNumber(state.attributes.max_temp, this.defaultMaxTemp()),
      tempStep: coerceFiniteNumber(state.attributes.target_temp_step, 0.5) || 0.5,
      supportedScheduleModes: supportedModes,
      hvacMode: state.state ?? "off",
      modes,
    };
    this.bindZoneToStore(zone, entry);
    return zone;
  }

  getOrCreateStoreEntry(zoneId) {
    let entry = this.scheduleStore.get(zoneId);
    if (!entry) {
      entry = { modes: null, scheduleMode: null, activeScheduleMode: undefined };
      this.scheduleStore.set(zoneId, entry);
    }
    return entry;
  }

  bindZoneToStore(zone, entry) {
    Object.defineProperty(zone, "scheduleMode", {
      get: () => entry.scheduleMode,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(zone, "activeScheduleMode", {
      get: () => entry.activeScheduleMode,
      enumerable: true,
      configurable: true,
    });
  }

  adoptZones(zones) {
    for (const zone of zones) {
      const entry = this.getOrCreateStoreEntry(zone.id);
      entry.modes ??= zone.modes;
      entry.scheduleMode ??= zone.scheduleMode ?? "heat";
      if (entry.activeScheduleMode === undefined) {
        entry.activeScheduleMode = zone.activeScheduleMode !== undefined ? zone.activeScheduleMode : (zone.scheduleMode ?? null);
      }
      zone.modes = entry.modes;
      this.bindZoneToStore(zone, entry);
    }
    return zones;
  }

  getSupportedScheduleModes(state) {
    const hvacModes = Array.isArray(state.attributes.hvac_modes) ? state.attributes.hvac_modes : [];
    const supported = ["heat", "cool"].filter((mode) => hvacModes.includes(mode));
    return supported.length ? supported : ["heat", "cool"];
  }

  normalizeScheduleMode(mode, supportedModes) {
    return supportedModes.includes(mode) ? mode : supportedModes[0] ?? "heat";
  }

  normalizeActiveScheduleMode(mode, supportedModes) {
    return supportedModes.includes(mode) ? mode : null;
  }

  getOrCreateSchedules(entityId, state, storedModes = null) {
    const existing = this.scheduleStore.get(entityId)?.modes;
    if (existing) return existing;

    const restored = restoreStoredModes(storedModes);
    if (restored) return restored;

    return this.makeDefaultSchedules(state);
  }

  ensureSchedulesForModes(modes, supportedModes, state) {
    const defaults = this.makeDefaultSchedules(state);
    for (const mode of supportedModes) {
      modes[mode] ??= defaults[mode] ?? defaults.heat;
    }
  }

  makeDefaultSchedules(state) {
    // Number(null) is 0, which would seed an absurd 0° default schedule.
    const baseTemp = Number(state.attributes.temperature ?? NaN);
    const safeHeatTemp = Number.isFinite(baseTemp) && baseTemp > 0
      ? baseTemp
      : this.fromCelsius(20);
    const setback = this.isFahrenheit() ? 4 : 2;
    const floor = this.defaultMinTemp();
    const heatDay = normalizeSetpoints([
      { minute: 0, temp: safeHeatTemp },
      { minute: timeToScheduleMinute("07:00"), temp: safeHeatTemp },
      { minute: timeToScheduleMinute("09:00"), temp: Math.max(floor, safeHeatTemp - setback) },
      { minute: timeToScheduleMinute("14:15"), temp: safeHeatTemp },
      { minute: timeToScheduleMinute("18:30"), temp: Math.max(floor, safeHeatTemp - setback) },
    ]);

    return {
      heat: makeModeSchedule(heatDay),
      cool: makeModeSchedule(makeCoolSetpoints(heatDay, this.temperatureUnit)),
    };
  }

  renderIfReady() {
    if (!this.isConnectedOnce || !this.scheduleView) return;
    // A hass update mid-drag would replace the DOM under the pointer;
    // stopDrag() re-renders when the interaction ends.
    if (this.activeDrag) return;
    // Replacing a focused form control mid-interaction (typing in a setpoint
    // input, open dropdown) loses the user's edit; defer until blur.
    const active = this.root.activeElement?.tagName;
    if (active === "SELECT" || active === "INPUT") {
      this.renderPending = true;
      return;
    }
    this.render();
  }

  render() {
    this.renderPending = false;
    if (!this.zones.length) {
      this.zones = this.adoptZones(createDemoZones());
    }

    if (this.selectedZoneId && !this.findZone(this.selectedZoneId)) {
      this.selectedZoneId = null;
    }

    this.scheduleView.dataset.mode = this.getSelectedScheduleMode();
    this.renderSchedulerStatus();
    this.renderGuard();
    this.renderApplyResult();
    this.renderSetup();

    this.zonesEl.replaceChildren();
    this.zonesEl.hidden = this.showSetup;
    if (this.showSetup) return;

    this.zonesEl.append(this.renderZoneColumnHeaders());

    for (const zone of this.zones) {
      const schedule = this.getModeSchedule(zone);
      const node = this.zoneTemplate.content.firstElementChild.cloneNode(true);
      node.classList.toggle("expanded", zone.id === this.selectedZoneId);
      this.renderZoneName(node.querySelector(".zone-name"), zone);
      node.querySelector(".zone-temp").textContent = temperatureLabel(zone.currentTemp);
      node.querySelector(".zone-mode").textContent = modeLabel(zone.hvacMode);

      if (schedule.dirty) {
        node.querySelector(".zone-mode").append(this.makeDirtyBadge());
      }

      node.classList.toggle("inactive", !zone.activeScheduleMode);
      node.querySelector(".zone-switch-slot").append(this.renderZoneSwitch(zone));
      node.querySelector(".zone-header").append(this.renderZoneActions(zone));
      node.querySelector(".zone-header").addEventListener("click", () => {
        this.requestNavigation(() => {
          this.selectedZoneId = this.selectedZoneId === zone.id ? null : zone.id;
        });
      });

      const body = node.querySelector(".zone-body");
      body.append(this.renderZoneScheduleMode(zone));
      if (zone.entityId) {
        body.append(this.renderZoneStatus(zone));
      }
      body.append(this.renderSchedulePreview(zone));
      for (const day of DAYS) {
        body.append(this.renderDay(zone, day));
      }

      this.zonesEl.append(node);
    }
  }

  renderDay(zone, day) {
    const row = this.dayTemplate.content.firstElementChild.cloneNode(true);
    const isActive = zone.id === this.selectedZoneId && day === this.selectedDay;
    const schedule = this.getModeSchedule(zone);
    const setpoints = schedule.draftWeek[day];
    const savedSetpoints = schedule.savedWeek[day];

    row.classList.toggle("active", isActive);
    row.querySelector(".day-button").textContent = day;
    const selectDay = () => {
      this.requestNavigation(() => {
        this.selectedZoneId = zone.id;
        this.selectedDay = isActive ? null : day;
      });
    };
    row.querySelector(".day-button").addEventListener("click", selectDay);

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "day-chevron";
    chevron.setAttribute("aria-label", `${day} setpoints`);
    chevron.setAttribute("aria-expanded", String(isActive));
    chevron.addEventListener("click", selectDay);
    row.append(chevron);
    row.querySelector(".day-current").textContent = `Current ${temperatureLabel(zone.currentTemp)}`;

    this.renderTicks(row.querySelector(".ticks"));
    this.renderSegments(row.querySelector(".segments"), setpoints, zone.scheduleMode);
    this.renderSavedReference(row, zone, savedSetpoints, setpoints);
    this.renderHandles(row.querySelector(".handles"), zone, day, setpoints);
    this.renderSetpointPanel(row.querySelector(".setpoint-panel"), zone, day, setpoints, savedSetpoints, isActive);

    return row;
  }

  renderSavedReference(row, zone, savedSetpoints, draftSetpoints) {
    const referenceSegmentsEl = row.querySelector(".reference-segments");
    const referenceHandlesEl = row.querySelector(".reference-handles");
    referenceSegmentsEl.replaceChildren();
    referenceHandlesEl.replaceChildren();

    if (!this.getModeSchedule(zone).dirty || setpointsEqual(savedSetpoints, draftSetpoints)) return;

    for (let index = 0; index < savedSetpoints.length; index += 1) {
      const start = savedSetpoints[index].minute;
      const end = savedSetpoints[index + 1]?.minute ?? DAY_LENGTH_MINUTES;
      const segment = document.createElement("div");
      segment.className = "reference-segment";
      segment.style.left = `${minuteToPercent(start)}%`;
      segment.style.width = `${minuteToPercent(end - start)}%`;
      segment.style.setProperty("--reference-color", this.colorForTemp(savedSetpoints[index].temp, zone.scheduleMode));
      referenceSegmentsEl.append(segment);
    }

    savedSetpoints.forEach((point, index) => {
      const marker = document.createElement("span");
      marker.className = "reference-handle";
      marker.style.left = `${minuteToPercent(point.minute)}%`;
      marker.style.setProperty("--reference-color", this.colorForTemp(point.temp, zone.scheduleMode));
      marker.dataset.label = `${index + 1}: ${minutesToTime(scheduleMinuteToClockMinute(point.minute))} · ${point.temp}°`;
      marker.title = `Saved setpoint ${index + 1}: ${minutesToTime(scheduleMinuteToClockMinute(point.minute))}, ${point.temp}°`;
      referenceHandlesEl.append(marker);
    });
  }

  renderTicks(ticksEl) {
    ticksEl.replaceChildren();

    for (let minute = 0; minute <= DAY_LENGTH_MINUTES; minute += 60) {
      const absoluteMinute = scheduleMinuteToClockMinute(minute);
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.style.left = `${minuteToPercent(minute)}%`;

      if (minute % 120 === 0) {
        tick.classList.add("major");
        const label = document.createElement("span");
        label.className = "tick-label";
        label.textContent = minutesToTime(absoluteMinute);
        tick.append(label);
      }

      ticksEl.append(tick);
    }
  }

  renderSegments(segmentsEl, setpoints, mode = "heat") {
    segmentsEl.replaceChildren();
    segmentsEl.style.background = "";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("segments-svg");
    svg.setAttribute("viewBox", "0 0 1440 13");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    for (let index = 0; index < setpoints.length; index += 1) {
      const start = setpoints[index].minute;
      const end = setpoints[index + 1]?.minute ?? DAY_LENGTH_MINUTES;
      const temp = setpoints[index].temp;
      const color = this.colorForTemp(temp, mode);
      const startPercent = minuteToPercent(start);
      const endPercent = minuteToPercent(end);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(start));
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(end - start));
      rect.setAttribute("height", "13");
      rect.setAttribute("fill", color);
      svg.append(rect);

      if (end - start >= 90) {
        const label = document.createElement("span");
        label.className = "segment-label";
        label.style.left = `${(startPercent + endPercent) / 2}%`;
        label.textContent = `${temp}°`;
        segmentsEl.append(label);
      }
    }

    segmentsEl.prepend(svg);
  }

  renderHandles(handlesEl, zone, day, setpoints) {
    handlesEl.replaceChildren();

    setpoints.forEach((point, index) => {
      if (index === 0) return;

      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "handle";
      handle.dataset.index = String(index + 1);
      handle.style.left = `${minuteToPercent(point.minute)}%`;
      handle.style.setProperty("--handle-color", this.colorForTemp(point.temp, zone.scheduleMode));
      handle.setAttribute("aria-label", `${day} setpoint ${index + 1}, ${minutesToTime(scheduleMinuteToClockMinute(point.minute))}`);
      handle.addEventListener("pointerdown", (event) => this.startDrag(event, zone.id, day, index));
      handle.addEventListener("pointerenter", (event) => this.showBubble(event, point.minute));
      handle.addEventListener("pointermove", (event) => this.showBubble(event, point.minute));
      handle.addEventListener("pointerleave", () => this.hideBubble());
      handlesEl.append(handle);
    });
  }

  renderSetpointPanel(panel, zone, day, setpoints, savedSetpoints, isActive) {
    panel.replaceChildren();
    if (!isActive) return;

    setpoints.forEach((point, index) => {
      const editor = document.createElement("div");
      editor.className = "setpoint-editor";

      const label = document.createElement("label");
      label.dataset.setpointLabel = String(index);
      label.textContent = `Setpoint ${index + 1} · ${formatSetpointRange(setpoints, index)}`;

      const step = zone.tempStep ?? 0.5;
      const minTemp = zone.minTemp ?? this.defaultMinTemp();
      const maxTemp = zone.maxTemp ?? this.defaultMaxTemp();
      const applyTemp = (next) => {
        if (!Number.isFinite(next)) return;
        const snapped = Math.round(next / step) * step;
        point.temp = Math.round(clamp(snapped, minTemp, maxTemp) * 10) / 10;
        this.markDirty(zone, zone.scheduleMode);
        this.render();
      };

      const stepper = document.createElement("div");
      stepper.className = "setpoint-stepper";

      const icon = document.createElement("span");
      icon.className = `setpoint-mode-icon ${zone.scheduleMode}`;
      icon.textContent = zone.scheduleMode === "cool" ? "❄️" : "🔥";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "step-button";
      minus.textContent = "−";
      minus.setAttribute("aria-label", `Setpoint ${index + 1} down`);
      minus.addEventListener("click", () => applyTemp(Number(point.temp) - step));

      const input = document.createElement("input");
      input.type = "number";
      input.min = String(minTemp);
      input.max = String(maxTemp);
      input.step = String(step);
      input.value = String(point.temp);
      input.addEventListener("change", () => applyTemp(Number(input.value)));

      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "step-button";
      plus.textContent = "+";
      plus.setAttribute("aria-label", `Setpoint ${index + 1} up`);
      plus.addEventListener("click", () => applyTemp(Number(point.temp) + step));

      stepper.append(icon, minus, input, plus);
      editor.append(label, stepper);
      panel.append(editor);
    });

    panel.append(this.renderCopyActions(zone, day, setpoints, savedSetpoints));
  }

  renderCopyActions(zone, sourceDay, setpoints, savedSetpoints) {
    const wrap = document.createElement("div");
    wrap.className = "copy-actions";

    const targets = DAYS.filter((day) => day !== sourceDay);
    for (const day of targets) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = day;
      label.append(checkbox, day);
      wrap.append(label);
    }

    const workingDays = document.createElement("label");
    const workingCheckbox = document.createElement("input");
    workingCheckbox.type = "checkbox";
    workingDays.append(workingCheckbox, "Working days");
    wrap.append(workingDays);

    const week = document.createElement("label");
    const weekCheckbox = document.createElement("input");
    weekCheckbox.type = "checkbox";
    week.append(weekCheckbox, "Week");
    wrap.append(week);

    workingCheckbox.addEventListener("change", () => {
      weekCheckbox.checked = false;
      for (const checkbox of wrap.querySelectorAll("input[value]")) {
        checkbox.checked = workingCheckbox.checked && ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(checkbox.value);
      }
    });

    weekCheckbox.addEventListener("change", () => {
      workingCheckbox.checked = false;
      for (const checkbox of wrap.querySelectorAll("input[value]")) {
        checkbox.checked = weekCheckbox.checked;
      }
    });

    const actionGroup = document.createElement("div");
    actionGroup.className = "copy-action-buttons";

    const resetDayButton = document.createElement("button");
    resetDayButton.type = "button";
    resetDayButton.textContent = "Reset";
    resetDayButton.disabled = setpointsEqual(setpoints, savedSetpoints);
    resetDayButton.addEventListener("click", () => {
      this.resetZoneDay(zone, zone.scheduleMode, sourceDay);
      this.render();
    });
    actionGroup.append(resetDayButton);

    const saveDayButton = document.createElement("button");
    saveDayButton.type = "button";
    saveDayButton.className = "save-day-button";
    saveDayButton.textContent = "Save";
    saveDayButton.disabled = setpointsEqual(setpoints, savedSetpoints);
    saveDayButton.addEventListener("click", () => {
      this.saveZoneDay(zone, zone.scheduleMode, sourceDay);
      this.render();
    });
    actionGroup.append(saveDayButton);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => {
      const selectedDays = [...wrap.querySelectorAll("input[value]:checked")].map((input) => input.value);
      const schedule = this.getModeSchedule(zone);
      for (const day of selectedDays) {
        schedule.draftWeek[day] = cloneSetpoints(schedule.draftWeek[sourceDay]);
      }
      this.markDirty(zone, zone.scheduleMode);
      this.render();
    });
    actionGroup.append(copyButton);
    wrap.append(actionGroup);

    return wrap;
  }

  startDrag(event, zoneId, day, index) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.activeDrag = {
      zoneId,
      day,
      index,
      mode: this.findZone(zoneId)?.scheduleMode ?? "heat",
      timeline: event.currentTarget.closest(".timeline"),
      handle: event.currentTarget,
    };
    this.onPointerMove(event);
  }

  onPointerMove(event) {
    if (!this.activeDrag) return;

    const zone = this.findZone(this.activeDrag.zoneId);
    const points = this.getModeSchedule(zone, this.activeDrag.mode).draftWeek[this.activeDrag.day];
    const rect = this.activeDrag.timeline.getBoundingClientRect();
    const rawPercent = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const snappedMinute = snapMinute(rawPercent * DAY_LENGTH_MINUTES, SNAP_MINUTES);
    const previous = points[this.activeDrag.index - 1].minute + SNAP_MINUTES;
    const nextPoint = points[this.activeDrag.index + 1];
    const next = nextPoint ? nextPoint.minute - SNAP_MINUTES : DAY_LENGTH_MINUTES - SNAP_MINUTES;

    points[this.activeDrag.index].minute = clamp(snappedMinute, previous, next);
    this.activeDrag.handle.style.left = `${minuteToPercent(points[this.activeDrag.index].minute)}%`;
    this.renderSegments(this.activeDrag.timeline.querySelector(".segments"), points, this.activeDrag.mode);
    this.updateVisibleSetpointRanges(this.activeDrag.timeline.closest(".day-row"), points, this.activeDrag.index);
    this.showBubble(event, points[this.activeDrag.index].minute);
  }

  stopDrag() {
    if (!this.activeDrag) return;

    const zone = this.findZone(this.activeDrag.zoneId);
    const schedule = this.getModeSchedule(zone, this.activeDrag.mode);
    schedule.draftWeek[this.activeDrag.day] = normalizeSetpoints(schedule.draftWeek[this.activeDrag.day]);
    this.markDirty(zone, this.activeDrag.mode);
    this.activeDrag = null;
    this.hideBubble();
    this.render();
  }

  updateVisibleSetpointRanges(row, setpoints, movedIndex) {
    for (const index of [movedIndex - 1, movedIndex]) {
      if (index < 0 || index >= setpoints.length) continue;

      const label = row.querySelector(`[data-setpoint-label="${index}"]`);
      if (label) {
        label.textContent = `Setpoint ${index + 1} · ${formatSetpointRange(setpoints, index)}`;
      }
    }
  }

  renderZoneActions(zone) {
    const actions = document.createElement("span");
    actions.className = "zone-actions";
    actions.addEventListener("click", (event) => event.stopPropagation());

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = `Save ${modeTitle(zone.scheduleMode)}`;
    saveButton.disabled = !this.getModeSchedule(zone).dirty;
    saveButton.addEventListener("click", () => {
      this.saveZoneMode(zone, zone.scheduleMode);
      this.render();
    });

    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.textContent = "Discard";
    discardButton.disabled = !this.getModeSchedule(zone).dirty;
    discardButton.addEventListener("click", () => {
      this.discardZoneMode(zone, zone.scheduleMode);
      this.render();
    });

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "icon-button";
    editButton.textContent = "✏️";
    editButton.title = `Edit ${zone.name} schedule`;
    editButton.setAttribute("aria-label", `Edit ${zone.name} schedule`);
    editButton.addEventListener("click", () => {
      this.requestNavigation(() => {
        this.selectedZoneId = zone.id;
      });
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "icon-button icon-button-danger";
    deleteButton.textContent = "🗑";
    deleteButton.title = `Delete ${zone.name} zone`;
    deleteButton.setAttribute("aria-label", `Delete ${zone.name} zone`);
    deleteButton.addEventListener("click", () => this.deleteZone(zone));

    actions.append(saveButton, discardButton, editButton, deleteButton);
    return actions;
  }

  zonesAsClimates() {
    return this.zones
      .filter((zone) => zone.entityId)
      .flatMap((zone) => (zone.entityIds ?? [zone.entityId]).map((entityId) => ({
        entity: entityId,
        name: zone.name,
      })));
  }

  async deleteZone(zone) {
    const confirmed = window.confirm(
      `Delete zone "${zone.name}" and its schedules? The thermostat itself is not affected.`,
    );
    if (!confirmed) return;

    const zoneEntities = zone.entityIds ?? [zone.entityId];
    const remaining = (this.serverClimates ?? this.zonesAsClimates())
      .filter((entry) => !zoneEntities.includes(entry.entity));

    if (this._hass?.callWS) {
      try {
        await this._hass.callWS({
          type: "nimbus_climate_scheduler/set_climates",
          climates: remaining,
        });
      } catch {
        // Backend unavailable; apply the removal client-side anyway.
      }
    }

    for (const entityId of zoneEntities) {
      this.scheduleStore.delete(entityId);
    }
    if (this.selectedZoneId === zone.id) {
      this.selectedZoneId = null;
    }

    if (remaining.length) {
      this.serverClimates = remaining;
      this.zonesSignature = null;
      this.syncZonesFromHass();
    } else {
      // Last zone removed: reopen the setup wizard instead of falling back
      // to auto-discovery of every climate entity.
      this.serverClimates = null;
      this.zones = [];
      this.showSetup = true;
      this.setupDraft = null;
    }
    this.render();
  }

  renderZoneScheduleMode(zone) {
    const row = document.createElement("div");
    row.className = "zone-schedule-mode";

    const label = document.createElement("label");
    label.textContent = "Schedule mode:";

    const pills = document.createElement("div");
    pills.className = "mode-pills";
    pills.setAttribute("role", "group");
    pills.setAttribute("aria-label", `${zone.name} schedule mode`);

    for (const mode of zone.supportedScheduleModes ?? ["heat", "cool"]) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `mode-pill mode-pill-${mode}`;
      pill.textContent = modeLabel(mode);
      pill.classList.toggle("active", mode === zone.scheduleMode);
      pill.setAttribute("aria-pressed", String(mode === zone.scheduleMode));
      pill.addEventListener("click", () => {
        if (mode === zone.scheduleMode) return;
        this.setZoneScheduleMode(zone, mode);
        this.render();
      });
      pills.append(pill);
    }

    row.append(label, pills);
    return row;
  }

  renderSchedulePreview(zone) {
    const plan = buildZoneApplyPlan(zone, this.getActiveModeSchedule(zone)?.savedWeek);
    const row = document.createElement("div");
    row.className = "schedule-preview";

    const label = document.createElement("span");
    label.className = "schedule-preview-label";
    label.textContent = "Schedule now";

    const value = document.createElement("span");
    value.className = "schedule-preview-value";
    value.textContent = plan
      ? plan.previewText
      : "-";

    const state = document.createElement("span");
    state.className = "schedule-preview-state";
    state.textContent = plan?.stateLabel ?? "unavailable";

    row.append(label, value, state);
    return row;
  }

  buildApplyPlans(at = new Date()) {
    return this.zones
      .map((zone) => buildZoneApplyPlan(zone, this.getActiveModeSchedule(zone)?.savedWeek, at))
      .filter(Boolean);
  }


  renderApplyResult() {
    this.applyResult.replaceChildren();
    if (!this.applyResultData) {
      this.applyResult.hidden = true;
      return;
    }

    const { applied, skippedOff, skippedMode, failed } = this.applyResultData;
    const summary = document.createElement("span");
    summary.textContent = `Applied ${applied.length} · Skipped ${skippedOff.length} off${skippedMode.length ? ` · Skipped ${skippedMode.length} mode` : ""} · Failed ${failed.length}`;
    this.applyResult.append(summary);

    if (failed.length) {
      const details = document.createElement("span");
      details.className = "apply-result-details";
      details.textContent = failed.map((item) => item.entityId).join(", ");
      this.applyResult.append(details);
    }

    this.applyResult.hidden = false;
  }

  renderSchedulerStatus() {
    if (!this.schedulerStatus) return;

    if (this.backendSyncComplete) {
      this.schedulerStatus.textContent = "Backend scheduler on";
      return;
    }

    const lastRun = this.lastSchedulerRun
      ? `Last run ${formatClockTime(this.lastSchedulerRun)}`
      : "Waiting";
    this.schedulerStatus.textContent = `${this.schedulerRunning ? "Fallback running" : "Frontend fallback"} · ${lastRun}`;
  }

  async runSchedulerTick() {
    if (this.backendSyncComplete || this.applying || this.schedulerRunning || !this._hass?.callService) return;

    const plans = this.buildApplyPlans()
      .map((plan) => this.withNeedsApply(plan))
      .filter((plan) => plan.needsApply);

    this.schedulerRunning = true;
    this.renderIfReady();

    const result = await this.applyPlans(plans);

    this.lastSchedulerRun = new Date();
    this.schedulerRunning = false;
    if (result.applied.length || result.failed.length) {
      this.applyResultData = result;
    }
    this.renderIfReady();
  }


  async applyPlans(plans) {
    const result = {
      applied: [],
      skippedOff: plans.filter((plan) => plan.action === "off" && !plan.canApply),
      skippedMode: [],
      failed: [],
    };

    if (!this._hass?.callService) {
      result.failed.push(...plans.filter((plan) => plan.canApply).map((plan) => ({
        ...plan,
        error: "Home Assistant service API unavailable",
      })));
      return result;
    }

    for (const plan of plans) {
      if (!plan.canApply) continue;

      try {
        await this.applyPlan(plan);
        result.applied.push(plan);
      } catch (error) {
        result.failed.push({
          ...plan,
          error: error?.message ?? String(error),
        });
      }
    }

    return result;
  }

  withNeedsApply(plan) {
    if (plan.action === "off") {
      return {
        ...plan,
        needsApply: plan.canApply,
      };
    }

    const targetMatches = Number(plan.currentTargetTemp) === Number(plan.targetTemp);
    return {
      ...plan,
      needsApply: plan.hvacMode !== plan.mode || !targetMatches,
    };
  }

  async applyPlan(plan) {
    const entityIds = plan.entityIds ?? [plan.entityId];

    if (plan.action === "off") {
      await this._hass.callService("climate", "set_hvac_mode", {
        entity_id: entityIds,
        hvac_mode: "off",
      });
      return;
    }

    await this._hass.callService("climate", "set_hvac_mode", {
      entity_id: entityIds,
      hvac_mode: plan.mode,
    });

    if (plan.hvacMode !== plan.mode) {
      // Let the device switch modes before sending the setpoint, otherwise
      // it can land on the old mode and get dropped.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await this._hass.callService("climate", "set_temperature", {
      entity_id: entityIds,
      temperature: plan.targetTemp,
    });
  }

  setZoneScheduleMode(zone, mode) {
    const entry = this.scheduleStore.get(zone.id);
    if (entry) {
      entry.scheduleMode = mode;
    }
    this.persistZone(zone);
  }

  setZoneActiveScheduleMode(zone, mode) {
    const entry = this.scheduleStore.get(zone.id);
    if (entry) {
      entry.activeScheduleMode = this.normalizeActiveScheduleMode(mode, zone.supportedScheduleModes ?? ["heat", "cool"]);
    }
    this.persistZone(zone);
  }

  renderZoneSwitch(zone) {
    const active = zone.activeScheduleMode === zone.scheduleMode;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zone-toggle";
    button.classList.toggle("active", active);
    button.disabled = this.applying;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${zone.name} ${modeLabel(zone.scheduleMode)} schedule ${active ? "on" : "off"}`);
    button.title = active
      ? `${modeLabel(zone.scheduleMode)} schedule active`
      : `Enable ${modeLabel(zone.scheduleMode)} schedule`;
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (this.applying) return;
      const enabling = !active;
      this.setZoneActiveScheduleMode(zone, enabling ? zone.scheduleMode : null);
      if (enabling) {
        this.selectedZoneId = zone.id;
      }

      // Enabling goes through the backend tick (single, ordered apply);
      // turning off and the no-backend fallback keep the direct call.
      if (enabling && this.backendSyncComplete && this._hass?.callWS) {
        await this.saveAndApply(zone);
        return;
      }

      const plan = buildZoneApplyPlan(zone, this.getActiveModeSchedule(zone)?.savedWeek);
      this.applying = true;
      this.applyResultData = null;
      this.renderIfReady();

      const result = await this.applyPlans(plan ? [plan] : []);

      this.applying = false;
      this.applyResultData = result;
      this.renderIfReady();
    });
    return button;
  }

  makeDirtyBadge() {
    const badge = document.createElement("span");
    badge.className = "dirty-badge";
    badge.textContent = "Unsaved";
    return badge;
  }

  markDirty(zone, mode = zone.scheduleMode) {
    mode = mode ?? zone.scheduleMode;
    const schedule = this.getModeSchedule(zone, mode);
    schedule.dirty = !weeksEqual(schedule.savedWeek, schedule.draftWeek);
    this.persistZone(zone);
  }

  requestNavigation(applyNavigation) {
    const zone = this.findZone(this.selectedZoneId);
    const schedule = zone ? this.getModeSchedule(zone) : null;

    if (!schedule?.dirty) {
      applyNavigation();
      this.pendingNavigation = null;
      this.render();
      return;
    }

    this.pendingNavigation = {
      zoneId: zone.id,
      mode: zone.scheduleMode,
      apply: applyNavigation,
    };
    this.render();
  }

  renderGuard() {
    this.guardBar.replaceChildren();

    if (!this.pendingNavigation) {
      this.guardBar.hidden = true;
      return;
    }

    const zone = this.findZone(this.pendingNavigation.zoneId);
    const message = document.createElement("span");
    message.textContent = `${zone?.name ?? "This zone"} has unsaved ${modeTitle(this.pendingNavigation.mode)} changes.`;

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", () => this.resolveGuard("save"));

    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.textContent = "Discard";
    discardButton.addEventListener("click", () => this.resolveGuard("discard"));

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => this.resolveGuard("cancel"));

    this.guardBar.append(message, saveButton, discardButton, cancelButton);
    this.guardBar.hidden = false;
  }

  resolveGuard(action) {
    if (!this.pendingNavigation) return;

    const pending = this.pendingNavigation;
    const zone = this.findZone(pending.zoneId);

    if (action === "save" && zone) {
      this.saveZoneMode(zone, pending.mode);
    }

    if (action === "discard" && zone) {
      this.discardZoneMode(zone, pending.mode);
    }

    this.pendingNavigation = null;

    if (action !== "cancel") {
      pending.apply();
    }

    this.render();
  }

  saveZoneMode(zone, mode) {
    const schedule = this.getModeSchedule(zone, mode);
    schedule.savedWeek = cloneWeek(schedule.draftWeek);
    schedule.dirty = false;
    this.persistZone(zone);
    this.saveAndApply(zone);
  }

  saveZoneDay(zone, mode, day) {
    const schedule = this.getModeSchedule(zone, mode);
    schedule.savedWeek[day] = cloneSetpoints(schedule.draftWeek[day]);
    schedule.dirty = !weeksEqual(schedule.savedWeek, schedule.draftWeek);
    this.persistZone(zone);
    this.saveAndApply(zone);
  }

  async saveAndApply(zone) {
    // Saving pushes the schedule to the device right away through the
    // backend tick — no separate "Apply" step needed.
    if (!this.backendSyncComplete || !this._hass?.callWS) return;

    this.applying = true;
    this.applyResultData = null;
    this.renderIfReady();

    try {
      // Make sure the latest schedule reached the store before the tick reads it.
      await this.saveZoneToBackend(zone).catch(() => undefined);
      const result = await this._hass.callWS({ type: "nimbus_climate_scheduler/apply_now" });
      this.applyResultData = {
        applied: (result?.applied ?? []).map((entityId) => ({ entityId })),
        skippedOff: [],
        skippedMode: [],
        failed: [],
      };
    } catch (error) {
      this.applyResultData = {
        applied: [],
        skippedOff: [],
        skippedMode: [],
        failed: [{ entityId: zone?.name ?? "schedule", error: error?.message ?? String(error) }],
      };
    }

    this.applying = false;
    this.render();
  }

  resetZoneDay(zone, mode, day) {
    const schedule = this.getModeSchedule(zone, mode);
    schedule.draftWeek[day] = cloneSetpoints(schedule.savedWeek[day]);
    schedule.dirty = !weeksEqual(schedule.savedWeek, schedule.draftWeek);
    this.persistZone(zone);
  }

  discardZoneMode(zone, mode) {
    const schedule = this.getModeSchedule(zone, mode);
    schedule.draftWeek = cloneWeek(schedule.savedWeek);
    schedule.dirty = false;
    this.persistZone(zone);
  }

  persistZone(zone) {
    if (!zone.entityId) return;
    saveStoredEntitySchedule(zone.entityId, {
      scheduleMode: zone.scheduleMode,
      activeScheduleMode: zone.activeScheduleMode,
      modes: zone.modes,
    });
    this.saveZoneToBackend(zone).catch(() => undefined);
  }

  showBubble(event, scheduleMinute) {
    if (!this.timeBubble) {
      this.timeBubble = document.createElement("div");
      this.timeBubble.className = "time-bubble";
      document.body.append(this.timeBubble);
    }

    this.timeBubble.textContent = minutesToTime(scheduleMinuteToClockMinute(scheduleMinute));
    this.timeBubble.style.left = `${event.clientX + 12}px`;
    this.timeBubble.style.top = `${event.clientY - 34}px`;
  }

  hideBubble() {
    this.timeBubble?.remove();
    this.timeBubble = null;
  }

  findZone(zoneId) {
    return this.zones.find((zone) => zone.id === zoneId);
  }

  getModeSchedule(zone, mode = zone.scheduleMode) {
    mode = mode ?? zone.scheduleMode;
    return zone.modes[mode];
  }

  getActiveModeSchedule(zone) {
    return zone.activeScheduleMode ? this.getModeSchedule(zone, zone.activeScheduleMode) : null;
  }

  isFahrenheit() {
    return this.temperatureUnit === "°F";
  }

  toCelsius(temp) {
    return this.isFahrenheit() ? ((temp - 32) * 5) / 9 : temp;
  }

  fromCelsius(temp) {
    return this.isFahrenheit() ? (temp * 9) / 5 + 32 : temp;
  }

  defaultMinTemp() {
    return this.isFahrenheit() ? 41 : 5;
  }

  defaultMaxTemp() {
    return this.isFahrenheit() ? 95 : 35;
  }

  tempClass(temp, mode = "heat") {
    const celsius = this.toCelsius(temp);
    if (mode === "cool") {
      if (celsius <= 24) return "cool";
      if (celsius >= 27) return "hot";
      if (celsius >= 25.5) return "warm";
      return "";
    }

    if (celsius <= 18) return "cool";
    if (celsius >= 22) return "hot";
    if (celsius >= 20.5) return "warm";
    return "";
  }

  colorForTemp(temp, mode = "heat") {
    mode = mode ?? "heat";
    // Band thresholds are defined in °C; convert the displayed value first
    // so Fahrenheit installs get the same color semantics.
    const celsius = this.toCelsius(temp);
    if (mode === "cool") {
      if (celsius <= 24) return "#52dce9";
      if (celsius >= 27) return "#f3d24e";
      if (celsius >= 25.5) return "#9afb3b";
      return "#6df338";
    }

    if (celsius <= 18) return "#52dce9";
    if (celsius >= 22) return "#f3d24e";
    if (celsius >= 20.5) return "#9afb3b";
    return "#6df338";
  }

  getSelectedScheduleMode() {
    return this.findZone(this.selectedZoneId)?.scheduleMode ?? "heat";
  }

}

function createDemoZones() {
  return [
    makeZone("hall", "Hall", 20, [
      ["05:00", 20],
      ["09:00", 21],
      ["13:00", 20],
      ["22:00", 18],
    ]),
    makeZone("dining", "Dining Room", 20, [
      ["05:00", 20],
      ["09:00", 21],
      ["13:00", 20],
      ["22:00", 18],
    ]),
    makeZone("kitchen", "Kitchen", 21, [
      ["05:00", 18],
      ["07:00", 21],
      ["09:00", 18],
      ["14:15", 21],
      ["18:30", 18],
    ]),
    makeZone("nursery", "Nursery", 21, [
      ["05:00", 21],
      ["11:00", 21],
      ["19:00", 21],
      ["23:00", 21],
    ]),
    makeZone("bedroom", "Bedroom", 18, [
      ["05:00", 20],
      ["07:00", 18],
      ["15:45", 18],
      ["18:15", 19],
      ["22:00", 20],
    ]),
  ];
}

function makeZone(id, name, currentTemp, setpoints) {
  const heatDay = normalizeSetpoints(setpoints.map(([time, temp]) => ({
    minute: timeToScheduleMinute(time),
    temp,
  })));
  const coolDay = makeCoolSetpoints(heatDay);

  return {
    id,
    name,
    currentTemp,
    scheduleMode: "heat",
    activeScheduleMode: "heat",
    supportedScheduleModes: ["heat", "cool"],
    hvacMode: "heat",
    modes: {
      heat: makeModeSchedule(heatDay),
      cool: makeModeSchedule(coolDay),
    },
  };
}

function makeModeSchedule(baseDay) {
  const week = Object.fromEntries(DAYS.map((day) => [day, cloneSetpoints(baseDay)]));
  return {
    savedWeek: cloneWeek(week),
    draftWeek: cloneWeek(week),
    dirty: false,
  };
}

function loadStoredEntitySchedule(entityId) {
  try {
    const raw = localStorage.getItem(storageKey(entityId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredEntitySchedule(entityId, data) {
  try {
    localStorage.setItem(storageKey(entityId), JSON.stringify({
      ...serializeScheduleData(data),
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Storage can be unavailable in private browsing or full quota situations.
  }
}

function serializeZoneSchedule(zone) {
  return serializeScheduleData({
    scheduleMode: zone.scheduleMode,
    activeScheduleMode: zone.activeScheduleMode,
    modes: zone.modes,
  });
}

function serializeScheduleData(data) {
  return {
    scheduleMode: data.scheduleMode,
    activeScheduleMode: data.activeScheduleMode,
    modes: serializeModes(data.modes),
  };
}

function restoreStoredModes(modes) {
  if (!modes || typeof modes !== "object") return null;

  const restored = {};
  for (const mode of Object.keys(modes)) {
    const schedule = modes[mode];
    if (!schedule) continue;

    const savedWeek = restoreWeek(schedule.savedWeek);
    const draftWeek = restoreWeek(schedule.draftWeek);
    if (!savedWeek || !draftWeek) continue;

    restored[mode] = {
      savedWeek,
      draftWeek,
      dirty: !weeksEqual(savedWeek, draftWeek),
    };
  }

  return Object.keys(restored).length ? restored : null;
}

function restoreWeek(week) {
  if (!week || typeof week !== "object") return null;

  const restored = {};
  for (const day of DAYS) {
    const setpoints = restoreSetpoints(week[day]);
    if (!setpoints) return null;
    restored[day] = setpoints;
  }

  return restored;
}

function restoreSetpoints(setpoints) {
  if (!Array.isArray(setpoints) || !setpoints.length) return null;

  const restored = setpoints
    .map((point) => ({
      minute: Number(point.minute),
      temp: Number(point.temp),
    }))
    .filter((point) => (
      Number.isFinite(point.minute)
      && Number.isFinite(point.temp)
      && point.minute >= 0
      && point.minute < DAY_LENGTH_MINUTES
    ));

  if (!restored.length) return null;
  return normalizeSetpoints(restored);
}

function serializeModes(modes) {
  return Object.fromEntries(Object.entries(modes).map(([mode, schedule]) => [
    mode,
    {
      savedWeek: cloneWeek(schedule.savedWeek),
      draftWeek: cloneWeek(schedule.draftWeek),
    },
  ]));
}

function storageKey(entityId) {
  return `${STORAGE_PREFIX}:${entityId}`;
}

function makeCoolSetpoints(heatSetpoints, unit = "°C") {
  return heatSetpoints.map((point) => ({
    minute: point.minute,
    temp: heatTempToCoolTemp(point.temp, unit),
  }));
}

function buildZoneApplyPlan(zone, week, at = new Date()) {
  if (!zone.activeScheduleMode) {
    const thermostatOn = isZoneOn(zone);
    return {
      entityId: zone.entityId ?? zone.id,
      entityIds: zone.entityIds ?? [zone.entityId ?? zone.id],
      zoneId: zone.id,
      mode: null,
      hvacMode: zone.hvacMode,
      currentTargetTemp: zone.targetTemp,
      action: "off",
      thermostatOn,
      modeMatches: !thermostatOn,
      canApply: thermostatOn,
      stateLabel: thermostatOn ? "will turn off" : "thermostat off",
      applyLabel: thermostatOn ? "would turn off" : "skipped off",
      previewText: "No active schedule",
      targetTemp: null,
      nextTemp: null,
      nextTime: "-",
      day: dayKeyFromDate(at),
    };
  }

  const schedule = getSchedulePointForTime(week, at);
  if (!schedule) return null;
  const thermostatOn = isZoneOn(zone);
  const modeMatches = scheduleModeMatchesHvac(zone);
  const willSwitchMode = thermostatOn && !modeMatches;
  const actionText = `${modeTitle(zone.activeScheduleMode)} target ${schedule.current.temp}° until ${schedule.nextTime}`;

  return {
    entityId: zone.entityId ?? zone.id,
    entityIds: zone.entityIds ?? [zone.entityId ?? zone.id],
    zoneId: zone.id,
    mode: zone.activeScheduleMode,
    hvacMode: zone.hvacMode,
    currentTargetTemp: zone.targetTemp,
    action: "set_temperature",
    thermostatOn,
    modeMatches,
    canApply: true,
    stateLabel: thermostatOn ? modeMatchLabel(zone, modeMatches) : "will turn on",
    applyLabel: willSwitchMode ? "would switch mode" : "would apply",
    previewText: actionText,
    targetTemp: schedule.current.temp,
    nextTemp: schedule.next.temp,
    nextTime: schedule.nextTime,
    day: schedule.day,
  };
}

function getSchedulePointForTime(week, at = new Date()) {
  const day = dayKeyFromDate(at);
  const setpoints = week?.[day];
  if (!Array.isArray(setpoints) || !setpoints.length) return null;

  const scheduleMinute = clockMinuteToScheduleMinute((at.getHours() * 60) + at.getMinutes());
  const currentIndex = findActiveSetpointIndex(setpoints, scheduleMinute);
  const current = setpoints[currentIndex];
  const next = setpoints[currentIndex + 1] ?? setpoints[0];
  const nextTime = minutesToTime(scheduleMinuteToClockMinute(next.minute));

  return {
    day,
    current,
    next,
    nextTime,
  };
}

function findActiveSetpointIndex(setpoints, scheduleMinute) {
  let activeIndex = 0;
  for (let index = 0; index < setpoints.length; index += 1) {
    if (setpoints[index].minute <= scheduleMinute) {
      activeIndex = index;
    }
  }
  return activeIndex;
}

function dayKeyFromDate(date) {
  let index = (date.getDay() + 6) % 7;
  // The schedule day runs 05:00 → 05:00, so early-morning hours still belong
  // to the previous day's row.
  if ((date.getHours() * 60) + date.getMinutes() < DAY_START_MINUTES) {
    index = (index + 6) % 7;
  }
  return DAYS[index];
}

function heatTempToCoolTemp(temp, unit = "°C") {
  // The comfort mapping is defined in °C; convert in and out for °F installs.
  const celsius = unit === "°F" ? ((temp - 32) * 5) / 9 : temp;
  let coolCelsius;
  if (celsius <= 18) coolCelsius = 27;
  else if (celsius >= 22) coolCelsius = 24;
  else if (celsius >= 20.5) coolCelsius = 25;
  else coolCelsius = 26;
  const cool = unit === "°F" ? (coolCelsius * 9) / 5 + 32 : coolCelsius;
  return Math.round(cool * 2) / 2;
}

function modeLabel(mode) {
  if (mode === "off") return "Off";
  if (mode === "heat") return "Heating";
  if (mode === "cool") return "Cooling";
  if (mode === "heat_cool") return "Auto";
  if (mode === "unavailable") return "Unavailable";
  if (mode === "unknown") return "Unknown";
  return titleize(String(mode ?? "-"));
}

function modeTitle(mode) {
  if (mode === "off") return "Off";
  return mode === "cool" ? "Cool" : "Heat";
}

function formatClockTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isZoneOn(zone) {
  return !["off", "unavailable", "unknown"].includes(zone.hvacMode);
}

function scheduleModeMatchesHvac(zone) {
  return zone.hvacMode === zone.activeScheduleMode;
}

function modeMatchLabel(zone, matches) {
  return matches ? "active" : `${modeLabel(zone.hvacMode)} active`;
}

function temperatureLabel(value) {
  if (value === null || value === undefined || value === "-") return "-";
  return `${value}°`;
}

function formatTemperature(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return Math.round(number * 10) / 10;
}

function coerceFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function titleize(value) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cloneWeek(week) {
  return Object.fromEntries(DAYS.map((day) => [day, cloneSetpoints(week[day])]));
}

function cloneSetpoints(setpoints) {
  return setpoints.map((point) => ({ ...point }));
}

function setpointsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function weeksEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeSetpoints(setpoints) {
  const sorted = cloneSetpoints(setpoints).sort((a, b) => a.minute - b.minute);
  sorted[0].minute = 0;
  return sorted;
}

function timeToScheduleMinute(time) {
  const [hours, minutes] = time.split(":").map(Number);
  const clockMinute = hours * 60 + minutes;
  return (clockMinute - DAY_START_MINUTES + DAY_LENGTH_MINUTES) % DAY_LENGTH_MINUTES;
}

function scheduleMinuteToClockMinute(scheduleMinute) {
  return (DAY_START_MINUTES + scheduleMinute) % DAY_LENGTH_MINUTES;
}

function clockMinuteToScheduleMinute(clockMinute) {
  return (clockMinute - DAY_START_MINUTES + DAY_LENGTH_MINUTES) % DAY_LENGTH_MINUTES;
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatSetpointRange(setpoints, index) {
  const start = scheduleMinuteToClockMinute(setpoints[index].minute);
  const endMinute = setpoints[index + 1]?.minute ?? DAY_LENGTH_MINUTES;
  const end = scheduleMinuteToClockMinute(endMinute);
  return `${minutesToTime(start)} - ${minutesToTime(end)}`;
}

function minuteToPercent(minute) {
  return (minute / DAY_LENGTH_MINUTES) * 100;
}

function snapMinute(minute, snap) {
  return Math.round(minute / snap) * snap;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

customElements.define("nimbus-climate-scheduler-panel", NimbusClimateSchedulerPanel);
