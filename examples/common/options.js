'use strict';

module.exports = (lockData) => {
  let options = {
    lockData: lockData,
    scannerType: "noble",
    scannerOptions: {
      websocketHost: "127.0.0.1",
      websocketPort: 2846
    },
    // uuids: []
  };

  if (process.env.TTLOCK_SCANNER_TYPE) {
    options.scannerType = process.env.TTLOCK_SCANNER_TYPE;
  } else if (process.env.TTLOCK_LINUX_DBUS === "1") {
    options.scannerType = "bluez-dbus";
  }

  if (process.env.TTLOCK_SCAN_FILTER_UUIDS === "0" || process.env.TTLOCK_SCAN_ALL === "1") {
    options.uuids = [];
  }

  if (process.env.BLUEZ_ADAPTER) {
    options.scannerOptions.bluezAdapter = process.env.BLUEZ_ADAPTER;
  }

  if (process.env.BLUEZ_SCAN_MODE) {
    options.scannerOptions.bluezMode = process.env.BLUEZ_SCAN_MODE;
  }

  if (process.env.BLUEZ_DISCOVERY_INTERVAL_MS) {
    const parsedInterval = Number(process.env.BLUEZ_DISCOVERY_INTERVAL_MS);
    if (Number.isFinite(parsedInterval) && parsedInterval > 0) {
      options.scannerOptions.bluezDiscoveryIntervalMs = parsedInterval;
    }
  }

  if (process.env.WEBSOCKET_ENABLE == "1") {
    options.scannerType = "noble-websocket";
    if (process.env.WEBSOCKET_HOST) {
      options.scannerOptions.websocketHost = process.env.WEBSOCKET_HOST;
    }
    if (process.env.WEBSOCKET_PORT) {
      options.scannerOptions.websocketPort = process.env.WEBSOCKET_PORT;
    }
    if (process.env.WEBSOCKET_KEY) {
      options.scannerOptions.websocketAesKey = process.env.WEBSOCKET_KEY;
    }
  }

  return options;
}
