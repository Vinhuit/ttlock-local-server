"""Button platform for TTLock Local."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import BUTTON_RECONNECT, BUTTON_REFRESH, DATA_API, DATA_COORDINATOR, DOMAIN
from .entity import TTLockLocalCoordinatorEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up TTLock buttons."""
    runtime = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            TTLockLocalActionButton(
                runtime[DATA_COORDINATOR],
                runtime[DATA_API],
                entry.entry_id,
                BUTTON_REFRESH,
                "Refresh Monitor",
            ),
            TTLockLocalActionButton(
                runtime[DATA_COORDINATOR],
                runtime[DATA_API],
                entry.entry_id,
                BUTTON_RECONNECT,
                "Reconnect Active Lock",
            ),
        ]
    )


class TTLockLocalActionButton(TTLockLocalCoordinatorEntity, ButtonEntity):
    """Button entity for monitor-level actions."""

    _attr_should_poll = False
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator, api, entry_id: str, key: str, name: str) -> None:
        super().__init__(coordinator)
        self._api = api
        self._action_key = key
        self._attr_unique_id = f"{DOMAIN}_{entry_id}_{key}"
        self._attr_name = name

    @property
    def device_info(self):
        return {
            "identifiers": {(DOMAIN, "webui")},
            "name": "TTLock Local Web UI",
            "manufacturer": "TTLock",
            "model": "Web UI API",
        }

    async def async_press(self) -> None:
        if self._action_key == BUTTON_REFRESH:
            await self._api.async_refresh()
        else:
            await self._api.async_reconnect()
        await self.coordinator.async_request_refresh()
