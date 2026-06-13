# Nimbus Climate Scheduler — Change Log

## 2026-06-10 · Integration review fixes (v0.1.0)

### Κρίσιμα

- **`__init__.py`: καθαρή καταχώρηση panel.** Αφαιρέθηκε το `inspect.signature`
  hack που περνούσε ταυτόχρονα `module_url`, `js_url` και `js_url_path` στο
  `panel_custom.async_register_panel` — το frontend του HA φόρτωνε το ίδιο
  αρχείο και ως ES module και ως classic script. Πλέον περνάει μόνο
  `module_url`. Ο guard `_panel_custom_is_already_registered` διατηρήθηκε.

### Σημαντικά

- **`__init__.py`: τα `climates` από το YAML περνούν στο panel config.**
  Το frontend (`getConfiguredClimates`) διαβάζει `panel.config.climates`·
  πριν, το integration έστελνε μόνο `{"domain": ...}` και το panel έπεφτε
  σε auto-discovery όλων των `climate.*`.
- **`scheduler.py`: safety fix στο `build_plan`.** Ζώνη με απενεργοποιημένο
  schedule (`activeScheduleMode: null`) ΔΕΝ σβήνει πλέον τον θερμοστάτη σε
  κάθε tick (κάθε 30s). "Schedule off" σημαίνει "μην αγγίζεις το χειροκίνητο
  control", όχι "κράτα τον θερμοστάτη κλειστό". Το ρητό "off" από το toggle
  του panel (ενέργεια χρήστη, μία φορά) παραμένει.
- **Μετάβαση loader: το panel σερβίρεται πλέον από το integration.**
  Αφαιρέθηκε το `panel_custom:` block από το `configuration.yaml`· η λίστα
  climates μεταφέρθηκε στο `nimbus_climate_scheduler:` domain config.
  Το integration σερβίρει το frontend από
  `/nimbus_climate_scheduler/frontend/` με `cache_headers=False`
  (επιβεβαιωμένο: κανένα Cache-Control header) — **τέλος τα `?v=N` bumps
  και τα restarts για κάθε αλλαγή frontend**· αρκεί reload του browser.

### Δευτερεύοντα

- **`manifest.json`:** προστέθηκε το `websocket_api` στα dependencies (το
  χρησιμοποιεί το `websocket.py` αλλά δεν δηλωνόταν), `codeowners:
  ["@maxfok"]`, διόρθωση GitHub URLs (max-fok → maxfok), version 0.0.1 → 0.1.0.
- **`deploy.sh`:** νέο script — μία πηγή αλήθειας (worktree), ένα βήμα deploy
  σε scaffold → HA custom_components → www (rollback copy). Λύνει το πρόβλημα
  των 4 ασυγχρόνιστων αντιγράφων που μας δάγκωσε δύο φορές σήμερα.

### Deploy / Επαλήθευση

- Όλα τα αρχεία συγχρονίστηκαν (scaffold ↔ HA), `py_compile`/`node --check` OK.
- HA restart 17:22 — το integration φόρτωσε χωρίς κανένα error στο log.
- `/nimbus_climate_scheduler/frontend/*` → 200 χωρίς cache headers·
  panel page → 200. Το `www/` + `/local/` path παραμένει μόνο ως rollback.

### Rollback (αν χρειαστεί)

Επαναφορά του block στο `configuration.yaml`:

```yaml
panel_custom:
  - name: nimbus-climate-scheduler-panel
    url_path: nimbus-climate-scheduler
    sidebar_title: Climate Schedule
    sidebar_icon: mdi:calendar-clock
    module_url: /local/nimbus_climate_scheduler/nimbus-climate-scheduler-panel.js?v=18
    config:
      domain: nimbus_climate_scheduler
      climates: [...]
```

(το integration ανιχνεύει το panel_custom και δεν ξανακαταχωρεί το panel)

---

## Νωρίτερα σήμερα (context)

- Single source of truth για το `scheduleMode` (store entry + getter στα
  zone objects) — διόρθωσε το flip-flop Heating↔Cooling από stale closures.
- Render gating με signature + προστασία ανοιχτού `<select>`/drag από τα
  συνεχή hass updates — διόρθωσε το "δεν γυρνάει σε Cooling".
- `temperature: null` → λογικό default 20° (αντί για 0°).
- styles.css κληρονομεί το `?v=` του module (πλέον αχρείαστο με το
  integration loader, αλλά αβλαβές).
- Παράλληλη session: backend (store/scheduler/websocket) + frontend wiring
  (`callWS get_zones/save_zone`, fallback frontend scheduler, apply preview).

## 2026-06-10 (απόγευμα) · Λειτουργικότητα + Αισθητικά

### Λειτουργικά

- **Day-boundary fix (backend + frontend):** η μέρα του προγράμματος τρέχει
  05:00→05:00, αλλά ο scheduler χρησιμοποιούσε την ημερολογιακή μέρα — π.χ.
  Τετάρτη 02:00 εφαρμοζόταν η γραμμή της Τετάρτης αντί για το βραδινό τμήμα
  της Τρίτης. Διορθώθηκε σε `scheduler.py` (get_schedule_point_for_time) και
  `nimbus-climate-scheduler-panel.js` (dayKeyFromDate). Επαληθεύτηκε:
  Wed 02:00 → Tue row, Wed 12:00 → Wed row.
- **End-to-end δοκιμή σε πραγματικό θερμοστάτη (climate.hall_thermostat):**
  save_zone (cool 25°, schedule on) μέσω websocket → ο backend scheduler
  εφάρμοσε cool/25° στη συσκευή σε ~15s → restore (schedule off + manual off)
  → ο θερμοστάτης έμεινε off στο επόμενο tick (το safety fix δουλεύει).
  Το `.storage/nimbus_climate_scheduler` γράφεται κανονικά (5 ζώνες).

### Αισθητικά

- **Heat/Cool pill toggle** αντί για native `<select>` (στυλ prototype):
  πορτοκαλί Heating / κυανό Cooling με glow. Εξαλείφει και ολόκληρη την
  κατηγορία προβλημάτων με το dropdown popup που καταστρεφόταν από re-renders.
- **Narrow/mobile layout:** `narrow` prop του HA + matchMedia(760px) θέτουν
  attribute στο host· μονή στήλη ανά μέρα, συμπαγές header, tick labels ανά
  4 ώρες, wrap σε zone header/actions. Δοκιμασμένο σε 375px viewport.
- **Polish pass:** hover/expand states στις κάρτες ζωνών, animation στο
  άνοιγμα, χρωματιστά chips στο "Schedule now", status dot στο scheduler
  status, hover στα handles και στα day buttons.
- **Guard επέκταση:** το deferred render προστατεύει πλέον και τα number
  inputs των setpoints (όχι μόνο selects), με flush σε focusout.

## 2026-06-10 (βράδυ) · Βήμα 1 roadmap: First-run setup

- **Setup wizard στο panel:** σε πρώτη εκτέλεση (κενό store, χωρίς YAML
  climates) ανοίγει αυτόματα οδηγός: λίστα όλων των `climate.*` με checkbox
  + επεξεργάσιμο όνομα (prefill από friendly_name), "Create zones" φτιάχνει
  default Heat/Cool πρόγραμμα ανά ζώνη και τα αποθηκεύει στο backend.
  Κουμπί **Setup** στο topbar το ξανανοίγει με την τρέχουσα επιλογή
  (πρόδρομος του "Add Zone" του HC3 look).
- **Backend `set_climates` websocket command + Store:** η επιλογή ζωνών
  αποθηκεύεται στο `.storage` (`data.climates`)· ζώνες που αποεπιλέγονται
  χάνουν και το πρόγραμμά τους (συμπεριφορά "delete zone"). Ο scheduler
  λαμβάνει υπόψη και τις store-based ζώνες.
- **Προτεραιότητα πηγών ζωνών στο panel:** επιλογή χρήστη (store) → YAML
  `climates` → auto-discovery. Μη-σπαστικό για το τρέχον setup: μέχρι να
  χρησιμοποιηθεί το Setup, ισχύει το YAML.
- Επαλήθευση: harness (first-run auto-open, rename "Σαλόνι", αποεπιλογή,
  create, reopen με διατήρηση επιλογής) + live `set_climates` στο HA
  (5 ζώνες αποθηκεύτηκαν, τα schedules διατηρήθηκαν).

### Zones με βάση το δωμάτιο (συνέχεια βήματος 1)

- **Default πρόταση ζώνης = το δωμάτιο (HA Area) του θερμοστάτη.** Το wizard
  διαβάζει τα hass.entities/devices/areas registries (area του entity ή του
  device του) και προτείνει το όνομα του δωματίου ως ζώνη· δείχνει και chip
  «📍 <δωμάτιο>» δίπλα στο entity id. Fallback: friendly_name.
- **Ομαδοποίηση σε ζώνες:** θερμοστάτες με το ίδιο όνομα ζώνης γίνονται ΜΙΑ
  ζώνη με κοινό πρόγραμμα — το save γράφει το πρόγραμμα σε κάθε entity της
  ομάδας (ο backend scheduler οδηγεί το καθένα), τα apply/toggle καλούν τις
  υπηρεσίες climate με όλη τη λίστα entity_ids, και η κάρτα δείχνει όλα τα
  entities της ζώνης.
- Επαλήθευση σε harness: 2 TRV στο ίδιο δωμάτιο (ένα με area στο entity, ένα
  μέσω device) + 1 AC σε άλλο → defaults «Living Room», «Living Room»,
  «Kitchen»· δημιουργία → μία ζώνη Living Room με 2 entities· toggle →
  set_hvac_mode/set_temperature και στα δύο. Deploy χωρίς restart (μόνο JS).

### Sidebar menu button (mobile fix)

- Προστέθηκε hamburger (☰) στο header που στέλνει το `hass-toggle-menu`
  event στο HA shell. Εμφανίζεται όταν το panel είναι narrow (κινητό) ή όταν
  το sidebar είναι ρυθμισμένο "always hidden" — πριν, στο κινητό με κρυφό
  sidebar δεν υπήρχε τρόπος να βγεις από το panel. Deploy χωρίς restart.

## 2026-06-11 · Βήμα 2 roadmap (μέρος 1): HC3-style controls

- **Setpoint steppers à la HC3:** κάθε setpoint έχει πλέον εικονίδιο mode
  (🔥 heat / ❄️ cool) + κουμπιά − / + με βήμα 0.5° και clamp 5–35°, μαζί με
  το πληκτρολογήσιμο πεδίο (κρυμμένα τα native spinners).
- **Chevrons στα day rows:** κουμπί ❯ δεξιά σε κάθε μέρα — ανοίγει/κλείνει
  τους setpoint editors (toggle, όπως στο Fibaro), πορτοκαλί και γυρισμένο
  90° στην ενεργή μέρα. Το κλικ σε ήδη ανοιχτή μέρα την κλείνει. Ο guard
  unsaved αλλαγών εξακολουθεί να μπλοκάρει την πλοήγηση σωστά.
- Επαλήθευση σε harness (στεππερς ±0.5, dirty badge, toggle/εναλλαγή ημερών,
  σεβασμός guard) + screenshots. Deploy χωρίς restart (μόνο frontend).

## 2026-06-11 · Βήμα 2 roadmap (μέρος 2): HC3 zone management

- **MANAGE κουμπιά στη γραμμή ζώνης** (όπως η στήλη MANAGE του HC3):
  ✏️ edit (ανοίγει τη ζώνη, σέβεται τον unsaved guard) και 🗑 delete
  (με confirm) που αφαιρεί τη ζώνη και τα προγράμματά της μέσω
  `set_climates`. Διαγραφή της τελευταίας ζώνης ανοίγει ξανά το setup
  wizard αντί να πέσει σε auto-discovery.
- **"Week" shortcut στο Copy schedule for** — επιλέγει όλες τις μέρες
  (αμοιβαία αποκλειόμενο με το "Working days"). Το copy row έγινε flex
  ώστε να χωράει και να αναδιπλώνεται σωστά.
- **"Setup" → "Add Zone"** στο topbar, όπως το κουμπί του HC3.
- Επαλήθευση σε harness: pencil expand, delete με σωστό payload, delete
  τελευταίας ζώνης → wizard, Week → όλα τα checkboxes. Deploy χωρίς restart.

## 2026-06-11 · Βήμα 3 roadmap: Generic release (v0.2.0)

### Μονάδες & όρια από τη συσκευή (°C/°F)

- **Όρια/βήμα ανά συσκευή:** οι steppers και τα inputs σέβονται πλέον τα
  `min_temp`/`max_temp`/`target_temp_step` του εκάστοτε climate entity
  (fallbacks: 5–35°C / 41–95°F, βήμα 0.5).
- **Fahrenheit σε όλη την αλυσίδα:** τα χρωματικά bands των μπαρών, τα
  default προγράμματα (βάση 68°F, setback −4°F, floor 41°F) και το
  heat→cool comfort mapping ορίζονται σε °C και μετατρέπονται για °F
  εγκαταστάσεις — frontend (hass.config.unit_system) και backend
  (hass.config.units.temperature_unit). Επαληθευμένο σε harness με US-style
  install (70°F → lime, 62°F → blue, 76°F → yellow, defaults 70/66 heat,
  77/79 cool, βήμα 1°) και °C regression (αμετάβλητα 21/19, 25/26).

### HC3 polish (τελευταία)

- **Column headers** πάνω από τις ζώνες (Icon/Name/Temp/Mode/Active·Manage),
  κρυφά σε narrow.
- **Per-zone status line** στο σώμα της ζώνης: «ℹ️ All thermostats are
  properly supported» ή «⚠ Unavailable: <entities>» όταν κάποιο entity της
  ζώνης είναι unavailable/unknown.

### Config flow (UI setup)

- Νέο `config_flow.py` (single instance) + `strings.json`/`translations/en`:
  το integration προστίθεται πλέον από Settings → Devices & Services χωρίς
  YAML. Το `__init__.py` αναδιοργανώθηκε σε κοινό `_async_setup_scheduler`
  με υποστήριξη και YAML και config entry χωρίς διπλή εγγραφή, και
  `async_unload_entry` που καθαρίζει panel/scheduler μόνο όταν το entry
  είναι ο ιδιοκτήτης. Δοκιμασμένο live μέσω REST: flow → create_entry →
  διαγραφή entry χωρίς να επηρεαστεί το τρέχον YAML setup (require_restart
  false, panel ζωντανό, κανένα error στο log).

### Packaging

- **hacs.json** (HACS custom repository, min HA 2024.6) και πλήρες **README**
  (features, εγκατάσταση HACS/manual, setup UI/YAML, πώς δουλεύει).
- manifest 0.2.0 με `config_flow: true`. Το deploy.sh αντιγράφει πλέον και
  `config_flow.py`/`strings.json`/`translations/`.
- Μεταφράσεις ελληνικών στο panel: ΕΚΤΟΣ scope κατόπιν απόφασης — προτεραιότητα
  στη σωστή διαχείριση μονάδων (°F) για το release.

### Μετάβαση σε config entry + διανομή

- **YAML → config entry:** δημιουργήθηκε entry μέσω flow, αφαιρέθηκε το
  `nimbus_climate_scheduler:` block από το configuration.yaml, restart
  (μαζί ανέβηκε και το HA core σε 2026.6.2). Επαλήθευση: entry "loaded",
  frontend 200, get_zones → 5 climates + 5 zones από το .storage,
  scheduler ενεργός (last_run). Το setup πλέον ζει εξ ολοκλήρου στο UI.
- **Πακέτο διανομής:** ~/Desktop/nimbus-climate-scheduler-v0.2.0.zip με τον
  φάκελο του integration (χωρίς __pycache__) + ΟΔΗΓΙΕΣ-ΕΓΚΑΤΑΣΤΑΣΗΣ.txt
  στα ελληνικά (3 βήματα: custom_components, restart, Add Integration).

## 2026-06-12 · Save = Apply (κατάργηση του Apply Now)

- **Ρίζα του «διπλού Apply»:** μετά από `set_hvac_mode` το `set_temperature`
  έφευγε άμεσα, πριν η συσκευή αλλάξει mode, οπότε το setpoint πήγαινε στο
  παλιό mode και χανόταν (Z-Wave συμπεριφορά). Προστέθηκε παύση 1s ανάμεσα
  στα δύο calls στο backend (`scheduler.async_apply_plan`) και στο frontend
  fallback (`applyPlan`).
- **Νέο websocket command `apply_now`:** τρέχει αμέσως ένα scheduler tick
  και επιστρέφει ποιες ζώνες εφαρμόστηκαν.
- **Το Save εφαρμόζει πλέον αυτόματα:** Save Heat/Cool, Save ημέρας και το
  toggle ενεργοποίησης σώζουν στο backend (με εγγυημένη σειρά save →
  apply_now) και το πρόγραμμα φτάνει στον θερμοστάτη άμεσα, με banner
  «Applied N». Το toggle OFF και το no-backend fallback κρατούν το άμεσο
  service call.
- **Αφαιρέθηκε το κουμπί Apply Now** (το Preview Apply/dry-run παραμένει).
- Επαλήθευση: harness (σειρά ws calls, banner, toggle on/off paths) + live
  στο climate.hall_thermostat ΜΕ snapshot/restore: ένα apply_now (1.4s)
  πέρασε mode+setpoint με την πρώτη· snapshot επανήλθε ακέραιο.

### Αφαίρεση Preview Apply

- Με το Save=Apply και τη γραμμή «Schedule now» ανά ζώνη, το dry-run
  Preview Apply ήταν πλεονασμός — αφαιρέθηκε κουμπί, section και κώδικας.
  Το topbar έχει πλέον μόνο status + Add Zone (όπως το HC3). Το zip
  διανομής ανανεώθηκε.

## 2026-06-14 · Pre-release review (v0.2.2)

Field validation: father's HA (different thermostat model, non-technical user)
ran v0.2.1 with Save=Apply and reported it working, no issues found.

Backend review fixes before HACS release:
- **Reload-safety:** `async_register_static_paths` is registered once per HA
  run via a sentinel flag — a config-entry reload no longer re-adds the
  (un-removable) static path and crashes with RuntimeError. Panel is removed
  before re-registration too. Live-verified: entry reload → loaded, frontend
  200, no errors.
- **config_flow:** `FlowResult` → `ConfigFlowResult` (with import fallback for
  older cores) — drops a deprecation.
- Bumped to 0.2.2; deployed + HA restart clean.

Pending for release: dedicated `maxfok/nimbus-climate-scheduler` GitHub repo
(clean layout, MIT LICENSE, screenshots), then push. License chosen: MIT.
SECURITY: the nimbus-weather-card git remote has a PAT embedded in the URL —
user advised to revoke it and rely on gh keyring auth.
