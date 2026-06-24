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
  const INITIAL_RETRY_MS = 2 * 1000;
  const WS_GET_ZONES = "nimbus_climate_scheduler/get_zones";
  const PANEL_PATH = "/nimbus-climate-scheduler";

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
  // Escape user-controlled strings (zone names, friendly names, entity ids)
  // before they go into innerHTML, to prevent HTML/attribute injection.
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const navigateTo = (path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
  };

  // Walk forward to the idx-th setpoint from a day, crossing into the next
  // schedule day(s), so the "next" after the last setpoint of the day reflects
  // tomorrow's first setpoint (at 05:00) instead of today's first.
  function upcomingSetpoint(savedWeek, dayIndex, idx) {
    let di = dayIndex, i = idx, guard = 0;
    while (guard < 8) {
      const sp = savedWeek?.[DAYS[di]];
      if (Array.isArray(sp) && sp.length) {
        if (i < sp.length) return sp[i];
        i -= sp.length;
      }
      di = (di + 1) % 7;
      guard += 1;
    }
    return null;
  }

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
      next: upcomingSetpoint(savedWeek, dayIndex, activeIndex + 1) ?? setpoints[0],
      scheduleMinute,
      single: len === 1,
    };
  }

  // Mode accents + icons copied verbatim from the Nimbus Climate card MODES map,
  // so the two cards share one visual language (accent colour + avatar glyph).
  const MODE_META = {
    heat: { accent: "oklch(0.78 0.16 45)", icon: "M12 2.5c.7 3.2 3 4.6 4 6.5 1.4 2.5 1.5 5.5-.4 7.8a6.4 6.4 0 0 1-9.7-.4C4 14 5 10.5 7.2 9c.4 1.1 1.3 1.7 2 1.7-.4-2 .3-5.4 2.8-8.2Z" },
    cool: { accent: "oklch(0.78 0.13 235)", icon: "M12 3v18M5 6.5l14 11M5 17.5l14-11M12 6.5 9.5 4M12 6.5 14.5 4M12 17.5 9.5 20M12 17.5 14.5 20M5 12H2.5M5 12 3 9.5M5 12 3 14.5M21.5 12H19M19 12l2-2.5M19 12l2 2.5" },
    off:  { accent: "oklch(0.72 0.01 60)", icon: "M12 3v9M5.5 7.5a8 8 0 1 0 13 0" },
  };
  const modeIconSvg = (s) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${s.split("M").filter(Boolean).map((p) => `<path d="M${p}"/>`).join("")}</svg>`;

  // --- i18n -------------------------------------------------------------------
  // Card strings by language. To add one: copy the `en` block, translate the
  // values, key it by the 2-letter language code (e.g. "fr"). PRs welcome!
  // Placeholders: {t} = temperature, {e} = entity id. The "→" arrow, clock times
  // and temperatures stay in code (language-neutral).
  const TRANSLATIONS = {
    en: { heating: "Heating", cooling: "Cooling", off: "Off", idle: "Idle",
      holding: "holding {t}", scheduleOff: "schedule off", scheduleOffLabel: "Schedule off",
      noSchedule: "no schedule today", noScheduleLabel: "No schedule today",
      awaiting: "Awaiting next setpoint", since: "since {t}", at: "at",
      noMore: "no more changes today", openScheduler: "open scheduler",
      loading: "Nimbus Climate Scheduler is loading",
      notFound: "Entity not found: {e}" },
    nl: { heating: "Verwarmen", cooling: "Koelen", off: "Uit", idle: "Inactief",
      holding: "blijft op {t}", scheduleOff: "schema uit", scheduleOffLabel: "Schema uit",
      noSchedule: "geen schema vandaag", noScheduleLabel: "Geen schema vandaag",
      awaiting: "Wachten op volgend instelpunt", since: "sinds {t}", at: "om",
      noMore: "geen wijzigingen meer vandaag", openScheduler: "planner openen",
      loading: "Nimbus Climate Scheduler wordt geladen",
      notFound: "Entiteit niet gevonden: {e}" },
    de: { heating: "Heizen", cooling: "Kühlen", off: "Aus", idle: "Inaktiv",
      holding: "hält {t}", scheduleOff: "Zeitplan aus", scheduleOffLabel: "Zeitplan aus",
      noSchedule: "kein Zeitplan heute", noScheduleLabel: "Kein Zeitplan heute",
      awaiting: "Warte auf nächsten Sollwert", since: "seit {t}", at: "um",
      noMore: "keine weiteren Änderungen heute", openScheduler: "Planer öffnen",
      loading: "Nimbus Climate Scheduler wird geladen",
      notFound: "Entität nicht gefunden: {e}" },
  };
  const getT = (hass) => TRANSLATIONS[(hass?.language || "en").split("-")[0]] || TRANSLATIONS.en;

  class NimbusClimateSchedulerCard extends HTMLElement {
    setConfig(config) {
      if (!config) throw new Error("nimbus-climate-scheduler-card: config is required");
      // Accept a single `entity` or a list of `entities` (each a string or {entity, name}).
      const raw = Array.isArray(config.entities) && config.entities.length
        ? config.entities
        : (config.entity ? [{ entity: config.entity, name: config.name }] : []);
      const entities = raw
        .map((e) => (typeof e === "string" ? { entity: e } : { entity: e?.entity, name: e?.name }))
        .filter((e) => e.entity);
      if (!entities.length) throw new Error("nimbus-climate-scheduler-card: 'entity' or 'entities' is required");
      this._config = { ...config };
      this._entities = entities;
      if (this._activeIndex == null || this._activeIndex >= entities.length) this._activeIndex = 0;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._render(); // paint the themed shell now, even before hass, to avoid a FOUC
    }

    set hass(hass) {
      this._hass = hass;
      this._maybeFetchZones();
      this._render();
    }
    get hass() { return this._hass; }

    connectedCallback() {
      this._maybeFetchZones();
      this._timer = setInterval(() => {
        this._maybeFetchZones(); // own REFRESH_SCHEDULE_MS guard — refetches at most every 5 min
        this._render();
      }, TICK_MS);
    }
    disconnectedCallback() {
      if (this._timer) clearInterval(this._timer);
      if (this._retryTimer) clearTimeout(this._retryTimer);
      this._timer = null;
      this._retryTimer = null;
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
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._render();
      } catch (err) {
        // The integration can finish loading after Lovelace. Keep the card in
        // a truthful loading state and retry quickly instead of rendering a
        // false "schedule off" state or leaving an HA error card behind.
        if (!this._zones && !this._retryTimer) {
          this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._maybeFetchZones();
          }, INITIAL_RETRY_MS);
        }
      } finally {
        this._fetching = false;
      }
    }

    _model(ent) {
      if (!this._zones) return { loading: true };
      const hass = this._hass;
      const st = hass?.states?.[ent.entity];
      if (!st) return { error: true, notFound: ent.entity };
      const a = st.attributes || {};
      const name = ent.name || a.friendly_name || ent.entity;
      const room = a.current_temperature;

      const zone = this._zones?.[ent.entity];
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
      if (!this._config) return;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });

      const STYLE = `
        <style>
          *{ box-sizing:border-box; }
          :host{
            --nb-surface:#1b1d22; --nb-surface-2:#232529; --nb-surface-3:#2a2c32;
            --nb-line:rgba(255,255,255,.06); --nb-line-2:rgba(255,255,255,.10);
            --nb-ink:#ecebe7; --nb-ink-2:#c2c0bb; --nb-ink-3:#8a8884; --nb-ink-4:#5e5d59;
          }
          .ncs-tabs{ display:flex; gap:4px; padding:3px; margin:0 0 10px; background:rgba(255,255,255,.025);
            border:1px solid var(--nb-line); border-radius:14px; width:fit-content; max-width:100%; overflow-x:auto; }
          .ncs-tab{ appearance:none; border:0; cursor:pointer; display:inline-flex; align-items:center; padding:6px 11px;
            border-radius:10px; background:transparent; color:var(--nb-ink-3); font:600 12px/1 inherit; white-space:nowrap;
            transition:color .2s, background .2s; }
          .ncs-tab:hover{ color:var(--nb-ink-2); }
          .ncs-tab.is-active{ background:var(--nb-surface-2); color:var(--nb-ink);
            box-shadow:0 1px 0 rgba(255,255,255,.04) inset, 0 1px 2px rgba(0,0,0,.25); }
          ha-card{ display:block;
            background: linear-gradient(180deg, var(--nb-surface) 0%, #181a1e 100%);
            color: var(--nb-ink);
            border: 1px solid var(--nb-line-2);
            border-radius: 20px;
            box-shadow: none;
          }
          .wrap{ padding:18px 20px 16px; container-type:inline-size; font-family: var(--ha-card-header-font-family, var(--mdc-typography-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)); }
          .head{ display:flex; justify-content:space-between; align-items:center; gap:12px; }
          .id{ display:flex; align-items:center; gap:12px; min-width:0; }
          .avatar{ width:40px; height:40px; border-radius:13px; flex:none; display:grid; place-items:center;
            color:var(--accent); border:1px solid color-mix(in oklch, var(--accent) 35%, transparent);
            background: radial-gradient(120% 120% at 30% 20%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 70%), var(--nb-surface-3); }
          .avatar svg{ width:20px; height:20px; }
          .name-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
          .name{ font-size:16px; font-weight:600; letter-spacing:-.01em; color:var(--nb-ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .pill{ flex:none; display:inline-flex; align-items:center; gap:6px; padding:5px 10px 5px 8px; border-radius:99px;
            background: color-mix(in oklch, var(--accent) 14%, transparent); color:var(--accent);
            border:1px solid color-mix(in oklch, var(--accent) 25%, transparent);
            font-size:11px; font-weight:600; line-height:1; letter-spacing:.04em; text-transform:uppercase; }
          .pill-dot{ width:5px; height:5px; border-radius:99px; background:var(--accent); flex:none; }
          .sub{ margin-top:3px; font-size:11px; font-weight:500; color:var(--nb-ink-3); }
          .temp{ font-size:34px; font-weight:300; line-height:.9; letter-spacing:-.02em; text-align:right; color:var(--nb-ink); flex:none; }
          .track{ position:relative; height:36px; border-radius:9px; display:flex; overflow:visible; }
          .seg{ display:flex; align-items:center; padding-left:12px; }
          .seg span{ font-size:13px; font-weight:700; color:rgba(0,0,0,.6); }
          .seam{ width:3px; background: var(--nb-surface); }
          .marker{ position:absolute; top:-5px; bottom:-5px; width:2px; background:#fff; box-shadow:0 0 0 1.5px rgba(0,0,0,.55); border-radius:2px; z-index:3; }
          .bubble{ position:absolute; bottom:calc(100% + 6px); transform:translateX(-50%); z-index:4;
            background: var(--nb-surface-3); color: var(--nb-ink);
            border:1px solid var(--nb-line-2);
            box-shadow:0 1px 4px rgba(0,0,0,.4); font-size:11px; font-weight:600; line-height:1;
            padding:4px 7px; border-radius:6px; white-space:nowrap; }
          .caret{ position:absolute; transform:translateX(-50%); bottom:calc(100% + 1px); z-index:4;
            width:0; height:0; border-left:5px solid transparent; border-right:5px solid transparent;
            border-top:5px solid var(--nb-surface-3); }
          .axis{ position:relative; height:14px; margin-top:7px; font-size:10px; color:var(--nb-ink-3); }
          .axis .l{ position:absolute; left:0; }
          .axis .c{ position:absolute; transform:translateX(-50%); font-weight:600; }
          .flat{ height:36px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--nb-ink-3); }
          .hatch{ background: repeating-linear-gradient(45deg, var(--nb-line-2), var(--nb-line-2) 6px, transparent 6px, transparent 12px); border:1px dashed var(--nb-line-2); }
          .neutral{ background: var(--nb-surface-2); }
          .loading-state{ min-height:78px; display:flex; align-items:center; justify-content:center;
            color:var(--nb-ink-3); font-size:12px; font-weight:500; letter-spacing:.01em; }
          .loading-dots{ display:inline-flex; width:1.4em; margin-left:1px; text-align:left; }
          .loading-dot{ opacity:0; }
          .loading-dot:nth-child(1){ animation:ncs-dot-1 1.4s infinite; }
          .loading-dot:nth-child(2){ animation:ncs-dot-2 1.4s infinite; }
          .loading-dot:nth-child(3){ animation:ncs-dot-3 1.4s infinite; }
          @keyframes ncs-dot-1{ 0%,14%,90%,100%{opacity:0} 20%,85%{opacity:1} }
          @keyframes ncs-dot-2{ 0%,34%,90%,100%{opacity:0} 40%,85%{opacity:1} }
          @keyframes ncs-dot-3{ 0%,54%,90%,100%{opacity:0} 60%,85%{opacity:1} }
          .open{ position:absolute; right:0; top:0; font-size:10px; color:var(--nb-ink-4); cursor:pointer; letter-spacing:.05em; text-transform:uppercase; transition:color .2s; }
          .open:hover{ color:var(--nb-ink-2); }
          .open-icon{ display:none; line-height:1; letter-spacing:0; top:-4px; }
          .open-icon ha-icon{ width:16px; height:16px; --mdc-icon-size:16px; }
          @media (prefers-reduced-motion: reduce){
            .loading-dot{ animation:none !important; opacity:1; }
          }
          @container (max-width: 430px){
            .open-text{ display:none; }
            .open-icon{ display:block; }
          }
        </style>`;

      // Paint the themed shell immediately, before hass arrives, so the card
      // never flashes the default (transparent) ha-card on first load/refresh.
      if (!this._hass) {
        this.shadowRoot.innerHTML = STYLE + `<ha-card><div class="wrap" style="min-height:78px"></div></ha-card>`;
        return;
      }

      const activeEnt = this._entities[this._activeIndex] || this._entities[0];
      const m = this._model(activeEnt);
      const t = getT(this._hass);

      let body;
      if (m.loading) {
        body = `<div class="wrap"><div class="loading-state">${t.loading}<span class="loading-dots" aria-hidden="true"><span class="loading-dot">.</span><span class="loading-dot">.</span><span class="loading-dot">.</span></span></div></div>`;
      } else if (m.error) {
        body = `<div class="wrap"><div class="flat neutral">${t.notFound.replace("{e}", esc(m.notFound))}</div></div>`;
      } else {
        const metaKey = m.state === "off" ? "off" : (m.mode || "off");
        const meta = MODE_META[metaKey] || MODE_META.off;
        const accent = meta.accent;
        const modeLabel = m.state === "off" ? t.off : m.state === "idle" ? t.idle : m.mode === "cool" ? t.cooling : t.heating;

        let status;
        if (m.state === "off") status = t.scheduleOff;
        else if (m.state === "idle") status = t.noSchedule;
        else {
          const sp = m.cur?.temp;
          if (sp != null && m.room != null) {
            const d = sp - m.room;
            status = ((m.mode === "heat" && d > 0.2) || (m.mode === "cool" && d < -0.2)) ? `→ ${fmtTemp(sp)}` : t.holding.replace("{t}", fmtTemp(sp));
          } else status = "";
        }

        const pill = `<span class="pill"><span class="pill-dot"></span>${modeLabel}</span>`;
        // Active state floats a now-bubble above the track — give it clearance so it
        // never lands on the avatar/header; off/idle have no bubble, so stay compact.
        const headGap = m.state === "active" ? "34px" : "14px";

        const head = `<div class="head" data-state="${m.state}" style="--accent:${accent}; margin-bottom:${headGap};">
            <div class="id">
              <div class="avatar">${modeIconSvg(meta.icon)}</div>
              <div style="min-width:0;">
                <div class="name-row"><div class="name">${esc(m.name)}</div>${pill}</div>
                <div class="sub">${status}</div>
              </div>
            </div>
            <div class="temp">${fmtTemp(m.room)}</div>
          </div>`;

        const openLink = `<span class="open open-text">${t.openScheduler}</span><span class="open open-icon" aria-label="${t.openScheduler}" role="button"><ha-icon icon="mdi:tune-variant"></ha-icon></span>`;
        let track;
        if (m.state === "off") {
          track = `<div class="flat hatch"></div><div class="axis"><span class="l">${t.scheduleOffLabel}</span>${openLink}</div>`;
        } else if (m.state === "idle") {
          track = `<div class="flat neutral">${t.noScheduleLabel}</div><div class="axis"><span class="l">${t.awaiting}</span>${openLink}</div>`;
        } else {
          const curColor = this._colorForTemp(m.cur.temp, m.mode);
          const nextColor = m.hasNext ? this._colorForTemp(m.next.temp, m.mode) : curColor;
          const curW = 64;
          const markerLeft = (m.frac * curW).toFixed(2);

          const nextSeg = m.hasNext
            ? `<div class="seam"></div><div class="seg" style="flex:1; background:${nextColor}; border-radius:0 9px 9px 0;"><span>${fmtTemp(m.next.temp)}</span></div>`
            : "";
          // Line + caret sit exactly on the marker; the bubble is clamped (min-inset)
          // so it never overhangs the card edge — it just shifts right near the start.
          const marker = `<div class="marker" style="left:${markerLeft}%;"></div>
            <div class="bubble" style="left:clamp(28px, ${markerLeft}%, calc(100% - 28px));">${fmtHM(m.nowClock)}</div>
            <div class="caret" style="left:${markerLeft}%;"></div>`;
          const axisRight = m.hasNext
            ? `<span class="c" style="left:${curW}%; color:${nextColor};">${fmtTemp(m.next.temp)} ${t.at} ${fmtHM(m.nextClock)}</span>`
            : `<span class="c" style="left:100%; transform:translateX(-100%);">${t.noMore}</span>`;

          track = `<div class="track">
              <div class="seg" style="flex:0 0 ${curW}%; background:${curColor}; border-radius:9px 0 0 9px;"><span>${fmtTemp(m.cur.temp)}</span></div>
              ${nextSeg}
              ${marker}
            </div>
            <div class="axis"><span class="l">${t.since.replace("{t}", fmtHM(m.curStartClock))}</span>${axisRight}${openLink}</div>`;
        }

        body = `<div class="wrap">${head}${track}</div>`;
      }

      const tabs = this._entities.length > 1
        ? `<div class="ncs-tabs">${this._entities.map((e, i) => {
            const label = e.name || this._hass?.states?.[e.entity]?.attributes?.friendly_name || e.entity;
            return `<button class="ncs-tab ${i === this._activeIndex ? "is-active" : ""}" data-idx="${i}">${esc(label)}</button>`;
          }).join("")}</div>`
        : "";

      this.shadowRoot.innerHTML = STYLE + tabs + `<ha-card>${body}</ha-card>`;

      this.shadowRoot.querySelectorAll(".ncs-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._activeIndex = Number.parseInt(btn.dataset.idx, 10) || 0;
          this._render();
        });
      });

      this.shadowRoot.querySelectorAll(".open").forEach((el) => el.addEventListener("click", () => navigateTo(PANEL_PATH)));
    }
  }

  // --- GUI editor: add/remove zones (tabs), one entry per zone ---------------
  class NimbusClimateSchedulerCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._config = {};
      this._dirty = false;
    }

    setConfig(config) {
      this._config = JSON.parse(JSON.stringify(config || {}));
      // Normalize a single `entity` into the `entities` list the editor edits.
      if (!Array.isArray(this._config.entities)) {
        this._config.entities = this._config.entity
          ? [{ entity: this._config.entity, name: this._config.name }]
          : [];
      }
      delete this._config.entity;
      delete this._config.name;
      if (!this._dirty) this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._maybeFetchZones();
      if (!this._dirty) this._render();
    }

    async _maybeFetchZones() {
      if (!this._hass?.callWS || this._zonesLoaded) return;
      this._zonesLoaded = true;
      try {
        const result = await this._hass.callWS({ type: WS_GET_ZONES });
        this._zoneIds = Object.keys(result?.zones ?? {});
      } catch (err) {
        this._zoneIds = [];
      }
      if (!this._dirty) this._render();
    }

    _dispatch() {
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: this._config }, bubbles: true, composed: true,
      }));
    }

    _area(entityId) {
      const ent = this._hass?.entities?.[entityId];
      const areaId = ent?.area_id ?? (ent?.device_id ? this._hass?.devices?.[ent.device_id]?.area_id : null);
      return areaId ? (this._hass?.areas?.[areaId]?.name || "") : "";
    }

    _render() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      const entities = this._config.entities || [];
      // Candidate zones: the scheduler's own zones if available, else any climate.*
      const zoneIds = (this._zoneIds && this._zoneIds.length)
        ? this._zoneIds
        : (this._hass ? Object.keys(this._hass.states).filter((e) => e.startsWith("climate.")).sort() : []);
      const friendly = (id) => this._hass?.states?.[id]?.attributes?.friendly_name || id;

      this.shadowRoot.innerHTML = `
        <style>
          * { box-sizing: border-box; }
          .ed { font-family: -apple-system, system-ui, sans-serif; }
          select, input { width: 100%; padding: 8px 10px; border-radius: 8px;
            border: 1px solid #2a2c32; background: #131418; color: #ecebe7;
            font-size: 13px; font-family: inherit; outline: none; }
          input:focus, select:focus { border-color: oklch(0.78 0.16 45 / 0.5); }
          .entry { background: #1b1d22; border: 1px solid #2a2c32; border-radius: 14px; margin-bottom: 10px; overflow: hidden; }
          .entry-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #2a2c32; background: #131418; }
          .entry-title { font-size: 13px; font-weight: 600; color: #ecebe7; }
          .entry-sub { font-size: 11px; color: #5e5d59; }
          .entry-head > div:first-child { flex: 1; min-width: 0; }
          .rm-btn { width: 28px; height: 28px; border-radius: 7px; border: 1px solid #2a2c32; background: transparent;
            color: #5e5d59; cursor: pointer; font-size: 13px; display: grid; place-items: center; flex-shrink: 0;
            transition: color .2s, border-color .2s; }
          .rm-btn:hover { color: #ecebe7; border-color: #555; }
          .entry-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
          .field { display: flex; flex-direction: column; gap: 5px; }
          .field-label { font-size: 10px; color: #5e5d59; text-transform: uppercase; letter-spacing: .06em; }
          .add-btn { width: 100%; padding: 11px; border-radius: 12px; border: 1px dashed #2a2c32; background: transparent;
            color: #5e5d59; cursor: pointer; font-size: 13px; transition: color .2s, border-color .2s; }
          .add-btn:hover { color: #ecebe7; border-color: #555; }
          .hint { font-size: 12px; color: #5e5d59; margin-top: 8px; }
        </style>
        <div class="ed">
          ${entities.map((e, i) => {
            const area = this._area(e.entity);
            const display = e.name || area || (e.entity || "").replace("climate.", "") || "Zone";
            const list = zoneIds.includes(e.entity) || !e.entity ? zoneIds : [e.entity, ...zoneIds];
            const opts = list.map((id) => `<option value="${esc(id)}" ${id === e.entity ? "selected" : ""}>${esc(friendly(id))}</option>`).join("");
            return `<div class="entry">
              <div class="entry-head">
                <div>
                  <div class="entry-title">${esc(display)}</div>
                  <div class="entry-sub">${e.entity ? esc(e.entity) : "—"}</div>
                </div>
                <button class="rm-btn" data-remove="${i}" title="Remove">✕</button>
              </div>
              <div class="entry-body">
                <div class="field">
                  <span class="field-label">Zone (climate entity)</span>
                  <select data-idx="${i}" data-field="entity"><option value="">— select —</option>${opts}</select>
                </div>
                <div class="field">
                  <span class="field-label">Display name${area ? ` · area: ${esc(area)}` : ""}</span>
                  <input type="text" data-idx="${i}" data-field="name" value="${esc(e.name || "")}" placeholder="${esc(area) || "shown on the tab"}">
                </div>
              </div>
            </div>`;
          }).join("")}
          <button class="add-btn" id="add-btn">+ Add zone</button>
          ${entities.length > 1 ? `<div class="hint">Multiple zones show as tabs on the card.</div>` : ""}
        </div>`;

      this.shadowRoot.querySelectorAll("select[data-field]").forEach((sel) => {
        sel.addEventListener("change", () => {
          this._config.entities[parseInt(sel.dataset.idx, 10)][sel.dataset.field] = sel.value;
          this._dispatch();
          this._render();
        });
      });

      // Text inputs set _dirty so the config round-trip doesn't re-render and steal focus.
      this.shadowRoot.querySelectorAll('input[type="text"]').forEach((inp) => {
        inp.addEventListener("input", () => {
          this._dirty = true;
          this._config.entities[parseInt(inp.dataset.idx, 10)][inp.dataset.field] = inp.value;
          this._dispatch();
        });
        inp.addEventListener("blur", () => { this._dirty = false; });
      });

      this.shadowRoot.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._config.entities.splice(parseInt(btn.dataset.remove, 10), 1);
          this._dirty = false;
          this._dispatch();
          this._render();
        });
      });

      this.shadowRoot.getElementById("add-btn").addEventListener("click", () => {
        this._config.entities = this._config.entities || [];
        const first = zoneIds[0] || "";
        this._config.entities.push({ entity: first, name: this._area(first) || "" });
        this._dirty = false;
        this._dispatch();
        this._render();
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
