"""Constants for the TTLock Local integration."""

DOMAIN = "ttlock_local"

CONF_POLL_INTERVAL = "poll_interval"
CONF_WEBUI_NAME = "webui_name"

DEFAULT_NAME = "TTLock Local"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8990
DEFAULT_POLL_INTERVAL = 8

PLATFORMS = ["lock", "sensor", "button"]

DATA_API = "api"
DATA_COORDINATOR = "coordinator"
DATA_LOGGER = "logger"

BUTTON_REFRESH = "refresh_monitor"
BUTTON_RECONNECT = "reconnect_monitor"
