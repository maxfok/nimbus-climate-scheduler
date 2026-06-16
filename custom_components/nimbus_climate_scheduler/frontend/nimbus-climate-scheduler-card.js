/**
 * Nimbus Climate Scheduler — read-only reference card.
 *
 * Visual design from the "two-line track" direction (header: zone · mode ·
 * room temp + progress, over a cropped colored-band timeline showing the
 * current setpoint and the next, with a sliding "now" marker).
 *
 * Data comes from the integration itself — the released backend is untouched:
 *   - schedule via the `nimbus_climate_scheduler/get_zones` websocket
 *     (zones[entity].modes[mode].savedWeek[day] = [{minute, temp}], where
 *      minute is a schedule-minute with 0 == 05:00 and the day runs 05:00->05:00)
 *   - current/next setpoint computed exactly like the backend
 *     get_schedule_point_for_time()
 *   - setpoint colours from the panel's discrete colorForTemp() bands
 *   - current room temperature from the climate entity's current_temperature
 *
 * Lovelace config:
 *   type: custom:nimbus-climate-scheduler-card
 *   entity: climate.nursery_thermostat   # required — the zone (climate entity)
 *   name: Nursery                        # optional — overrides friendly_name
 */
(function () {
  "use strict";

  const DAY_START_MINUTES = 5 * 60;
  const DAY_LENGTH_MINUTES = 24 * 60;
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const REFRESH_SCHEDULE_MS = 5 * 60 * 1000;
  const TICK_MS = 30 * 1000;
  const WS_GET_ZONES = "nimbus_climate_scheduler/get_zones";

  const scheduleMinuteToClockMinute = (m) => (DAY_START_MINUTES + m) % DAY_LENGTH_MINUTES;
  const clockMinuteToScheduleMinute = (m) => (m - DAY_START_MINUTES + DAY_LENGTH_MINUTES) % DAY_LENGTH_MINUTES;

  function fmtHM(mins) {
    mins = ((Math.round(mins) % DAY_LENGTH_MINUTES) + DAY_LENGTH_MINUTES) % DAY_LENGTH_MINUTES;
    const h = Math.floor(mins / 60), m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  const fmtTemp = (t) =>
    t == null || isNaN(t) ? "–" : (Math.round(t * 10) / 10).toString().replace(/\.0$/, "") + "°";
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // Mirrors the backend get_schedule_point_for_time(), on one mode's savedWeek.
  function schedulePointForTime(savedWeek, now) {
    const clockMinute = now.getHours() * 60 + now.getMinutes();
    let dayIndex = (now.getDay() + 6) % 7; // JS Sun=0 -> Mon=0 weekday
    if (clockMinute < DAY_START_MINUTES) dayIndex = (dayIndex - 1 + 7) % 7;
    const setpoints = savedWeek?.[DAYS[dayIndex]];
    if (!Array.isArray(setpoints) || !setpoints.length) return null;

    const scheduleMinute = clockMinuteToScheduleMinute(clockMinute);
    let activeIndex = 0;
    for (let i = 0; i < setpoints.length; i += 1) {
      if ((setpoints[i].minute ?? 0) <= scheduleMinute) activeIndex = i;
    }
    const len = setpoints.length;
    return {
      current: setpoints[activeIndex],
      next: setpoints[(activeIndex + 1) % len],
      scheduleMinute,
      single: len === 1,
    };
  }

  const FLAME = '<path d="M12 23a7 7 0 0 0 7-7c0-2-1-4-3-6 .3 2-1 3-2 3 1-3-1-6-4-7 .5 3-1 4.5-2.5 6.3A6.9 6.9 0 0 0 5 16a7 7 0 0 0 7 7z"/>';
  const SNOW = '<path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17" stroke-width="1.7" stroke-linecap="round" fill="none"/>';

  class NimbusClimateSchedulerCard extends HTMLElement {
    setConfig(config) {
      if (!config || !config.entity) throw new Error("nimbus-climate-scheduler-card: 'entity' is required");
      this._config = { ...config };
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      if (this._hass) this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._maybeFetchZones();
      this._render();
    }
    get hass() { return this._hass; }

    connectedCallback() {
      this._timer = setInterval(() => this._render(), TICK_MS);
    }
    disconnectedCallback() {
      if (this._timer) clearInterval(this._timer);
    }

    getCardSize() { return 2; }
    static getStubConfig() { return { entity: "climate.nursery_thermostat" }; }
    static getConfigElement() { return document.createElement("nimbus-climate-scheduler-card-editor"); }

    _isFahrenheit() {
      return (this._hass?.config?.unit_system?.temperature ?? "°C") === "°F";
    }
    _toCelsius(temp) {
      return this._isFahrenheit() ? ((temp - 32) * 5) / 9 : temp;
    }
    // Same discrete bands as the scheduler panel — keeps card and panel in sync.
    _colorForTemp(temp, mode) {
      const c = this._toCelsius(temp);
      if (mode === "cool") {
        if (c <= 24) return "#52dce9";
        if (c >= 27) return "#f3d24e";
        if (c >= 25.5) return "#9afb3b";
        return "#6df338";
      }
      if (c <= 18) return "#52dce9";
      if (c >= 22) return "#f3d24e";
      if (c >= 20.5) return "#9afb3b";
      return "#6df338";
    }

    async _maybeFetchZones() {
      if (!this._hass?.callWS || this._fetching) return;
      if (this._zones && Date.now() - this._zonesFetchedAt < REFRESH_SCHEDULE_MS) return;
      this._fetching = true;
      try {
        const result = await this._hass.callWS({ type: WS_GET_ZONES });
        this._zones = result?.zones ?? {};
        this._zonesFetchedAt = Date.now();
        this._render();
      } catch (err) {
        // Panel not set up yet / websocket unavailable — keep previous data.
      } finally {
        this._fetching = false;
      }
    }

    _model() {
      const cfg = this._config, hass = this._hass;
      const st = hass?.states?.[cfg.entity];
      if (!st) return { error: `Entity not found: ${cfg.entity}` };
      const a = st.attributes || {};
      const name = cfg.name || a.friendly_name || cfg.entity;
      const room = a.current_temperature;

      const zone = this._zones?.[cfg.entity];
      const climateOff = st.state === "off" || st.state === "unavailable";
      const mode = zone?.activeScheduleMode ?? null;

      // Schedule disabled for this zone (or climate off) -> "off" state.
      if (climateOff || !mode) {
        return { name, room, state: "off" };
      }

      const savedWeek = zone?.modes?.[mode]?.savedWeek;
      const point = savedWeek ? schedulePointForTime(savedWeek, new Date()) : null;
      if (!point) {
        return { name, room, state: "idle", mode };
      }

      const cur = point.current;
      const next = point.next;
      const hasNext = !point.single;

      let curM = cur.minute;
      let nxtM = next.minute;
      if (nxtM <= curM) nxtM += DAY_LENGTH_MINUTES;
      let nowM = point.scheduleMinute;
      if (nowM < curM) nowM += DAY_LENGTH_MINUTES;
      nowM = clamp(nowM, curM, nxtM);
      const frac = hasNext && nxtM > curM ? (nowM - curM) / (nxtM - curM) : 1;

      const d = new Date();
      return {
        name, room, mode,
        state: "active",
        cur, next, hasNext,
        frac,
        curStartClock: scheduleMinuteToClockMinute(cur.minute),
        nextClock: scheduleMinuteToClockMinute(next.minute),
        nowClock: d.getHours() * 60 + d.getMinutes(),
      };
    }

    _deltaText(m) {
      const sp = m.cur?.temp;
      if (sp == null || m.room == null) return "";
      const diff = sp - m.room;
      if (m.mode === "heat" && diff > 0.2) return `▲ warming to ${fmtTemp(sp)}`;
      if (m.mode === "cool" && diff < -0.2) return `▼ cooling to ${fmtTemp(sp)}`;
      return `holding ${fmtTemp(sp)}`;
    }

    _render() {
      if (!this._config || !this._hass) return;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      const m = this._model();

      const STYLE = `
        <style>
          :host{
            --nb-surface:#1b1d22; --nb-surface-2:#232529; --nb-surface-3:#2a2c32;
            --nb-line:rgba(255,255,255,.06); --nb-line-2:rgba(255,255,255,.10);
            --nb-ink:#ecebe7; --nb-ink-2:#c2c0bb; --nb-ink-3:#8a8884; --nb-ink-4:#5e5d59;
          }
          ha-card{ display:block;
            background: linear-gradient(180deg, var(--nb-surface) 0%, #181a1e 100%);
            color: var(--nb-ink);
            border: 1px solid var(--nb-line-2);
            border-radius: 20px;
            box-shadow: none;
          }
          .wrap{ padding:18px 20px 16px; font-family: var(--ha-card-header-font-family, var(--mdc-typography-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)); }
          .head{ display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; }
          .zone{ font-size:15px; font-weight:600; margin-bottom:5px; color:var(--nb-ink); }
          .chip{ display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:3px 8px; border-radius:20px; }
          .chip svg{ width:12px; height:12px; }
          .temp{ font-size:34px; font-weight:300; line-height:.9; letter-spacing:-.02em; text-align:right; color:var(--nb-ink); }
          .delta{ font-size:11px; color:var(--nb-ink-3); margin-top:3px; text-align:right; }
          .track{ position:relative; height:36px; border-radius:9px; display:flex; overflow:visible; }
          .seg{ display:flex; align-items:center; padding-left:12px; }
          .seg span{ font-size:13px; font-weight:700; color:rgba(0,0,0,.6); }
          .seam{ width:3px; background: var(--nb-surface); }
          .marker{ position:absolute; top:-6px; bottom:-6px; width:2px; background:#fff; box-shadow:0 0 0 1.5px rgba(0,0,0,.55); border-radius:2px; z-index:3; }
          .bubble{ position:absolute; top:-23px; left:50%; transform:translateX(-50%);
            background: var(--nb-surface-3); color: var(--nb-ink);
            border:1px solid var(--nb-line-2);
            box-shadow:0 1px 4px rgba(0,0,0,.4); font-size:11px; font-weight:600; line-height:1;
            padding:4px 7px; border-radius:6px; white-space:nowrap; }
          .axis{ position:relative; height:14px; margin-top:7px; font-size:10px; color:var(--nb-ink-3); }
          .axis .l{ position:absolute; left:0; }
          .axis .c{ position:absolute; transform:translateX(-50%); font-weight:600; }
          .flat{ height:36px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--nb-ink-3); }
          .hatch{ background: repeating-linear-gradient(45deg, var(--nb-line-2), var(--nb-line-2) 6px, transparent 6px, transparent 12px); border:1px dashed var(--nb-line-2); }
          .neutral{ background: var(--nb-surface-2); }
        </style>`;

      let body;
      if (m.error) {
        body = `<div class="wrap"><div class="zone">Nimbus</div><div class="flat neutral">${m.error}</div></div>`;
      } else {
        const accentHeat = "oklch(0.78 0.16 45)";
        const accentCool = "#52dce9";
        const isCool = m.mode === "cool";
        const accent = m.state === "off"
          ? "var(--nb-ink-4)"
          : isCool ? accentCool : accentHeat;
        const icon = isCool ? SNOW : FLAME;
        const fillAttr = isCool ? `fill="none" stroke="${accent}"` : `fill="${accent}"`;
        const modeLabel = m.state === "off" ? "Off" : m.state === "idle" ? "Idle" : isCool ? "Cooling" : "Heating";

        const chip = `<div class="chip" style="background:color-mix(in srgb, ${accent} 16%, transparent); color:${accent};">
            <svg viewBox="0 0 24 24" ${fillAttr}>${icon}</svg>${modeLabel}</div>`;

        const head = `<div class="head">
            <div><div class="zone">${m.name}</div>${chip}</div>
            <div><div class="temp">${fmtTemp(m.room)}</div><div class="delta">${m.state === "off" ? "schedule off" : this._deltaText(m)}</div></div>
          </div>`;

        let track;
        if (m.state === "off") {
          track = `<div class="flat hatch"></div><div class="axis"><span class="l">Schedule off</span></div>`;
        } else if (m.state === "idle") {
          track = `<div class="flat neutral">No schedule today</div><div class="axis"><span class="l">Awaiting next setpoint</span></div>`;
        } else {
          const curColor = this._colorForTemp(m.cur.temp, m.mode);
          const nextColor = m.hasNext ? this._colorForTemp(m.next.temp, m.mode) : curColor;
          const curW = 64;
          const markerLeft = (m.frac * curW).toFixed(2);

          const nextSeg = m.hasNext
            ? `<div class="seam"></div><div class="seg" style="flex:1; background:${nextColor}; border-radius:0 9px 9px 0;"><span>${fmtTemp(m.next.temp)}</span></div>`
            : "";
          const marker = `<div class="marker" style="left:${markerLeft}%;"><div class="bubble">${fmtHM(m.nowClock)}</div></div>`;
          const axisRight = m.hasNext
            ? `<span class="c" style="left:${curW}%; color:${nextColor};">${fmtTemp(m.next.temp)} at ${fmtHM(m.nextClock)}</span>`
            : `<span class="c" style="left:100%; transform:translateX(-100%);">no more changes today</span>`;

          track = `<div class="track">
              <div class="seg" style="flex:0 0 ${curW}%; background:${curColor}; border-radius:9px 0 0 9px;"><span>${fmtTemp(m.cur.temp)}</span></div>
              ${nextSeg}
              ${marker}
            </div>
            <div class="axis"><span class="l">since ${fmtHM(m.curStartClock)}</span>${axisRight}</div>`;
        }

        body = `<div class="wrap">${head}${track}</div>`;
      }

      this.shadowRoot.innerHTML = STYLE + `<ha-card>${body}</ha-card>`;
    }
  }

  // --- GUI editor: pick a zone from the scheduler's configured zones ----------
  class NimbusClimateSchedulerCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._render();
    }
    set hass(hass) {
      this._hass = hass;
      this._maybeFetchZones();
      this._render();
    }

    async _maybeFetchZones() {
      if (!this._hass?.callWS || this._zones) return;
      try {
        const result = await this._hass.callWS({ type: WS_GET_ZONES });
        this._zones = Object.keys(result?.zones ?? {});
        this._render();
      } catch (err) {
        this._zones = [];
      }
    }

    _emit() {
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      }));
    }

    _render() {
      if (!this._config) return;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });

      const zones = this._zones ?? null;
      const current = this._config.entity ?? "";
      const friendly = (id) => this._hass?.states?.[id]?.attributes?.friendly_name ?? id;

      let entityField;
      if (zones && zones.length) {
        const options = zones
          .map((id) => `<option value="${id}" ${id === current ? "selected" : ""}>${friendly(id)}</option>`)
          .join("");
        entityField = `<label>Zone (climate entity)
            <select id="entity"><option value="">— select —</option>${options}</select>
          </label>`;
      } else {
        entityField = `<label>Zone (climate entity)
            <input id="entity" type="text" value="${current}" placeholder="climate.nursery_thermostat" />
          </label>
          <div class="hint">${zones ? "No Nimbus zones found — set up the scheduler panel first, or type the climate entity id." : "Loading zones…"}</div>`;
      }

      this.shadowRoot.innerHTML = `
        <style>
          .form{ display:flex; flex-direction:column; gap:14px; padding:4px 2px; }
          label{ display:flex; flex-direction:column; gap:6px; font-size:13px; color: var(--secondary-text-color, #666); }
          select, input{ font-size:14px; padding:8px 10px; border-radius:8px;
            border:1px solid var(--divider-color, #d6dadf);
            background: var(--card-background-color, #fff); color: var(--primary-text-color, #1c1c1c); }
          .hint{ font-size:12px; color: var(--secondary-text-color, #888); margin-top:-8px; }
        </style>
        <div class="form">
          ${entityField}
          <label>Name (optional)
            <input id="name" type="text" value="${this._config.name ?? ""}" placeholder="overrides the entity name" />
          </label>
        </div>`;

      const entityEl = this.shadowRoot.getElementById("entity");
      const nameEl = this.shadowRoot.getElementById("name");
      const onEntity = () => {
        const v = entityEl.value.trim();
        if (v) this._config.entity = v; else delete this._config.entity;
        this._emit();
      };
      entityEl.addEventListener("change", onEntity);
      if (entityEl.tagName === "INPUT") entityEl.addEventListener("input", onEntity);
      nameEl.addEventListener("input", () => {
        const v = nameEl.value.trim();
        if (v) this._config.name = v; else delete this._config.name;
        this._emit();
      });
    }
  }

  if (!customElements.get("nimbus-climate-scheduler-card")) {
    customElements.define("nimbus-climate-scheduler-card", NimbusClimateSchedulerCard);
  }
  if (!customElements.get("nimbus-climate-scheduler-card-editor")) {
    customElements.define("nimbus-climate-scheduler-card-editor", NimbusClimateSchedulerCardEditor);
  }
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "nimbus-climate-scheduler-card",
    name: "Nimbus Climate Scheduler Card",
    description: "Read-only reference card showing a zone's current and next setpoint on the scheduler timeline.",
    preview: true,
  });
})();
