"""Sensor platform for TTLock Local."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorDeviceClass, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, SIGNAL_STRENGTH_DECIBELS_MILLIWATT
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DATA_COORDINATOR, DOMAIN
from .entity import TTLockLocalCoordinatorEntity


SENSOR_DESCRIPTIONS = (
    {
        "key": "battery",
        "name": "Battery",
        "unit": PERCENTAGE,
        "device_class": SensorDeviceClass.BATTERY,
        "state_class": SensorStateClass.MEASUREMENT,
        "entity_category": None,
    },
    {
        "key": "rssi",
        "name": "RSSI",
        "unit": SIGNAL_STRENGTH_DECIBELS_MILLIWATT,
        "device_class": SensorDeviceClass.SIGNAL_STRENGTH,
        "state_class": None,
        "entity_category": EntityCategory.DIAGNOSTIC,
    },
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up TTLock sensors."""
    coordinator = hass.data[DOMAIN][entry.entry_id][DATA_COORDINATOR]
    known: set[tuple[str, str]] = set()

    def _async_add_from_coordinator() -> None:
        new_entities: list[TTLockLocalSensor] = []
        for item in coordinator.data.get("managed_locks", []):
            address = str(item.get("address", "")).upper()
            if not address:
                continue
            for description in SENSOR_DESCRIPTIONS:
                key = (address, description["key"])
                if key in known:
                    continue
                known.add(key)
                new_entities.append(TTLockLocalSensor(coordinator, address, description))
        if new_entities:
            async_add_entities(new_entities)

    entry.async_on_unload(coordinator.async_add_listener(_async_add_from_coordinator))
    _async_add_from_coordinator()


class TTLockLocalSensor(TTLockLocalCoordinatorEntity, SensorEntity):
    """TTLock coordinator-backed sensor."""

    _attr_should_poll = False

    def __init__(self, coordinator, address: str, description: dict[str, Any]) -> None:
        super().__init__(coordinator)
        self._address = address
        self.entity_description = None
        self._description = description
        self._attr_unique_id = f"{DOMAIN}_{address.lower()}_{description['key']}"
        self._attr_native_unit_of_measurement = description["unit"]
        self._attr_device_class = description["device_class"]
        self._attr_state_class = description["state_class"]
        self._attr_entity_category = description["entity_category"]

    @property
    def _lock_data(self) -> dict[str, Any] | None:
        return self._lock_state(self._address)

    @property
    def available(self) -> bool:
        return super().available and self._lock_data is not None

    @property
    def name(self) -> str:
        lock_data = self._lock_data or {"address": self._address}
        return f"{self.lock_display_name(lock_data)} {self._description['name']}"

    @property
    def native_value(self):
        lock_data = self._lock_data or {}
        return lock_data.get(self._description["key"])

    @property
    def device_info(self):
        lock_data = self._lock_data or {"address": self._address}
        return self.build_device_info(self._address, self.lock_display_name(lock_data))
