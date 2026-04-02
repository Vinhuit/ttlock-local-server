# TTLock Local for Home Assistant

<p align="center">
  <img src="custom_components/ttlock_local/brands/icon.png" alt="TTLock Local" width="120">
</p>

<p align="center"><strong>Local-first TTLock control for Home Assistant through a lightweight Node.js backend.</strong></p>

<p align="center">
  <a href="https://www.home-assistant.io/">
    <img src="https://img.shields.io/badge/Home%20Assistant-2024.8.0%2B-41BDF5?logo=homeassistant&logoColor=white" alt="Home Assistant">
  </a>
  <a href="https://hacs.xyz/">
    <img src="https://img.shields.io/badge/HACS-Custom%20Integration-41BDF5?logo=homeassistantcommunitystore&logoColor=white" alt="HACS">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="GPL-3.0">
  </a>
  <a href="https://github.com/Vinhuit/ttlock-local-server">
    <img src="https://img.shields.io/badge/Backend-ttlock--local--server-111827" alt="Backend repo">
  </a>
</p>

<p align="center">
  <a href="https://github.com/Vinhuit/ttlock-local-server">
    <img src="https://img.shields.io/badge/Server%20Repo-Setup%20Guide-0F172A" alt="Server repo">
  </a>
  <a href="https://github.com/Vinhuit/ttlock-local-server/blob/main/API.md">
    <img src="https://img.shields.io/badge/Server%20API-Reference-2563EB" alt="API reference">
  </a>
  <a href="https://github.com/Vinhuit/ttlock-local-server/blob/main/DOCKER.md">
    <img src="https://img.shields.io/badge/Docker-Runbook-2496ED?logo=docker&logoColor=white" alt="Docker runbook">
  </a>
</p>

This repository is for the Home Assistant integration only.

All BLE, pairing, Web UI, Docker, and `server.js` backend work lives in:

- [`Vinhuit/ttlock-local-server`](https://github.com/Vinhuit/ttlock-local-server)

## Highlights

| Area | Included |
| --- | --- |
| Lock control | one `lock` entity per saved TTLock device |
| Diagnostics | battery, RSSI, connected, last action, updated |
| Helper actions | refresh monitor and reconnect buttons |
| Transport | local HTTP to the backend, no direct BLE in Home Assistant |
| Config | backend host, port, and poll interval are configurable |

## How It Works

```text
Home Assistant
  -> custom_components/ttlock_local
  -> HTTP
  -> ttlock-local-server
  -> BLE
  -> TTLock device
```

The integration does not speak Bluetooth directly.  
It only reads backend state and sends local HTTP commands to the server.

## Requirements

- Home Assistant `2024.8.0` or newer
- a running backend from:
  - [`ttlock-local-server`](https://github.com/Vinhuit/ttlock-local-server)
- at least one saved or imported lock in the backend

## Install

### HACS

1. Open HACS.
2. Add this repository as a custom integration if needed.
3. Install `TTLock Local`.
4. Restart Home Assistant.

### Manual

Copy this folder into your Home Assistant config:

```text
custom_components/ttlock_local
```

Then restart Home Assistant.

## Configure

After restart:

1. Go to `Settings -> Devices & Services`
2. Click `Add Integration`
3. Search for `TTLock Local`
4. Enter:
   - backend host
   - backend port
   - poll interval

Example:

- host: `192.168.1.50`
- port: `8990`
- poll interval: `10`

You can also change host, port, and poll interval later in the integration options.

## Backend Setup

Backend setup is documented in the server repo:

- [`ttlock-local-server README`](https://github.com/Vinhuit/ttlock-local-server)
- [`ttlock-local-server API.md`](https://github.com/Vinhuit/ttlock-local-server/blob/main/API.md)
- [`ttlock-local-server DOCKER.md`](https://github.com/Vinhuit/ttlock-local-server/blob/main/DOCKER.md)

Before configuring Home Assistant, verify the backend first:

- `GET http://<backend-ip>:8990/api/healthz`
- `GET http://<backend-ip>:8990/api/status`

## Entities

Per lock:

- `lock`
- battery sensor
- RSSI sensor
- connected sensor
- last action sensor
- updated sensor

Global helpers:

- refresh monitor button
- reconnect active lock button

## Troubleshooting

### The integration loads but no locks appear

Usually this means the backend is reachable, but it has no saved locks yet.

Check the backend first:

- does Web UI work?
- does `lockData.json` exist on the backend host?
- can the backend lock/unlock outside Home Assistant?

### Home Assistant can connect, but controls fail

That usually means:

- HTTP is fine
- BLE action failed on the backend side

Check the backend logs in `ttlock-local-server`.

### Only one action is shown in Controls

This is normal Home Assistant behavior for a `lock` entity.  
State details such as `Connected`, `Battery`, `Last Action`, and `Updated` are exposed as separate sensors or entity attributes, not as extra buttons inside the main lock control.

## Repository Scope

This repository should stay focused on:

- Home Assistant integration code
- HACS metadata
- user-facing setup docs for Home Assistant

Anything related to:

- BLE
- TTLock protocol
- Web UI
- `server.js`
- Docker runtime

should be handled in:

- [`Vinhuit/ttlock-local-server`](https://github.com/Vinhuit/ttlock-local-server)

## Support

[![Support via Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/vinh541542)

## License

[GPL-3.0](./LICENSE)
