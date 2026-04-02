# TTLock Local Server

<p align="center">
  <strong>Local-first TTLock backend with Web UI, HTTP API, Docker support, and Linux BlueZ D-Bus BLE handling.</strong>
</p>

<p align="center">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="GPL-3.0">
  </a>
  <a href="./DOCKER.md">
    <img src="https://img.shields.io/badge/Docker-Runbook-2496ED?logo=docker&logoColor=white" alt="Docker runbook">
  </a>
  <a href="./API.md">
    <img src="https://img.shields.io/badge/API-Reference-2563EB" alt="API reference">
  </a>
  <a href="https://github.com/Vinhuit/ttlock-local-hass">
    <img src="https://img.shields.io/badge/Home%20Assistant-Separate%20Repo-41BDF5?logo=homeassistant&logoColor=white" alt="Home Assistant repo">
  </a>
</p>

## Overview

This repository is the backend server only.

It contains:

- Node.js TTLock local server
- Web UI
- local HTTP API
- Docker/Linux runtime
- Linux BLE transport using BlueZ D-Bus

The Home Assistant custom integration lives in a separate repository:

- [`Vinhuit/ttlock-local-hass`](https://github.com/Vinhuit/ttlock-local-hass)

This project is based on:

- [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## Architecture

```text
Web UI / HTTP client
  -> ttlock-local-server
  -> BlueZ D-Bus / BLE
  -> TTLock device
```

On Linux, the preferred BLE path is BlueZ D-Bus.

## Linux Only

This backend is currently Linux-first.

The Docker and BlueZ D-Bus setup in this repository is intended for Linux hosts only.

If you want a Windows-oriented workflow, use the upstream project instead:

- [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## What It Provides

- local lock and unlock actions
- live status, RSSI, battery, and last action state
- browser Web UI
- import/export of `lockData.json`
- Docker runtime for Linux
- D-Bus scanning and connect path for Linux BLE adapters

## Quick Start

Run directly:

```bash
npm install
npx tsc -p tsconfig.json
npm run webui
```

The Web UI listens on:

```text
http://localhost:8990
```

## Docker

Docker usage is documented in:

- [`DOCKER.md`](./DOCKER.md)

Runtime settings can be stored in:

- [`.env.example`](./.env.example)

## API

HTTP endpoints are documented in:

- [`API.md`](./API.md)

Useful checks:

- `GET /api/healthz`
- `GET /api/status`

## Related Repositories

- Home Assistant integration:
  [`Vinhuit/ttlock-local-hass`](https://github.com/Vinhuit/ttlock-local-hass)
- Upstream SDK base:
  [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## Support

[![Support via Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/vinh541542)

## License

[GPL-3.0](./LICENSE)
