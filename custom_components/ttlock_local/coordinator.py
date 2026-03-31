"""Coordinator for TTLock Local data."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import TTLockLocalApiClient, TTLockLocalApiError
from .const import DATA_LOGGER, DOMAIN


class TTLockLocalCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Poll the TTLock Local Web UI state."""

    def __init__(
        self,
        hass: HomeAssistant,
        api: TTLockLocalApiClient,
        poll_interval: int,
    ) -> None:
        super().__init__(
            hass,
            logger=hass.data[DOMAIN][DATA_LOGGER],
            name=DOMAIN,
            update_interval=timedelta(seconds=poll_interval),
        )
        self.api = api

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            return await self.api.async_status(wake=True)
        except TTLockLocalApiError as err:
            raise UpdateFailed(str(err)) from err
