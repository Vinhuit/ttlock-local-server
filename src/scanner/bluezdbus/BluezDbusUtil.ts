'use strict';

const bluetoothBaseUuid = "00001000800000805f9b34fb";

export const BLUEZ_SERVICE = "org.bluez";
export const OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager";
export const PROPERTIES_IFACE = "org.freedesktop.DBus.Properties";
export const ADAPTER_IFACE = "org.bluez.Adapter1";
export const DEVICE_IFACE = "org.bluez.Device1";
export const GATT_SERVICE_IFACE = "org.bluez.GattService1";
export const GATT_CHARACTERISTIC_IFACE = "org.bluez.GattCharacteristic1";
export const TTLOCK_UUIDS: string[] = ["1910", "00001910-0000-1000-8000-00805f9b34fb"];

export function readVariantValue(value: any): any {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return value.value;
  }
  return value;
}

export function getInterfaceValue(iface: any, key: string, fallback: any = undefined): any {
  if (!iface || typeof iface !== "object" || !Object.prototype.hasOwnProperty.call(iface, key)) {
    return fallback;
  }
  return readVariantValue(iface[key]);
}

export function normalizeAddress(address: string | undefined): string {
  return typeof address === "string" ? address.replace(/-/g, ":").toUpperCase() : "";
}

export function normalizeBluetoothUuid(uuid: string): string {
  const normalized = String(uuid || "").toLowerCase().replace(/-/g, "");
  if (normalized.length === 32 && normalized.endsWith(bluetoothBaseUuid)) {
    return normalized.slice(4, 8);
  }
  return normalized;
}

export function toBuffer(value: any): Buffer {
  const actual = readVariantValue(value);
  if (Buffer.isBuffer(actual)) {
    return actual;
  }
  if (actual instanceof Uint8Array) {
    return Buffer.from(actual);
  }
  if (Array.isArray(actual)) {
    return Buffer.from(actual);
  }
  return Buffer.from([]);
}

export function firstManufacturerDataBuffer(manufacturerData: any): Buffer {
  const actual = readVariantValue(manufacturerData);
  if (actual instanceof Map) {
    for (const [, value] of actual.entries()) {
      return toBuffer(value);
    }
  }
  if (Array.isArray(actual)) {
    for (const entry of actual) {
      if (Array.isArray(entry) && entry.length > 1) {
        return toBuffer(entry[1]);
      }
    }
  }
  if (actual && typeof actual === "object") {
    const keys = Object.keys(actual);
    if (keys.length > 0) {
      return toBuffer(actual[keys[0]]);
    }
  }
  return Buffer.from([]);
}

export function getBluezDeviceUuidFromPath(path: string): string {
  const match = /dev_([0-9A-F_]+)$/i.exec(path);
  if (!match) {
    return normalizeBluetoothUuid(path);
  }
  return match[1].replace(/_/g, "").toLowerCase();
}
