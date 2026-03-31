# TTLock Local / ttlock-sdk-js

[![Node.js](https://img.shields.io/badge/Node.js-12%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)
[![Backend](https://img.shields.io/badge/Backend-server.js-111827)](./server.js)
[![Docker](https://img.shields.io/badge/Docker-supported-2496ED?logo=docker&logoColor=white)](./DOCKER.md)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-custom__component-41BDF5?logo=homeassistant&logoColor=white)](./custom_components/ttlock_local)

Local-first TTLock tooling built on top of an unofficial JavaScript port of the TTLock Android SDK.

This repository now serves three related purposes:

- a reusable JavaScript/TypeScript TTLock SDK
- a local Web UI + HTTP backend powered by [`server.js`](./server.js)
- integration pieces for Home Assistant and Android local control

Support the project:

- Ko-fi: <https://ko-fi.com/vinh541542>

## At a Glance

| Area | What it gives you |
| --- | --- |
| SDK | TTLock protocol implementation in TypeScript |
| Web UI | local browser control for locks, fingerprints, passcodes, and pairing |
| `server.js` | HTTP backend for the Web UI and Home Assistant |
| Docker | backend deployment on a dedicated BLE host |
| Home Assistant | entities driven by the local backend |

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
- expose a simple local HTTP API for Web UI and Home Assistant

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

The Home Assistant custom integration lives in:

- [`custom_components/ttlock_local`](./custom_components/ttlock_local)

It talks to the local Web UI backend over HTTP and creates Home Assistant entities from the backend state.

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
- Home Assistant custom integration

## Requirements

- Node.js 12 or newer
- a working Bluetooth adapter
- a platform supported by [`@abandonware/noble`](https://github.com/abandonware/noble)

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

The current backend uses these environment variables:

- `PORT`
  - default: `8990`
- `TTLOCK_WEBUI_IDLE_TIMEOUT_MS`
  - default: `15000`
- `BLE_HCI_DEVICE`
  - convenience alias for `NOBLE_HCI_DEVICE_ID`
- `NOBLE_HCI_DEVICE_ID`
  - choose a BLE adapter

Example:

```bash
PORT=8990 TTLOCK_WEBUI_IDLE_TIMEOUT_MS=30000 node server.js
```

## Test the Backend First

Before debugging UI or Home Assistant, verify the backend directly.

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

If these fail, fix the backend first before touching Home Assistant.

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

### Build

```bash
docker build -t ttlock-local-webui:latest .
```

### Run

```bash
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  -e PORT=8990 \
  -v ttlock_local_data:/data \
  ttlock-local-webui:latest
```

Notes:

- BLE in Docker usually needs `--privileged`
- `--network host` is the simplest deployment
- `/data` stores persistent files

## Common CLI Examples

These commands use the SDK examples in [`examples`](./examples).

### Init / Pair

```bash
npm run init
```

### Lock / Unlock / Status

```bash
npm run unlock
npm run lock
npm run status
```

### Passage Mode

```bash
npm run set-passage
npm run get-passage
npm run delete-passage
npm run clear-passage
```

### Passcodes

```bash
npm run add-passcode
npm run update-passcode
npm run delete-passcode
npm run clear-passcodes
npm run get-passcodes
```

### Fingerprints

```bash
npm run add-fingerprint
npm run get-fingerprints
npm run clear-fingerprints
```

### Cards

```bash
npm run add-card
npm run add-card-batch
npm run get-cards
npm run clear-cards
```

### Other

```bash
npm run set-autolock
npm run set-remoteunlock
npm run delete-locksound
npm run get-operations
npm run listen
```

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

It is not perfect real-time telemetry, but it is enough for local monitoring workflows.

## Home Assistant

A HACS/custom integration is included in:

- [`custom_components/ttlock_local`](./custom_components/ttlock_local)

That integration does not embed BLE in Python. It expects the Node backend to already be running and reachable.

Typical flow:

1. run `server.js` on a BLE-capable host
2. verify `http://<host>:8990/api/healthz`
3. install the integration in Home Assistant
4. connect Home Assistant to that backend

## Screenshots

README is ready for screenshots, but I have not added static UI screenshots here yet because there is no clean checked-in Web UI / Android capture asset in the repo right now.

When you have final screenshots, the best place is:

- `docs/assets/webui-overview.png`
- `docs/assets/android-control.png`

## Debug Options

- `TTLOCK_IGNORE_CRC=1`
  - ignore CRC errors on messages from the lock
- `TTLOCK_DEBUG_COMM=1`
  - log raw communication
- `WEBSOCKET_DEBUG=1`
- `WEBSOCKET_ENABLE=1`
- `WEBSOCKET_HOST=127.0.0.1`
- `WEBSOCKET_PORT=2846`

Example websocket mode:

```bash
WEBSOCKET_ENABLE=1 WEBSOCKET_HOST=192.168.1.42 npm run get-cards
```

## Known Issues

- pairing can fail intermittently
- BLE signal quality is often the main source of instability
- some commands may show repeatable bad CRC that needs tolerant handling
- some validity-edit flows are still incomplete or awkward
- protocol coverage is focused on TTLock V3 devices

## Development Status

This repo is actively used as a practical local-control toolbox, not just a pure SDK snapshot.

That means:

- the SDK layer keeps evolving
- the Web UI/backend may add routes and behavior
- Android local control and Home Assistant support may move faster than polished docs

## Credits

- [Valentino Stillhardt (@Fusseldieb)](https://github.com/Fusseldieb) for initial protocol analysis and remote testing support

## License

[GPL-3.0](./LICENSE)
