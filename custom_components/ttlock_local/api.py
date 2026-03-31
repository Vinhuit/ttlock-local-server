"""HTTP client for the TTLock Web UI API."""

from __future__ import annotations

from typing import Any

from aiohttp import ClientError, ClientSession


class TTLockLocalApiError(Exception):
    """Raised when the TTLock Local API returns an error."""


class TTLockLocalApiClient:
    """Simple async client for the TTLock Web UI API."""

    def __init__(self, session: ClientSession, host: str, port: int) -> None:
        self._session = session
        self._base_url = f"http://{host}:{port}"

    async def async_health(self) -> dict[str, Any]:
        return await self._request("GET", "/api/healthz")

    async def async_status(self, wake: bool = True) -> dict[str, Any]:
        suffix = "?wake=1" if wake else ""
        return await self._request("GET", f"/api/status{suffix}")

    async def async_select_lock(self, address: str) -> dict[str, Any]:
        return await self._request("POST", "/api/select-lock", {"address": address})

    async def async_unlock(self, address: str) -> dict[str, Any]:
        await self.async_select_lock(address)
        return await self._request("POST", "/api/unlock")

    async def async_lock(self, address: str) -> dict[str, Any]:
        await self.async_select_lock(address)
        return await self._request("POST", "/api/lock")

    async def async_refresh(self) -> dict[str, Any]:
        return await self._request("POST", "/api/refresh")

    async def async_reconnect(self) -> dict[str, Any]:
        return await self._request("POST", "/api/reconnect")

    async def _request(
        self,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        try:
            async with self._session.request(
                method,
                f"{self._base_url}{path}",
                json=json_body,
            ) as response:
                payload = await response.json(content_type=None)
        except (ClientError, TimeoutError, ValueError) as err:
            raise TTLockLocalApiError(str(err)) from err

        if response.status >= 400 or payload.get("ok") is False:
            raise TTLockLocalApiError(payload.get("error") or f"HTTP {response.status}")

        return payload
