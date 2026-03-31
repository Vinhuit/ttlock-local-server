"""Shared entity helpers for TTLock Local."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import TTLockLocalCoordinator
from .const import DOMAIN


class TTLockLocalCoordinatorEntity(CoordinatorEntity[TTLockLocalCoordinator]):
    """Base class for coordinator-backed TTLock Local entities."""

    def _managed_locks(self) -> list[dict[str, Any]]:
        return list(self.coordinator.data.get("managed_locks", [])) if self.coordinator.data else []

    def _lock_state(self, address: str) -> dict[str, Any] | None:
        normalized = address.upper()
        for item in self._managed_locks():
            if str(item.get("address", "")).upper() == normalized:
                return item
        return None

    @staticmethod
    def lock_display_name(lock_state: dict[str, Any]) -> str:
        return str(lock_state.get("name") or lock_state.get("address") or "TTLock")

    def build_device_info(self, address: str, name: str) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, address.upper())},
            manufacturer="TTLock",
            model="Local BLE Lock",
            name=name,
        )
