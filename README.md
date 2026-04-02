# TTLock Local / ttlock-sdk-js

[![Node.js](https://img.shields.io/badge/Node.js-12%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)
[![Backend](https://img.shields.io/badge/Backend-server.js-111827)](./server.js)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](./DOCKER.md)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-separate__repo-41BDF5?logo=homeassistant&logoColor=white)](https://github.com/Vinhuit/ttlock-local-hass)

Local-first TTLock tooling built on top of an unofficial JavaScript port of the TTLock Android SDK.

This repository now serves the local backend and SDK side:

- a reusable JavaScript/TypeScript TTLock SDK
- a local Web UI + HTTP backend powered by [`server.js`](./server.js)
- Linux BLE handling through BlueZ D-Bus

Support the project:

- Ko-fi: <https://ko-fi.com/vinh541542>

## At a Glance

| Area | What it gives you |
| --- | --- |
| SDK | TTLock protocol implementation in TypeScript |
| Web UI | local browser control for locks, fingerprints, passcodes, and pairing |
| `server.js` | HTTP backend for the Web UI and other local clients |
| Docker | backend deployment on a dedicated BLE host |
| Linux BLE | BlueZ D-Bus discovery and connect path |

## What This Repo Is

TTLock Local is meant for users who want to control TTLock devices without depending entirely on the official cloud app flow.

The local backend can:

- scan and initialize locks
- lock and unlock
- read lock status
- manage fingerprints
- manage passcodes
- manage passage mode
- fetch operation logs
- expose a simple local HTTP API for Web UI and local integrations

## Main Components

### 1. SDK

The SDK lives in [`src`](./src) and provides the protocol implementation for TTLock V3 devices.

Use this if you want to:

- script TTLock operations yourself
- build your own Node.js automation
- extend support for more TTLock features

### 2. Local Web UI + Backend

The local backend is started with:

- [`server.js`](./server.js)
- [`monitor.js`](./monitor.js)

The Web UI lives in:

- [`public`](./public)

This is the main local control surface for:

- pairing / init
- selecting locks
- lock and unlock
- fingerprints
- passcodes
- passage mode
- activity / state

### 3. Home Assistant

The Home Assistant custom integration is in a separate repository:

- [`Vinhuit/ttlock-local-hass`](https://github.com/Vinhuit/ttlock-local-hass)

## Current Feature Coverage

Implemented in this repo:

- discover locks
- initialize and pair locks
- reset to factory defaults
- lock / unlock
- get current lock status
- set/get auto lock time
- add/get/delete/clear passage mode
- add/update/delete/clear passcodes
- add/get/delete/clear fingerprints
- add/get/clear IC cards
- read operation logs
- monitor lock advertising state and event bits
- Web UI for local browser control
- Docker packaging for backend deployment

## Linux Only

This backend is currently Linux-first.

The Docker and BlueZ D-Bus setup in this repository is intended for Linux hosts only.

If you want a Windows-oriented workflow, use the upstream project instead:

- [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## Requirements

- Node.js 12 or newer
- a working Bluetooth adapter
- a Linux host supported by BlueZ

Known good targets for this kind of setup:

- Raspberry Pi
- Linux mini PC
- Intel NUC
- another always-on local machine with BLE

## Quick Start

### Install dependencies

```bash
npm install
```

### Build the SDK

```bash
npm run build
```

### Start the local Web UI/backend

```bash
npm run webui
```

Default backend URL:

```text
http://localhost:8990
```

## Backend Files and Persistence

Important backend files:

- [`server.js`](./server.js)
- [`monitor.js`](./monitor.js)
- [`lockData.json`](./lockData.json)
- `state.json`

Runtime data:

- `lockData.json`
  - saved lock credentials and local cache
- `state.json`
  - runtime monitor state

If you care about not losing keys, back up `lockData.json`.

## Backend Environment Variables

Common backend variables:

- `PORT`
  - default: `8990`
- `TTLOCK_WEBUI_IDLE_TIMEOUT_MS`
- `TTLOCK_SCANNER_TYPE`
  - use `bluez-dbus` on Linux
- `BLUEZ_ADAPTER`
  - example: `hci0`
- `BLUEZ_SCAN_MODE`
  - example: `le-all`

Full Docker-oriented examples are documented in:

- [`DOCKER.md`](./DOCKER.md)
- [`.env.example`](./.env.example)

## Test the Backend First

Before debugging UI or integrations, verify the backend directly.

### Health

```text
GET /api/healthz
```

Expected:

```json
{ "ok": true }
```

### Status

```text
GET /api/status
```

### Wake + status

```text
GET /api/status?wake=1
```

## Server API

The server routes are documented in:

- [`API.md`](./API.md)

Main route groups:

- health and status
- init / pair
- lock actions
- fingerprints
- passcodes
- passage mode

## Docker

Docker support is included.

See:

- [`Dockerfile`](./Dockerfile)
- [`DOCKER.md`](./DOCKER.md)

## Pairing Notes

Pairing is the least stable part of the flow.

For best results:

- reset the lock to factory defaults first
- wake the lock just before scanning
- keep the BLE host close, but not pressed against the lock
- if init fails, try again

On many locks, a hardware reset button exists on the exterior assembly:

- short press: reboot
- long press: factory reset

## Monitoring and Events

The backend can monitor advertising data and infer state changes from the params byte.

Relevant bits:

```text
0000 0000
|||| ||||__ (  1) isUnlock
|||| |||___ (  2) new operation log events
|||| ||____ (  4) isSettingMode
|||| |_____ (  8) isTouch
||||_______ ( 16) parkStatus
```

This is useful for:

- detecting lock/unlock state changes
- knowing when operation logs should be refreshed

## Related Repositories

- Home Assistant integration:
  [`Vinhuit/ttlock-local-hass`](https://github.com/Vinhuit/ttlock-local-hass)
- Upstream SDK base:
  [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## License

[GPL-3.0](./LICENSE)
