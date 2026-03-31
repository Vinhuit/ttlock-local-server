"""Lock platform for TTLock Local."""

from __future__ import annotations

from typing import Any

from homeassistant.components.lock import LockEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DATA_API, DATA_COORDINATOR, DOMAIN
from .entity import TTLockLocalCoordinatorEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up TTLock lock entities."""
    runtime = hass.data[DOMAIN][entry.entry_id]
    coordinator = runtime[DATA_COORDINATOR]
    api = runtime[DATA_API]
    known: set[str] = set()

    def _async_add_from_coordinator() -> None:
        new_entities: list[TTLockLocalLock] = []
        for item in coordinator.data.get("managed_locks", []):
            address = str(item.get("address", "")).upper()
            if not address or address in known:
                continue
            known.add(address)
            new_entities.append(TTLockLocalLock(coordinator, api, address))
        if new_entities:
            async_add_entities(new_entities)

    entry.async_on_unload(coordinator.async_add_listener(_async_add_from_coordinator))
    _async_add_from_coordinator()


class TTLockLocalLock(TTLockLocalCoordinatorEntity, LockEntity):
    """Representation of a TTLock managed lock."""

    _attr_should_poll = False

    def __init__(self, coordinator, api, address: str) -> None:
        super().__init__(coordinator)
        self._api = api
        self._address = address
        self._attr_unique_id = f"{DOMAIN}_{address.lower()}_lock"

    @property
    def _lock_data(self) -> dict[str, Any] | None:
        return self._lock_state(self._address)

    @property
    def available(self) -> bool:
        return super().available and self._lock_data is not None

    @property
    def name(self) -> str:
        lock_data = self._lock_data or {"address": self._address}
        return self.lock_display_name(lock_data)

    @property
    def is_locked(self) -> bool | None:
        lock_data = self._lock_data
        if lock_data is None:
            return None
        return lock_data.get("is_locked")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        lock_data = self._lock_data or {}
        return {
            "address": self._address,
            "active": lock_data.get("active"),
            "saved": lock_data.get("saved"),
            "discovered": lock_data.get("discovered"),
            "connected": lock_data.get("connected"),
            "rssi": lock_data.get("rssi"),
            "battery": lock_data.get("battery"),
        }

    @property
    def device_info(self):
        return self.build_device_info(self._address, self.name)

    async def async_lock(self, **kwargs: Any) -> None:
        await self._api.async_lock(self._address)
        await self.coordinator.async_request_refresh()

    async def async_unlock(self, **kwargs: Any) -> None:
        await self._api.async_unlock(self._address)
        await self.coordinator.async_request_refresh()
