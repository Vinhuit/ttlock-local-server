# TTLock Local

Home Assistant custom integration for the `ttlock-sdk-js` Web UI API.

This integration talks to the existing local Web UI/server:

- `GET /api/status`
- `POST /api/select-lock`
- `POST /api/unlock`
- `POST /api/lock`
- `POST /api/refresh`
- `POST /api/reconnect`

It is intended for HACS custom integration use and does not embed the BLE stack in Python.
