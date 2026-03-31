# TTLock Local

Home Assistant custom integration for the local `ttlock-sdk-js` Web UI backend.

This integration does not talk to BLE directly. BLE stays in the Node.js backend (`server.js`). Home Assistant calls that backend over HTTP on your local network.

## Architecture

Flow:

1. `server.js` runs on a machine with Bluetooth access
2. that backend manages scan, pair, lock, unlock, fingerprints, passcodes, and state
3. Home Assistant loads `custom_components/ttlock_local`
4. the integration polls the backend and creates Home Assistant entities

Because of this design, the most important part is getting the backend working first.

## What You Need

- Home Assistant
- this custom integration in `custom_components/ttlock_local`
- a machine that can run Node.js and has BLE access
  - Raspberry Pi
  - Linux mini PC
  - another always-on local machine
- the `ttlock-sdk-js` project with `server.js`

## Backend Setup

The Home Assistant integration expects the local Web UI backend from this repo:

- [`server.js`](../../server.js)
- [`monitor.js`](../../monitor.js)

### Option 1: Run `server.js` directly

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Make sure Bluetooth works for Node/noble on that machine.

4. Start the backend:

```bash
node server.js
```

Default URL:

```text
http://<backend-ip>:8990
```

### Option 2: Run with Docker

See:

- [`DOCKER.md`](../../DOCKER.md)

Typical commands:

```bash
docker build -t ttlock-local-webui:latest .
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
- `--network host` is the simplest option
- persistent files are stored in `/data`

## Backend Environment Variables

The backend currently uses these environment variables:

- `PORT`
  - HTTP port for the Web UI/backend
  - default: `8990`
- `TTLOCK_WEBUI_IDLE_TIMEOUT_MS`
  - how long the backend stays active before pausing BLE monitor when the UI is idle
  - default: `15000`
- `BLE_HCI_DEVICE`
  - convenience env var mapped to `NOBLE_HCI_DEVICE_ID`
- `NOBLE_HCI_DEVICE_ID`
  - choose which Bluetooth adapter noble should use

Example:

```bash
PORT=8990 TTLOCK_WEBUI_IDLE_TIMEOUT_MS=30000 node server.js
```

## First Backend Test

Before touching Home Assistant, confirm the backend works by itself.

### Health check

Open:

```text
http://<backend-ip>:8990/api/healthz
```

Expected response:

```json
{ "ok": true }
```

### Status check

Open:

```text
http://<backend-ip>:8990/api/status
```

You should get JSON state from the monitor.

### Pair or import a lock first

The backend needs lock data before Home Assistant can control anything.

You can do that by:

- using the Web UI pair/init flow
- importing an existing `lockData.json`

Persistent lock credentials are stored in:

- `lockData.json`
- `state.json`

If you use Docker, those files live in `/data`.

## Supported Backend API Endpoints

The integration currently uses these endpoints:

- `GET /api/healthz`
- `GET /api/status`
- `POST /api/select-lock`
- `POST /api/unlock`
- `POST /api/lock`
- `POST /api/refresh`
- `POST /api/reconnect`

The backend itself supports more endpoints, but the current Home Assistant integration only uses the subset above.

## Install in Home Assistant

### Manual install

Copy this folder into your Home Assistant config:

```text
custom_components/ttlock_local
```

Then restart Home Assistant.

### HACS install

If you publish the repo with `.hacs.json`, add the repository as a custom HACS integration and install `TTLock Local`.

## Home Assistant Configuration

After restart:

1. Open `Settings`
2. Open `Devices & Services`
3. Click `Add Integration`
4. Search for `TTLock Local`
5. Enter:
   - backend host/IP
   - backend port
   - poll interval

Example:

- host: `192.168.1.50`
- port: `8990`
- poll interval: `10`

## What Entities Are Created

Per lock:

- one `lock` entity
- one battery sensor
- one RSSI sensor

Global helper entities:

- refresh monitor button
- reconnect active lock button

## How Control Works

Important behavior:

- each lock action first selects the target lock on the backend
- then the integration calls `lock` or `unlock`

That means the backend is still the source of truth for:

- current selected lock
- BLE connection lifecycle
- lock state cache

## Troubleshooting

### Health check works, but no locks appear

Likely causes:

- backend has no paired/imported locks yet
- backend cannot discover the lock
- BLE adapter on the backend host is not working correctly

Check:

- Web UI works in browser first
- `lockData.json` exists and contains your lock
- backend logs from `node server.js`

### Home Assistant cannot connect

Check:

- correct host/IP
- correct port
- firewall rules
- Docker networking if backend runs in container

Quick test from another machine:

```text
http://<backend-ip>:8990/api/healthz
```

### Lock entity exists, but commands fail

That usually means:

- backend can answer HTTP
- but BLE action failed on the backend side

So the problem is usually in:

- Bluetooth range
- lock credentials in `lockData.json`
- lock not awake / not discoverable
- backend monitor state

Use:

- Web UI to confirm lock/unlock works first
- backend logs to inspect the real BLE failure

## Recommended Deployment

The most stable layout is:

- `ttlock-sdk-js server.js` on a local BLE-capable host
- Home Assistant on the same LAN
- Home Assistant integration talking to the backend over HTTP

This keeps BLE complexity out of Home Assistant Python and matches how this integration was designed.

## Current Scope

Current Home Assistant integration scope:

- lock control
- battery sensor
- RSSI sensor
- refresh monitor
- reconnect active lock

Future features can be added on top of the same backend:

- passage mode controls
- passcode tools
- fingerprint tools
- reset button
- diagnostics

## Related Files

- [`server.js`](../../server.js)
- [`monitor.js`](../../monitor.js)
- [`DOCKER.md`](../../DOCKER.md)
- [`manifest.json`](./manifest.json)
- [`api.py`](./api.py)
