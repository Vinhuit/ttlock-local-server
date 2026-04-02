# Linux D-Bus POC

This branch includes an experimental BlueZ D-Bus proof-of-concept for Linux.

Goal:

- compare Linux discovery behavior against the current `noble` path
- see whether BlueZ `Device1.Connect()` is more stable for your adapter
- keep the experiment isolated from the current working backend

## Script

The prototype tool lives in:

- [`tools/dbusScan.js`](../tools/dbusScan.js)

It is exposed through:

```bash
npm run dbus-scan-tool -- --mac 0C:49:0E:FD:6A:98 --timeout-ms 10000
```

LE all mode:

```bash
npm run dbus-scan-tool -- --adapter hci0 --mode le-all --timeout-ms 10000
```

LE + TTLock UUID filter mode:

```bash
npm run dbus-scan-tool -- --adapter hci0 --mode ttlock --timeout-ms 10000
```

To also try a direct BlueZ D-Bus connect after discovery:

```bash
npm run dbus-scan-tool -- --adapter hci0 --mode le-all --mac 0C:49:0E:FD:6A:98 --timeout-ms 10000 --connect
```

## What It Does

- opens the system D-Bus
- finds the BlueZ adapter via `ObjectManager`
- supports selecting the adapter explicitly with `--adapter hci0`
- starts discovery with `org.bluez.Adapter1`
- can set `SetDiscoveryFilter` for:
  - `le-all`
  - `ttlock`
- watches `org.bluez.Device1` objects
- optionally calls `Device1.Connect()` and `Disconnect()`

## Current Scope

This branch now also includes an experimental `scannerType: "bluez-dbus"` path for the backend.

You can try Web UI with D-Bus on Linux using:

```bash
TTLOCK_LINUX_DBUS=1 BLUEZ_ADAPTER=hci0 BLUEZ_SCAN_MODE=le-all npm run webui
```

Or with TTLock UUID filtering:

```bash
TTLOCK_LINUX_DBUS=1 BLUEZ_ADAPTER=hci0 BLUEZ_SCAN_MODE=ttlock npm run webui
```

Current intended scope:

- discovery by MAC
- discovery timing
- direct D-Bus connect timing
- experimental backend scan/connect path

## Why This Exists

The current Linux path uses `@abandonware/noble`, which depends on HCI socket behavior and adapter-specific quirks.

This proof-of-concept tests whether BlueZ D-Bus behaves better on Linux for your BLE hardware.
