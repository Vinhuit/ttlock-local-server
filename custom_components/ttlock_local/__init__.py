"""Home Assistant entry point for TTLock Local."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import TTLockLocalApiClient
from .const import (
    CONF_POLL_INTERVAL,
    DATA_API,
    DATA_COORDINATOR,
    DATA_LOGGER,
    DOMAIN,
    PLATFORMS,
)
from .coordinator import TTLockLocalCoordinator


def _entry_value(entry: ConfigEntry, key: str):
    """Return option override or fallback to config entry data."""
    return entry.options.get(key, entry.data[key])


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the TTLock Local integration."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN].setdefault(DATA_LOGGER, logging.getLogger(__name__))

    async def _call_loaded_entries(method_name: str) -> None:
        called = False
        for key, runtime in hass.data.get(DOMAIN, {}).items():
            if key == DATA_LOGGER:
                continue
            await getattr(runtime[DATA_API], method_name)()
            await runtime[DATA_COORDINATOR].async_request_refresh()
            called = True
        if not called:
            raise ValueError("No TTLock Local config entries are loaded")

    async def _handle_refresh(_call: ServiceCall) -> None:
        await _call_loaded_entries("async_refresh")

    async def _handle_reconnect(_call: ServiceCall) -> None:
        await _call_loaded_entries("async_reconnect")

    if not hass.services.has_service(DOMAIN, "refresh_monitor"):
        hass.services.async_register(DOMAIN, "refresh_monitor", _handle_refresh)
    if not hass.services.has_service(DOMAIN, "reconnect"):
        hass.services.async_register(DOMAIN, "reconnect", _handle_reconnect)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up TTLock Local from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN].setdefault(DATA_LOGGER, logging.getLogger(__name__))

    session = async_get_clientsession(hass)
    api = TTLockLocalApiClient(session, _entry_value(entry, "host"), _entry_value(entry, "port"))
    coordinator = TTLockLocalCoordinator(hass, api, _entry_value(entry, CONF_POLL_INTERVAL))
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = {
        DATA_API: api,
        DATA_COORDINATOR: coordinator,
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload a config entry after options change."""
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)
