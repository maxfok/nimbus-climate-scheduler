DOMAIN = "nimbus_climate_scheduler"

CONF_CLIMATES = "climates"
CONF_ENTITY = "entity"
CONF_NAME = "name"
CONF_SCAN_INTERVAL = "scan_interval"
DEFAULT_SCAN_INTERVAL = 30
STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

PANEL_URL = "nimbus-climate-scheduler"
PANEL_TITLE = "Climate Schedule"
PANEL_ICON = "mdi:tune-variant"
PANEL_COMPONENT_NAME = "nimbus-climate-scheduler-panel"
PANEL_JS_FILENAME = "nimbus-climate-scheduler-panel.js"
CARD_JS_FILENAME = "nimbus-climate-scheduler-card.js"
FRONTEND_PATH = f"/{DOMAIN}/frontend"
PANEL_MODULE_URL = f"{FRONTEND_PATH}/{PANEL_JS_FILENAME}"
CARD_MODULE_URL = f"{FRONTEND_PATH}/{CARD_JS_FILENAME}"
