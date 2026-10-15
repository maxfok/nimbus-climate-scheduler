const DAY_START_MINUTES = 5 * 60;
const DAY_LENGTH_MINUTES = 24 * 60;
const SNAP_MINUTES = 15;
const SCHEDULER_TICK_MS = 30 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_PREFIX = "nimbus-climate-scheduler:v1";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Celsius fallbacks also allow the panel to display pre-settings installations.
const DEFAULT_COLOR_THRESHOLDS = {
  heat: { cold: 18, warm: 20.5, hot: 22 },
  cool: { cold: 24, warm: 25.5, hot: 27 },
};
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

    <nav class="panel-tabs" role="tablist" aria-label="Nimbus Climate Scheduler">
      <button id="schedulesTab" role="tab" type="button" aria-controls="zones" aria-selected="true">Schedules</button>
      <button id="settingsTab" role="tab" type="button" aria-controls="settings" aria-selected="false" tabindex="-1">Settings</button>
    </nav>
    <section id="guardBar" class="guard-bar" hidden aria-live="polite"></section>
    <section id="setupWizard" class="setup-wizard" hidden></section>
    <section id="applyResult" class="apply-result" hidden aria-live="polite"></section>
    <section id="zones" class="zones" role="tabpanel" aria-labelledby="schedulesTab"></section>
    <section id="settings" class="settings" role="tabpanel" aria-labelledby="settingsTab" hidden></section>
  </main>

  <template id="zoneTemplate">
    <article class="zone">
      <div class="zone-header">
        <span class="thermo-icon" aria-hidden="true"></span>
        <button class="zone-name" type="button"></button>
        <span class="zone-temp"></span>
        <span class="zone-mode"></span>
        <span class="zone-switch-slot"></span>
      </div>
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
    this.groupDays = true;
    this.daySelection = null;
    this.activeDrag = null;
    this.timeBubble = null;
    this.pendingNavigation = null;
    this.renderPending = false;
    this.temperatureUnit = "°C";
    this.activeTab = "schedules";
    this.colorThresholds = structuredClone(DEFAULT_COLOR_THRESHOLDS);
    this.settingsRevision = 0;
    this.settingsDraft = null;
    this.serverClimates = null;
    this.showSetup = false;
    this.setupDraft = null;
    this.membersDraft = null;
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
    this.onNarrowMediaChange = this.updateNarrow.bind(this);
  }

  set hass(hass) {
    this._hass = hass;
    this.temperatureUnit = hass?.config?.unit_system?.temperature ?? "°C";
    this.updateMenuButton();
    this.ensureBackendSync();
    this.ensureBackendSubscription();
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
    if (!this.isConnectedOnce) {
      this.isConnectedOnce = true;
      this.root.innerHTML = PANEL_HTML;
      this.cacheElements();
      this.setupEvents();
    }
    this.setupConnectionEvents();
    this.syncZonesFromHass();
    this.ensureBackendSync();
    this.ensureBackendSubscription();
    this.startScheduler();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.stopDrag);
    window.removeEventListener("pointercancel", this.stopDrag);
    this.narrowMedia?.removeEventListener("change", this.onNarrowMediaChange);
    window.clearTimeout(this._backendRetryTimer);
    this._backendUnsubscribe?.();
    this._backendUnsubscribe = null;
    this.backendSyncStarted = false;
    this.stopScheduler();
    this.hideBubble();
  }

  cacheElements() {
    this.scheduleView = this.root.querySelector("#scheduleView");
    this.zonesEl = this.root.querySelector("#zones");
    this.settingsEl = this.root.querySelector("#settings");
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
    const tabs = [...this.root.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => this.requestNavigation(() => {
        this.activeTab = index === 0 ? "schedules" : "settings";
        if (this.activeTab === "settings") {
          this.settingsDraft = structuredClone(this.colorThresholds);
          this.settingsBaseRevision = this.settingsRevision;
          this.settingsMessage = null;
        }
      }));
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs[1 - index];
        next.focus();
        next.click();
      });
    });
    this.setupButton.addEventListener("click", () => this.openSetup());
    this.menuButton.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });

    // Flush a render deferred while a form control was focused.
    this.root.addEventListener("focusout", () => {
      queueMicrotask(() => {
        const active = this.root.activeElement?.tagName;
        if (this.renderPending && !this.activeDrag && active !== "SELECT" && active !== "INPUT") {
          this.render();
        }
        this.flushBackendSync();
      });
    });

    this.narrowMedia = window.matchMedia("(max-width: 760px)");
  }

  setupConnectionEvents() {
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.stopDrag);
    window.addEventListener("pointercancel", this.stopDrag);
    this.narrowMedia?.addEventListener("change", this.onNarrowMediaChange);
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
    if (!this._hass?.states) return false;
    if (!climateConfigs.length) {
      const changed = this.zones.length > 0;
      this.zones = [];
      return changed;
    }

    // Entities sharing a zone name form one zone with a shared schedule.
    const groups = new Map();
    for (const config of climateConfigs) {
      const groupKey = config.zone_id ?? config.name ?? config.entity;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(config);
    }

    const nextZones = [...groups.entries()]
      .map(([, configs]) => this.makeZoneFromClimate(configs[0], {
        name: configs[0].name ?? this._hass.states[configs[0].entity]?.attributes.friendly_name ?? configs[0].entity,
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

  async ensureBackendSubscription() {
    if (!this.isConnected || !this._hass?.connection?.subscribeMessage || this._backendUnsubscribe || this._subscribing) return;
    this._subscribing = true;
    try {
      const unsubscribe = await this._hass.connection.subscribeMessage(
        () => this.syncBackendSchedules(), { type: "nimbus_climate_scheduler/subscribe" },
      );
      if (this.isConnected) this._backendUnsubscribe = unsubscribe;
      else unsubscribe();
    } catch {
      // Older backends do not expose subscriptions. The next HA update retries.
    } finally {
      this._subscribing = false;
    }
  }

  isEditingSchedule() {
    return Boolean(this.activeDrag || this.root.activeElement?.matches(".setpoint-editor input"));
  }

  flushBackendSync() {
    if (this._syncQueued && !this.applying && !this._syncing && !this.isEditingSchedule()) {
      this._syncQueued = false;
      this.syncBackendSchedules();
    }
  }

  async syncBackendSchedules() {
    if (this.applying || this._syncing || this.isEditingSchedule()) {
      this._syncQueued = true;
      return;
    }
    this._syncing = true;
    try {
      const result = await this._hass.callWS({ type: "nimbus_climate_scheduler/get_zones" });
      if (this.applying || this.isEditingSchedule()) {
        this._syncQueued = true;
        return;
      }
      this.colorThresholds = result?.settings?.color_thresholds ?? structuredClone(DEFAULT_COLOR_THRESHOLDS);
      this.settingsRevision = result?.settings_revision ?? 0;
      this.climatesRevision = result?.climates_revision ?? 0;
      const zones = result?.zones ?? {};
      this.serverClimates = Array.isArray(result?.climates)
        ? result.climates
        : null;
      let loaded = false;

      for (const [entityId, data] of Object.entries(zones)) {
        const zone = this.findZone(entityId);
        const supportedModes = zone?.supportedScheduleModes ?? ["heat", "cool"];
        const modes = restoreStoredModes(data?.modes);
        if (!modes) continue;

        const entry = this.getOrCreateStoreEntry(entityId);
        // Preserve local edits when a switch or automation updates controls.
        // Saving a stale draft is rejected using its original revision.
        const dirty = Object.values(entry.modes ?? {}).some((schedule) => schedule.dirty);
        if (!dirty || entry.revision === undefined) {
          const cached = restoreStoredModes(loadStoredEntitySchedule(entityId)?.modes);
          for (const [mode, schedule] of Object.entries(modes)) {
            if (cached?.[mode] && weeksEqual(cached[mode].savedWeek, schedule.savedWeek)) {
              modes[mode] = cached[mode];
            }
          }
          entry.modes = modes;
          entry.revision = data.revision ?? 0;
        }
        entry.scheduleMode ??= this.normalizeScheduleMode(data.scheduleMode, supportedModes);
        entry.activeScheduleMode = this.normalizeActiveScheduleMode(data.activeScheduleMode, ["heat", "cool"]);
        entry.resumeScheduleMode = data.resumeScheduleMode ?? data.activeScheduleMode ?? data.scheduleMode;
        loaded = true;
      }

      this.backendSyncComplete = true;

      // First run: nothing stored and nothing configured — open the setup wizard.
      const yamlClimates = this._panel?.config?.climates ?? this._panel?.config?.zones ?? [];
      if (!Object.keys(zones).length && !this.serverClimates?.length && !yamlClimates.length) {
        this.showSetup = true;
        this.renderIfReady();
        return;
      }

      if (loaded || this.serverClimates) {
        this.zonesSignature = null;
        this.syncZonesFromHass();
        this.renderIfReady();
      }
      // Only initialize new zones. Opening a panel must never write cached
      // controls or schedules over changes made by an automation.
      for (const zone of this.zones) {
        if (!zones[zone.entityId]) await this.saveZoneToBackend(zone);
      }
    } catch {
      this.backendSyncComplete = false;
      // Don't get stuck in the frontend fallback forever — allow a retry so the
      // panel reconnects to the backend scheduler instead of competing with it.
      this.backendSyncStarted = false;
      window.clearTimeout(this._backendRetryTimer);
      this._backendRetryTimer = window.setTimeout(() => {
        if (this.isConnected) this.ensureBackendSync();
      }, 5000);
    } finally {
      this._syncing = false;
      this.flushBackendSync();
    }
  }

  openSetup() {
    this.activeTab = "schedules";
    this.setupDraft = null;
    this.setupRevision = this.climatesRevision;
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
    if (!chosen.length || this.applying || !this.backendSyncComplete) return;

    const climates = chosen.map((item) => ({
      entity: item.entity,
      name: item.name?.trim() || null,
    }));

    this.applying = true;
    this.render();
    try {
      const result = await this._hass.callWS({
        type: "nimbus_climate_scheduler/set_climates",
        climates,
        expected_revision: this.setupRevision ?? this.climatesRevision ?? 0,
      });
      this.serverClimates = result.climates;
      this.climatesRevision = result.revision;
      this.showSetup = false;
      this.setupDraft = null;
      this.setupRevision = undefined;
      this.applyResultData = null;
    } catch (error) {
      this.showError(error?.message ?? "Could not save the zone selection.");
    } finally {
      this.applying = false;
      this._syncQueued = false;
      // Fetch committed plans and initialize only genuinely new zones. Setup
      // must never write an existing saved plan or browser draft back to HA.
      await this.syncBackendSchedules();
      this.render();
    }
  }

  renderSetup() {
    this.setupWizard.replaceChildren();
    this.setupWizard.hidden = !this.showSetup;
    if (!this.showSetup) return;

    this.setupDraft ??= this.buildSetupDraft();
    this.setupRevision ??= this.climatesRevision;

    const title = document.createElement("h2");
    title.className = "setup-title";
    title.textContent = "Set up climate zones";

    const hint = document.createElement("p");
    hint.className = "setup-hint";
    hint.textContent = "Pick the thermostats to schedule and name each zone. Existing plans are preserved; new thermostats sharing a zone name inherit its plan. New zones start with a default plan you can edit afterwards.";

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
      checkbox.disabled = this.applying;
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
      name.disabled = this.applying;
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
    cancel.disabled = this.applying;
    cancel.addEventListener("click", () => this.closeSetup());

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "setup-confirm";
    confirm.textContent = this.applying ? "Saving…" : "Save zones";
    confirm.disabled = this.applying || !this.backendSyncComplete || !this.setupDraft.some((item) => item.checked);
    confirm.addEventListener("click", () => this.applySetup());

    actions.append(cancel, confirm);
    this.setupWizard.append(title, hint, list, actions);
  }

  async saveZoneToBackend(zone, data = serializeZoneSchedule(zone)) {
    if (!zone.entityId || !this._hass?.callWS) return;
    const entry = this.getOrCreateStoreEntry(zone.id);
    const result = await this._hass.callWS({
      type: "nimbus_climate_scheduler/save_zone",
      entity_id: zone.entityId,
      data,
      expected_revision: entry.revision ?? 0,
    });
    entry.revision = result?.revision ?? entry.revision;
  }

  getConfiguredClimates() {
    const config = this._panel?.config ?? {};
    // The user's in-panel selection (setup wizard) wins over YAML config.
    const entries = this.serverClimates ?? config.climates ?? config.zones ?? [];

    if (this.serverClimates?.length === 0) return [];

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

  renderZoneStatus(zone) {
    const row = document.createElement("div");
    row.className = "zone-status";

    const label = document.createElement("span");
    label.className = "zone-status-label";
    label.textContent = "Status:";

    const unavailable = zone.unavailableEntities ?? [];
    const capabilityIssues = zone.capabilityIssues ?? [];
    const issues = [
      ...(unavailable.length ? [`Unavailable: ${unavailable.join(", ")}`] : []),
      ...capabilityIssues,
    ];
    const value = document.createElement("span");
    value.className = `zone-status-value${issues.length ? " warn" : ""}`;
    value.textContent = issues.join("; ");
    row.hidden = !issues.length;

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
    // Keep configured members visible even when HA temporarily has no state,
    // so an unavailable/replaced thermostat can still be removed from its zone.
    const state = this._hass.states[config.entity] ?? { state: "unavailable", attributes: {} };
    const stored = loadStoredEntitySchedule(config.entity);

    const entityIds = group?.entityIds ?? [config.entity];
    // A service call targets ALL grouped entities, so capabilities must be the
    // SAFE INTERSECTION across them — modes common to all, tightest temp range,
    // coarsest step — not just the first entity's. Avoids failures / partial
    // apply on mixed groups (e.g. heat-only + heat-cool, or different limits).
    const capStates = entityIds.map((id) => this._hass.states[id]).filter(Boolean);
    if (!capStates.length) capStates.push(state);
    const modeLists = capStates.map((s) => this.getSupportedScheduleModes(s));
    const supportedModes = modeLists.reduce(
      (acc, list) => acc.filter((m) => list.includes(m)),
      modeLists[0] ?? [],
    );
    const capabilityIssues = [];
    if (!supportedModes.length) {
      capabilityIssues.push("Grouped thermostats have no common Heat/Cool mode");
    }
    let minTemp = Math.max(...capStates.map((s) => coerceFiniteNumber(s.attributes.min_temp, this.defaultMinTemp())));
    let maxTemp = Math.min(...capStates.map((s) => coerceFiniteNumber(s.attributes.max_temp, this.defaultMaxTemp())));
    if (maxTemp < minTemp) {
      capabilityIssues.push("Grouped thermostats have no overlapping temperature range");
      // Keep the editor renderable, but the incompatible zone is disabled below
      // and excluded from every automatic/direct apply path.
      minTemp = coerceFiniteNumber(state.attributes.min_temp, this.defaultMinTemp());
      maxTemp = coerceFiniteNumber(state.attributes.max_temp, this.defaultMaxTemp());
    }
    const capabilitiesCompatible = capabilityIssues.length === 0;
    const tempStep = Math.max(...capStates.map((s) => coerceFiniteNumber(s.attributes.target_temp_step, 0.5) || 0.5));
    const entry = this.getOrCreateStoreEntry(config.entity);
    const scheduleMode = this.normalizeScheduleMode(
      entry.scheduleMode ?? stored?.scheduleMode ?? config.schedule_mode,
      supportedModes,
    );
    const activeScheduleMode = this.normalizeActiveScheduleMode(
      entry.activeScheduleMode !== undefined ? entry.activeScheduleMode : stored?.activeScheduleMode,
      ["heat", "cool"],
    );
    const modes = this.getOrCreateSchedules(config.entity, state, stored?.modes);
    this.ensureSchedulesForModes(modes, supportedModes, state);

    // Mutate the entry in place — zone objects from every render generation
    // read scheduleMode through this shared object, so it must never be replaced.
    entry.modes = modes;
    entry.scheduleMode = scheduleMode;
    entry.activeScheduleMode = activeScheduleMode;

    const unavailableEntities = entityIds.filter((entityId) => {
      const entityState = this._hass.states[entityId]?.state;
      return !entityState || entityState === "unavailable" || entityState === "unknown";
    });

    const zone = {
      id: config.entity,
      groupId: config.zone_id,
      entityId: config.entity,
      entityIds,
      unavailableEntities,
      capabilityIssues,
      capabilitiesCompatible,
      name: group?.name ?? config.name ?? state.attributes.friendly_name ?? config.entity,
      currentTemp: formatTemperature(state.attributes.current_temperature ?? state.attributes.temperature),
      targetTemp: formatTemperature(state.attributes.temperature),
      // Limits and resolution come from the device itself (already in the
      // HA-configured unit system, so °F installs get °F numbers).
      minTemp,
      maxTemp,
      tempStep,
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
    const hvacModes = state.attributes.hvac_modes;
    return Array.isArray(hvacModes) ? ["heat", "cool"].filter((mode) => hvacModes.includes(mode)) : ["heat", "cool"];
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
    const heatDay = normalizeSetpoints([
      { minute: 0, temp: safeHeatTemp },
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
    if (!this.zones.length && !this._hass) {
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
    this.renderSettings();
    for (const tab of this.root.querySelectorAll('[role="tab"]')) {
      const selected = tab.id === `${this.activeTab}Tab`;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.setupWizard.hidden = !this.showSetup || this.activeTab !== "schedules";

    this.zonesEl.replaceChildren();
    this.zonesEl.hidden = this.showSetup || this.activeTab !== "schedules";
    if (this.zonesEl.hidden) {
      this.flushBackendSync();
      return;
    }

    for (const zone of this.zones) {
      const schedule = this.getModeSchedule(zone);
      const node = this.zoneTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.zoneId = zone.id;
      node.classList.toggle("expanded", zone.id === this.selectedZoneId);
      this.renderZoneName(node.querySelector(".zone-name"), zone);
      node.querySelector(".zone-temp").textContent = temperatureLabel(zone.currentTemp);
      node.querySelector(".zone-temp").title = `Room temperature (${this.temperatureUnit})`;
      node.querySelector(".zone-mode").textContent = modeLabel(zone.hvacMode);

      if (schedule.dirty) {
        node.querySelector(".zone-mode").append(this.makeDirtyBadge());
      }

      node.classList.toggle("inactive", !zone.activeScheduleMode);
      node.querySelector(".zone-switch-slot").append(this.renderZoneSwitch(zone));
      const scheduleState = document.createElement("span");
      scheduleState.className = "zone-schedule-state";
      scheduleState.textContent = zone.activeScheduleMode ? "Scheduled" : "Paused";
      node.querySelector(".zone-switch-slot").append(scheduleState);
      node.querySelector(".zone-header").append(this.renderZoneActions(zone));
      node.querySelector(".zone-name").setAttribute("aria-expanded", String(zone.id === this.selectedZoneId));
      node.querySelector(".zone-name").addEventListener("click", () => {
        this.requestNavigation(() => {
          this.selectedZoneId = this.selectedZoneId === zone.id ? null : zone.id;
        });
      });

      const body = node.querySelector(".zone-body");
      if (zone.groupId && this.membersDraft?.zoneId === zone.groupId) {
        body.append(this.renderZoneMembers(zone));
        this.zonesEl.append(node);
        continue;
      }
      body.append(this.renderZoneScheduleMode(zone));
      if (zone.entityId) {
        body.append(this.renderZoneStatus(zone));
      }
      body.append(this.renderSchedulePreview(zone));
      body.append(this.renderColorLegend(zone.scheduleMode));
      body.append(this.renderWeekToolbar());
      for (const days of this.getDayGroups(zone)) {
        body.append(this.renderDay(zone, days));
      }

      this.zonesEl.append(node);
    }
    this.flushBackendSync();
  }

  getDayGroups(zone) {
    const schedule = this.getModeSchedule(zone);
    const groups = [];
    for (const day of DAYS) {
      const group = this.groupDays && groups.find(([other]) => (
        setpointsEqual(schedule.draftWeek[day], schedule.draftWeek[other])
        && setpointsEqual(schedule.savedWeek[day], schedule.savedWeek[other])
      ));
      if (group) group.push(day);
      else groups.push([day]);
    }
    return groups;
  }

  renderSettings() {
    this.settingsEl.hidden = this.activeTab !== "settings";
    if (this.settingsEl.hidden) return;
    this.settingsEl.replaceChildren();
    this.settingsDraft ??= structuredClone(this.colorThresholds);
    const title = document.createElement("h2");
    title.textContent = "Temperature colors";
    const hint = document.createElement("p");
    hint.textContent = `Choose the color thresholds for all zones and dashboard cards (${this.temperatureUnit}). These affect display only, not thermostat targets. Cold must be below Warm, and Warm below Hot.`;
    const form = document.createElement("form");
    form.className = "settings-form";
    for (const mode of ["heat", "cool"]) {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = modeLabel(mode);
      fieldset.append(legend);
      for (const [band, description] of [["cold", "Cold at or below"], ["warm", "Warm from"], ["hot", "Hot from"]]) {
        const label = document.createElement("label");
        const swatch = document.createElement("span");
        swatch.className = `color-swatch color-${band}`;
        swatch.setAttribute("aria-hidden", "true");
        label.append(swatch, `${description} (${this.temperatureUnit})`);
        const input = document.createElement("input");
        input.type = "number";
        input.required = true;
        input.step = "any";
        input.min = String(this.fromCelsius(-100));
        input.max = String(this.fromCelsius(100));
        input.value = String(formatTemperature(this.fromCelsius(this.settingsDraft[mode][band])));
        input.disabled = this.settingsSaving;
        input.addEventListener("input", () => {
          this.settingsDraft[mode][band] = input.value === "" ? NaN : this.toCelsius(Number(input.value));
        });
        label.append(input);
        fieldset.append(label);
      }
      form.append(fieldset);
    }
    const actions = document.createElement("div");
    actions.className = "settings-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Restore default colors";
    reset.disabled = this.settingsSaving;
    reset.addEventListener("click", () => {
      this.settingsDraft = structuredClone(DEFAULT_COLOR_THRESHOLDS);
      this.settingsMessage = "Defaults restored in this form. Save to apply.";
      this.renderSettings();
    });
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = this.settingsSaving ? "Saving…" : "Save settings";
    save.disabled = this.settingsSaving || !this.backendSyncComplete;
    actions.append(reset, save);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.saveSettings();
    });
    const message = document.createElement("p");
    message.setAttribute("role", "status");
    message.textContent = this.settingsMessage ?? "Settings are also available as Number entities in Home Assistant.";
    this.settingsEl.append(title, hint, form, message);
  }

  async saveSettings() {
    if (this.settingsSaving) return;
    if (Object.values(this.settingsDraft).some(({ cold, warm, hot }) => (
      ![cold, warm, hot].every(Number.isFinite) || !(cold < warm && warm < hot)
    ))) {
      this.settingsMessage = "Enter valid temperatures in ascending order: Cold < Warm < Hot.";
      this.renderSettings();
      return;
    }
    this.settingsSaving = true;
    this.renderSettings();
    try {
      const result = await this._hass.callWS({
        type: "nimbus_climate_scheduler/set_settings",
        settings: { color_thresholds: structuredClone(this.settingsDraft) },
        expected_revision: this.settingsBaseRevision,
      });
      this.colorThresholds = result.settings.color_thresholds;
      this.settingsRevision = this.settingsBaseRevision = result.revision;
      this.settingsMessage = "Color settings saved.";
    } catch (error) {
      this.settingsMessage = error?.message ?? "Could not save color settings.";
    } finally {
      this.settingsSaving = false;
      this.renderSettings();
    }
  }

  renderColorLegend(mode) {
    const { cold, warm, hot } = this.colorThresholds[mode];
    const format = (value) => `${formatTemperature(this.fromCelsius(value))}${this.temperatureUnit}`;
    const legend = document.createElement("div");
    legend.className = "color-legend";
    for (const [band, text] of [
      ["cold", `Cold ≤ ${format(cold)}`],
      ["comfort", `Comfort > ${format(cold)} to < ${format(warm)}`],
      ["warm", `Warm ≥ ${format(warm)} to < ${format(hot)}`],
      ["hot", `Hot ≥ ${format(hot)}`],
    ]) {
      const label = document.createElement("span");
      const swatch = document.createElement("span");
      swatch.className = `color-swatch color-${band}`;
      swatch.setAttribute("aria-hidden", "true");
      label.append(swatch, text);
      legend.append(label);
    }
    return legend;
  }

  renderWeekToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "week-toolbar";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.groupDays;
    checkbox.addEventListener("change", () => {
      this.groupDays = checkbox.checked;
      this.daySelection = null;
      this.render();
    });
    label.append(checkbox, "Group matching days");
    const hint = document.createElement("span");
    hint.textContent = "Each schedule day runs from 05:00 to 05:00 the following day.";
    toolbar.append(label, hint);
    return toolbar;
  }

  daysForEdit(zone, day, mode = zone.scheduleMode) {
    const selection = this.daySelection;
    if (selection?.zoneId === zone.id && selection.mode === mode && selection.sourceDay === day) {
      return selection.days;
    }
    return this.getDayGroups(zone).find((days) => days.includes(day)) ?? [day];
  }

  updateDraftDay(zone, day, update, mode = zone.scheduleMode) {
    const schedule = this.getModeSchedule(zone, mode);
    const days = [...this.daysForEdit(zone, day, mode)];
    const points = cloneSetpoints(schedule.draftWeek[day]);
    update(points);
    for (const target of days) schedule.draftWeek[target] = cloneSetpoints(points);
    this.markDirty(zone, mode);
  }

  suggestSetpointMinute(points) {
    const gaps = points.map((point, index) => (points[index + 1]?.minute ?? DAY_LENGTH_MINUTES) - point.minute);
    const index = gaps.indexOf(Math.max(...gaps));
    if (gaps[index] < 2) return null;
    const start = points[index].minute;
    const end = start + gaps[index];
    return clamp(snapMinute((start + end) / 2, SNAP_MINUTES), start + 1, end - 1);
  }

  addSetpoint(zone, day, minute = null) {
    const points = this.getModeSchedule(zone).draftWeek[day];
    minute ??= this.suggestSetpointMinute(points);
    if (!Number.isInteger(minute) || minute <= 0 || minute >= DAY_LENGTH_MINUTES
      || points.some((point) => point.minute === minute)) return false;
    const index = points.findLastIndex((point) => point.minute < minute);
    this.updateDraftDay(zone, day, (draft) => {
      draft.splice(index + 1, 0, { minute, temp: draft[index].temp });
    });
    this.render();
    return true;
  }

  removeSetpoint(zone, day, index) {
    // The first interval covers the start of the day; keep at least that one.
    if (index === 0) return;
    this.updateDraftDay(zone, day, (points) => points.splice(index, 1));
    this.render();
  }

  renderDay(zone, days) {
    const day = days.includes(this.selectedDay) ? this.selectedDay : days[0];
    const row = this.dayTemplate.content.firstElementChild.cloneNode(true);
    const isActive = zone.id === this.selectedZoneId && day === this.selectedDay;
    const schedule = this.getModeSchedule(zone);
    const setpoints = schedule.draftWeek[day];
    const savedSetpoints = schedule.savedWeek[day];

    row.dataset.day = day;
    row.classList.toggle("active", isActive);
    row.querySelector(".day-button").textContent = dayGroupLabel(days);
    row.querySelector(".day-button").setAttribute("aria-expanded", String(isActive));
    const selectDay = () => {
      this.requestNavigation(() => {
        this.selectedZoneId = zone.id;
        this.selectedDay = isActive ? null : day;
        this.daySelection = null;
      });
    };
    row.querySelector(".day-button").addEventListener("click", selectDay);

    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "day-chevron";
    chevron.setAttribute("aria-label", `Edit ${dayGroupLabel(days)}`);
    chevron.setAttribute("aria-expanded", String(isActive));
    chevron.addEventListener("click", selectDay);
    row.append(chevron);
    row.querySelector(".day-current").textContent = `${setpoints.length} ${setpoints.length === 1 ? "interval" : "intervals"}`;

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
      handle.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : SNAP_MINUTES);
        this.updateDraftDay(zone, day, (points) => {
          points[index].minute = clamp(points[index].minute + delta, points[index - 1].minute + 1,
            (points[index + 1]?.minute ?? DAY_LENGTH_MINUTES) - 1);
        });
        this.render();
        this.root.querySelector(`.zone[data-zone-id="${zone.id}"] [data-day="${day}"] .handle[data-index="${index + 1}"]`)?.focus();
      });
      handlesEl.append(handle);
    });
  }

  renderSetpointPanel(panel, zone, day, setpoints, savedSetpoints, isActive) {
    panel.replaceChildren();
    if (!isActive) return;

    panel.append(this.renderDaySelection(zone, day));

    setpoints.forEach((point, index) => {
      const editor = document.createElement("div");
      editor.className = "setpoint-editor";

      const label = document.createElement("span");
      label.dataset.setpointLabel = String(index);
      label.textContent = formatSetpointRange(setpoints, index);

      const time = document.createElement("input");
      time.type = "time";
      time.step = "60";
      time.value = minutesToTime(scheduleMinuteToClockMinute(point.minute));
      time.disabled = index === 0;
      time.setAttribute("aria-label", `Interval ${index + 1} start time`);
      if (index === 0) time.title = "The first interval starts at 05:00.";
      time.addEventListener("change", () => {
        const minute = timeToScheduleMinute(time.value);
        if (!time.value || !Number.isFinite(minute) || minute <= setpoints[index - 1].minute
          || minute >= (setpoints[index + 1]?.minute ?? DAY_LENGTH_MINUTES)) {
          time.setCustomValidity("Choose a time between the previous and next interval, within the 05:00–05:00 schedule day.");
          time.reportValidity();
          return;
        }
        time.setCustomValidity("");
        this.updateDraftDay(zone, day, (points) => { points[index].minute = minute; });
        this.render();
      });

      const step = zone.tempStep ?? 0.5;
      const minTemp = zone.minTemp ?? this.defaultMinTemp();
      const maxTemp = zone.maxTemp ?? this.defaultMaxTemp();
      const applyTemp = (next) => {
        if (!Number.isFinite(next)) return;
        const snapped = Math.round(next / step) * step;
        this.updateDraftDay(zone, day, (points) => {
          points[index].temp = Math.round(clamp(snapped, minTemp, maxTemp) * 10) / 10;
        });
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
      input.setAttribute("aria-label", `Interval ${index + 1} temperature (${this.temperatureUnit})`);
      input.addEventListener("change", () => {
        if (input.value !== "") applyTemp(Number(input.value));
      });

      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "step-button";
      plus.textContent = "+";
      plus.setAttribute("aria-label", `Setpoint ${index + 1} up`);
      plus.addEventListener("click", () => applyTemp(Number(point.temp) + step));

      stepper.append(icon, minus, input, plus);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-interval";
      remove.textContent = "Remove";
      remove.disabled = index === 0;
      remove.setAttribute("aria-label", `Remove interval ${index + 1}`);
      remove.title = index === 0 ? "The first interval covers the start of the day." : "Extend the previous interval to replace this one.";
      remove.addEventListener("click", () => this.removeSetpoint(zone, day, index));
      editor.append(label, time, stepper, remove);
      panel.append(editor);
    });

    const addEditor = document.createElement("div");
    addEditor.className = "setpoint-editor";
    const addLabel = document.createElement("label");
    addLabel.textContent = "New interval starts";
    const addTime = document.createElement("input");
    addTime.type = "time";
    addTime.step = "60";
    const suggested = this.suggestSetpointMinute(setpoints);
    addTime.value = suggested === null ? "" : minutesToTime(scheduleMinuteToClockMinute(suggested));
    addTime.disabled = suggested === null;
    addTime.addEventListener("input", () => addTime.setCustomValidity(""));
    addLabel.append(addTime);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "add-interval";
    add.textContent = "Add interval";
    add.disabled = setpoints.length >= DAY_LENGTH_MINUTES;
    add.addEventListener("click", () => {
      if (!addTime.value || !this.addSetpoint(zone, day, timeToScheduleMinute(addTime.value))) {
        addTime.setCustomValidity("Choose a start time that is not already used by another interval.");
        addTime.reportValidity();
      }
    });
    addEditor.append(addLabel, add);
    panel.append(addEditor, this.renderDayActions(zone, day));
  }

  renderDaySelection(zone, sourceDay) {
    const selection = {
      zoneId: zone.id, mode: zone.scheduleMode, sourceDay,
      days: [...this.daysForEdit(zone, sourceDay)],
    };
    this.daySelection = selection;
    const wrap = document.createElement("fieldset");
    wrap.className = "day-selection";
    const legend = document.createElement("legend");
    legend.textContent = "Edit days together";
    wrap.append(legend);
    for (const day of DAYS) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selection.days.includes(day);
      checkbox.disabled = selection.days.length === 1 && selection.days.includes(day);
      checkbox.addEventListener("change", () => {
        this.selectEditingDays(zone, sourceDay,
          DAYS.filter((target) => target === day ? checkbox.checked : selection.days.includes(target)));
      });
      label.append(checkbox, day);
      wrap.append(label);
    }
    for (const [label, days] of [["Every day", DAYS], ["Weekdays", DAYS.slice(0, 5)], ["Weekend", DAYS.slice(5)], ["Only this day", [sourceDay]]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.selectEditingDays(zone, sourceDay, days);
      });
      wrap.append(button);
    }
    const hint = document.createElement("p");
    hint.textContent = "Edits use this plan for all selected days. Save to apply them to your thermostats.";
    wrap.append(hint);
    return wrap;
  }

  selectEditingDays(zone, sourceDay, days) {
    if (!days.length) return;
    const source = days.includes(sourceDay) ? sourceDay : days[0];
    this.selectedZoneId = zone.id;
    this.selectedDay = source;
    this.daySelection = { zoneId: zone.id, mode: zone.scheduleMode, sourceDay: source, days: [...days] };
    this.render();
  }

  renderDayActions(zone, sourceDay) {
    const wrap = document.createElement("div");
    wrap.className = "copy-actions";
    const days = this.daysForEdit(zone, sourceDay);
    const schedule = this.getModeSchedule(zone);
    const dirty = days.some((day) => !setpointsEqual(schedule.draftWeek[day], schedule.savedWeek[day]));

    const actionGroup = document.createElement("div");
    actionGroup.className = "copy-action-buttons";

    const resetDayButton = document.createElement("button");
    resetDayButton.type = "button";
    resetDayButton.textContent = "Reset selected days";
    resetDayButton.disabled = !dirty;
    resetDayButton.addEventListener("click", () => {
      for (const day of days) schedule.draftWeek[day] = cloneSetpoints(schedule.savedWeek[day]);
      this.markDirty(zone);
      this.render();
    });
    actionGroup.append(resetDayButton);

    const saveDayButton = document.createElement("button");
    saveDayButton.type = "button";
    saveDayButton.className = "save-day-button";
    saveDayButton.textContent = "Save selected days";
    saveDayButton.disabled = !dirty;
    saveDayButton.addEventListener("click", () => {
      this.saveZoneDays(zone, zone.scheduleMode, days);
      this.render();
    });
    actionGroup.append(saveDayButton);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Use this plan for selected days";
    copyButton.disabled = days.every((day) => setpointsEqual(schedule.draftWeek[day], schedule.draftWeek[sourceDay]));
    copyButton.addEventListener("click", () => {
      this.updateDraftDay(zone, sourceDay, () => {});
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
      days: [...this.daysForEdit(this.findZone(zoneId), day)],
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
    const previous = points[this.activeDrag.index - 1].minute + 1;
    const nextPoint = points[this.activeDrag.index + 1];
    const next = nextPoint ? nextPoint.minute - 1 : DAY_LENGTH_MINUTES - 1;

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
    for (const day of this.activeDrag.days) {
      schedule.draftWeek[day] = cloneSetpoints(schedule.draftWeek[this.activeDrag.day]);
    }
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
        label.textContent = formatSetpointRange(setpoints, index);
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
    const editingMembers = Boolean(zone.groupId && this.membersDraft?.zoneId === zone.groupId);
    saveButton.disabled = this.applying || editingMembers || !this.getModeSchedule(zone).dirty;
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
    deleteButton.disabled = this.applying;
    deleteButton.addEventListener("click", () => this.deleteZone(zone));

    const membersButton = document.createElement("button");
    membersButton.type = "button";
    membersButton.className = "zone-members-button";
    membersButton.textContent = `Thermostats (${zone.entityIds?.length ?? 1})`;
    membersButton.setAttribute("aria-label", `Manage thermostats for ${zone.name}`);
    membersButton.setAttribute("aria-expanded", String(editingMembers));
    membersButton.disabled = this.applying || !this.backendSyncComplete || !zone.groupId;
    membersButton.addEventListener("click", () => this.openZoneMembers(zone));

    actions.append(membersButton, saveButton, discardButton, editButton, deleteButton);
    return actions;
  }

  openZoneMembers(zone) {
    this.requestNavigation(() => {
      this.selectedZoneId = zone.id;
      this.selectedDay = null;
      this.daySelection = null;
      this.membersDraft = {
        zoneId: zone.groupId,
        sourceEntityId: zone.entityId,
        original: [...zone.entityIds],
        selected: [...zone.entityIds],
        revision: this.scheduleStore.get(zone.id)?.revision ?? 0,
        error: null,
      };
    });
  }

  renderZoneMembers(zone) {
    const draft = this.membersDraft;
    const section = document.createElement("section");
    section.className = "zone-members";
    const title = document.createElement("h3");
    title.textContent = `Thermostats in ${zone.name}`;
    const hint = document.createElement("p");
    hint.textContent = "Select one or more thermostats. They share this zone's existing schedule, target temperatures and Schedule switch. New thermostats appear here once added to Home Assistant.";
    const list = document.createElement("fieldset");
    list.className = "members-list";
    const legend = document.createElement("legend");
    legend.textContent = "Zone thermostats";
    list.append(legend);
    const configs = this.getConfiguredClimates();
    const entityIds = [...new Set([
      ...draft.original,
      ...Object.keys(this._hass?.states ?? {}).filter((entityId) => entityId.startsWith("climate.")),
    ])].sort((left, right) => (
      Number(draft.original.includes(right)) - Number(draft.original.includes(left)) || left.localeCompare(right)
    ));
    for (const entityId of entityIds) {
      const state = this._hass?.states[entityId];
      const current = draft.original.includes(entityId);
      const owner = configs.find((config) => config.entity === entityId);
      const elsewhere = owner && !current;
      const unavailable = !state || ["unavailable", "unknown"].includes(state.state);
      const row = document.createElement("label");
      row.className = "member-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = entityId;
      checkbox.checked = draft.selected.includes(entityId);
      checkbox.disabled = this.applying || Boolean(elsewhere) || (!current && unavailable);
      checkbox.setAttribute("aria-label", state?.attributes.friendly_name ?? entityId);
      checkbox.addEventListener("change", () => {
        draft.selected = checkbox.checked ? [...draft.selected, entityId] : draft.selected.filter((id) => id !== entityId);
        draft.error = null;
        // Keep the focused checkbox in place for keyboard and touch users.
        updateSaveButton();
      });
      const details = document.createElement("span");
      details.className = "member-details";
      const name = document.createElement("strong");
      name.textContent = state?.attributes.friendly_name ?? entityId;
      const entity = document.createElement("span");
      entity.className = "member-entity";
      entity.textContent = entityId;
      const status = document.createElement("span");
      status.className = "member-status";
      status.textContent = elsewhere ? `Assigned to ${owner.name ?? owner.entity}`
        : unavailable ? "Unavailable" : current ? "In this zone" : "Available to add";
      details.append(name, entity, status);
      row.append(checkbox, details);
      list.append(row);
    }
    const note = document.createElement("p");
    note.textContent = "Keep at least one thermostat selected. Removed thermostats are left under manual control. The zone's schedules and automation entity IDs are retained.";
    const error = document.createElement("p");
    error.className = "members-error";
    error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "setup-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.disabled = this.applying;
    cancel.addEventListener("click", () => {
      this.membersDraft = null;
      this.render();
      this.root.querySelector(`.zone[data-zone-id="${zone.id}"] .zone-members-button`)?.focus();
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "setup-confirm";
    save.textContent = this.applying ? "Saving…" : "Save thermostats";
    const updateSaveButton = () => {
      const unchanged = draft.original.length === draft.selected.length && draft.original.every((id) => draft.selected.includes(id));
      save.disabled = this.applying || !this.backendSyncComplete || !draft.selected.length || unchanged;
      error.textContent = draft.error ?? (!draft.selected.length ? "Select at least one thermostat." : "");
    };
    updateSaveButton();
    save.addEventListener("click", () => this.saveZoneMembers());
    actions.append(cancel, save);
    section.append(title, hint, list, note, error, actions);
    return section;
  }

  async saveZoneMembers() {
    const draft = this.membersDraft;
    if (!draft?.selected.length || this.applying || !this.backendSyncComplete) return false;
    const source = this.scheduleStore.get(draft.sourceEntityId);
    this.applying = true;
    draft.error = null;
    this.render();
    let saved = false;
    try {
      const result = await this._hass.callWS({
        type: "nimbus_climate_scheduler/set_zone_members",
        zone_id: draft.zoneId,
        source_entity_id: draft.sourceEntityId,
        entity_ids: draft.selected,
        expected_entity_ids: draft.original,
        expected_revision: draft.revision,
      });
      // Carry browser-only drafts with the zone, even when its original
      // representative thermostat is replaced. Only the backend's saved plan
      // is applied to the new members.
      for (const entityId of result.group.entity_ids) {
        const entry = { ...structuredClone(source), revision: result.revision };
        this.scheduleStore.set(entityId, entry);
        saveStoredEntitySchedule(entityId, entry);
      }
      for (const entityId of draft.original) {
        if (result.group.entity_ids.includes(entityId)) continue;
        this.scheduleStore.delete(entityId);
        try { window.localStorage.removeItem(storageKey(entityId)); } catch { /* Optional browser cache. */ }
      }
      this.serverClimates = result.climates;
      this.selectedZoneId = result.group.entity_ids[0];
      this.membersDraft = null;
      this.zonesSignature = null;
      this.syncZonesFromHass();
      const failed = result.apply_result?.failed ?? [];
      this.applyResultData = failed.length ? {
        applied: [], failed: failed.map((entityId) => ({ entityId, error: "Thermostats saved; target update failed." })),
      } : null;
      saved = true;
    } catch (error) {
      draft.error = error?.message ?? "Could not save thermostats. Your selection is kept; please try again.";
    } finally {
      this.applying = false;
      if (saved || this._syncQueued) {
        this._syncQueued = false;
        await this.syncBackendSchedules();
      }
      this.render();
    }
    return saved;
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
    if (this.applying || !this.backendSyncComplete) return;
    const confirmed = window.confirm(
      `Delete zone "${zone.name}" and its schedules? The thermostat itself is not affected.`,
    );
    if (!confirmed) return;

    const zoneEntities = zone.entityIds ?? [zone.entityId];
    const remaining = (this.serverClimates ?? this.zonesAsClimates())
      .filter((entry) => !zoneEntities.includes(entry.entity));

    this.applying = true;
    this.renderIfReady();
    try {
      const result = await this._hass.callWS({
        type: "nimbus_climate_scheduler/set_climates",
        climates: remaining,
        expected_revision: this.climatesRevision ?? 0,
      });
      this.serverClimates = result.climates;
      this.climatesRevision = result.revision;
    } catch (error) {
      this.showError(error?.message ?? "Could not delete the zone. Please try again.", zone.name);
      return;
    } finally {
      this.applying = false;
      this._syncQueued = false;
      await this.syncBackendSchedules();
    }

    for (const entityId of zoneEntities) {
      this.scheduleStore.delete(entityId);
      try { window.localStorage.removeItem(storageKey(entityId)); } catch { /* Optional browser cache. */ }
    }
    if (this.selectedZoneId === zone.id) {
      this.selectedZoneId = null;
    }

    if (remaining.length) {
      this.zonesSignature = null;
      this.syncZonesFromHass();
    } else {
      // Last zone removed: reopen the setup wizard instead of falling back
      // to auto-discovery of every climate entity.
      this.serverClimates = [];
      this.zones = [];
      this.showSetup = true;
      this.setupDraft = null;
      this.setupRevision = undefined;
    }
    this.render();
  }

  renderZoneScheduleMode(zone) {
    const row = document.createElement("div");
    row.className = "zone-schedule-mode";

    const label = document.createElement("label");
    label.textContent = "Edit schedule:";

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
        this.requestNavigation(() => {
          this.daySelection = null;
          this.selectedDay = null;
          this.setZoneScheduleMode(zone, mode);
        });
      });
      pills.append(pill);
    }

    row.append(label, pills);
    const runLabel = document.createElement("label");
    runLabel.textContent = "Run schedule: ";
    const runMode = document.createElement("select");
    runMode.setAttribute("aria-label", `${zone.name} active or resumed schedule mode`);
    const entry = this.scheduleStore.get(zone.id);
    const selected = zone.activeScheduleMode ?? entry?.resumeScheduleMode ?? zone.scheduleMode;
    for (const mode of zone.supportedScheduleModes ?? ["heat", "cool"]) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = modeLabel(mode);
      option.selected = mode === selected;
      runMode.append(option);
    }
    runMode.disabled = this.applying || !this.backendSyncComplete;
    runMode.addEventListener("change", () => this.setZoneControl(zone, { mode: runMode.value }));
    runLabel.append(runMode);
    row.append(runLabel);
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
      .filter((zone) => zone.capabilitiesCompatible !== false)
      .map((zone) => buildZoneApplyPlan(zone, this.getActiveModeSchedule(zone)?.savedWeek, at))
      .filter(Boolean);
  }


  renderApplyResult() {
    this.applyResult.replaceChildren();
    if (!this.applyResultData) {
      this.applyResult.hidden = true;
      return;
    }

    const { applied, failed } = this.applyResultData;
    const summary = document.createElement("span");
    summary.textContent = failed.length ? "Could not complete the change." : `Saved. ${applied.length} thermostat(s) updated.`;
    this.applyResult.append(summary);

    if (failed.length) {
      const details = document.createElement("span");
      details.className = "apply-result-details";
      details.textContent = failed.map((item) => `${item.entityId}: ${item.error ?? "Thermostat update failed"}`).join("; ");
      this.applyResult.append(details);
    }

    if (this.conflictZoneId) {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Discard draft and reload saved schedule";
      reload.addEventListener("click", async () => {
        const zone = this.findZone(this.conflictZoneId);
        for (const entityId of zone?.entityIds ?? [this.conflictZoneId]) {
          this.scheduleStore.delete(entityId);
          try { window.localStorage.removeItem(storageKey(entityId)); } catch { /* Optional browser cache. */ }
        }
        this.conflictZoneId = null;
        this.applyResultData = null;
        await this.syncBackendSchedules();
      });
      this.applyResult.append(reload);
    }

    this.applyResult.hidden = false;
  }

  renderSchedulerStatus() {
    if (!this.schedulerStatus) return;

    if (this.backendSyncComplete) {
      this.schedulerStatus.textContent = "Connected";
      return;
    }

    this.schedulerStatus.textContent = "Connecting to scheduler…";
  }

  async runSchedulerTick() {
    // The backend is the sole thermostat writer. A stale/disconnected browser
    // must never compete with an automation that has paused a schedule.
    if (this._hass?.callWS) await this.syncBackendSchedules();
  }

  setZoneScheduleMode(zone, mode) {
    const entry = this.scheduleStore.get(zone.id);
    if (entry) {
      entry.scheduleMode = mode;
    }
    this.persistZone(zone);
  }

  showError(message, name = "Nimbus") {
    this.applyResultData = { applied: [], failed: [{ entityId: name, error: message }] };
    this.renderIfReady();
  }

  async setZoneControl(zone, control) {
    if (this.applying || !this.backendSyncComplete) return;
    this.applying = true;
    this.renderIfReady();
    try {
      await this._hass.callWS({ type: "nimbus_climate_scheduler/set_control", entity_id: zone.entityId, ...control });
      this.applyResultData = null;
    } catch (error) {
      this.showError(error?.message ?? String(error), zone.name);
    } finally {
      this.applying = false;
      await this.syncBackendSchedules();
      this.renderIfReady();
    }
  }

  renderZoneSwitch(zone) {
    const active = Boolean(zone.activeScheduleMode);
    const compatible = zone.capabilitiesCompatible !== false;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zone-toggle";
    button.classList.toggle("active", active);
    button.disabled = this.applying || !this.backendSyncComplete || (!compatible && !active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${zone.name} schedule ${active ? "on" : "off"}`);
    button.title = !compatible
      ? (zone.capabilityIssues ?? ["Incompatible grouped thermostats"]).join(" · ")
      : active
        ? "Pause schedule and leave thermostats under manual control"
        : "Resume the saved schedule";
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.setZoneControl(zone, { enabled: !active });
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

  async resolveGuard(action) {
    if (!this.pendingNavigation) return;

    const pending = this.pendingNavigation;
    const zone = this.findZone(pending.zoneId);

    if (action === "save" && zone) {
      if (!await this.saveZoneMode(zone, pending.mode)) return;
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
    return this.saveZoneDays(zone, mode, DAYS);
  }

  saveZoneDay(zone, mode, day) {
    return this.saveZoneDays(zone, mode, [day]);
  }

  saveZoneDays(zone, mode, days) {
    const data = serializeZoneSchedule(zone);
    const schedule = data.modes[mode];
    for (const day of days) schedule.savedWeek[day] = cloneSetpoints(schedule.draftWeek[day]);
    return this.saveAndApply(zone, data);
  }

  async saveAndApply(zone, data) {
    // Saving pushes the schedule to the device right away through the
    // backend tick — no separate "Apply" step needed.
    if (!this.backendSyncComplete || !this._hass?.callWS || this.applying) return false;

    this.applying = true;
    this.applyResultData = null;
    this.renderIfReady();

    let saved = false;
    try {
      // The save must succeed before applying — otherwise the backend would
      // apply the PREVIOUS schedule. Let a failure bubble to the outer catch
      // (reported as failed) instead of swallowing it and applying stale data.
      data ??= serializeZoneSchedule(zone);
      await this.saveZoneToBackend(zone, data);
      for (const [mode, committed] of Object.entries(data.modes)) {
        const schedule = this.getModeSchedule(zone, mode);
        schedule.savedWeek = cloneWeek(committed.savedWeek);
        schedule.dirty = !weeksEqual(schedule.savedWeek, schedule.draftWeek);
      }
      this.persistZone(zone);
      saved = true;
      const result = await this._hass.callWS({ type: "nimbus_climate_scheduler/apply_now" });
      this.applyResultData = {
        applied: (result?.applied ?? []).map((entityId) => ({ entityId })),
        skippedOff: [],
        skippedMode: [],
        failed: (result?.failed ?? []).map((entityId) => ({ entityId })),
      };
    } catch (error) {
      if (error?.code === "conflict") this.conflictZoneId = zone.id;
      this.applyResultData = {
        applied: [],
        skippedOff: [],
        skippedMode: [],
        failed: [{ entityId: zone?.name ?? "schedule", error: error?.message ?? String(error) }],
      };
    }

    this.applying = false;
    if (this._syncQueued) {
      this._syncQueued = false;
      await this.syncBackendSchedules();
    }
    this.render();
    return saved;
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
    const { cold, warm, hot } = this.colorThresholds[mode ?? "heat"];
    // Tolerate conversion roundoff at exact Fahrenheit/Celsius boundaries.
    if (celsius <= cold + 1e-8) return "cool";
    if (celsius >= hot - 1e-8) return "hot";
    if (celsius >= warm - 1e-8) return "warm";
    return "";
  }

  colorForTemp(temp, mode = "heat") {
    return { cool: "#52dce9", hot: "#f3d24e", warm: "#9afb3b", "": "#6df338" }[this.tempClass(temp, mode)];
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
    const raw = window.localStorage.getItem(storageKey(entityId));
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
    window.localStorage.setItem(storageKey(entityId), JSON.stringify({
      ...serializeScheduleData(data),
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Storage can be unavailable in private browsing or full quota situations.
  }
}

function serializeZoneSchedule(zone) {
  return {
    scheduleMode: zone.scheduleMode,
    modes: serializeModes(zone.modes),
  };
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
      canApply: false,
      stateLabel: "Manual control",
      applyLabel: "Paused",
      previewText: "Schedule paused",
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
  const nextDay = DAYS[(DAYS.indexOf(day) + 1) % DAYS.length];
  const next = setpoints[currentIndex + 1] ?? week[nextDay]?.[0] ?? setpoints[0];
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

function dayGroupLabel(days) {
  if (days.length === 7) return "Every day";
  if (days.join() === DAYS.slice(0, 5).join()) return "Weekdays";
  if (days.join() === DAYS.slice(5).join()) return "Weekend";
  return days.join(", ");
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

// A config-entry reload can register a new content-fingerprinted module URL in
// an already open HA session. The browser upgrades the class on a page refresh.
if (!customElements.get("nimbus-climate-scheduler-panel")) {
  customElements.define("nimbus-climate-scheduler-panel", NimbusClimateSchedulerPanel);
}
