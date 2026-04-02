'use strict';

import { EventEmitter } from "events";
import { DeviceInterface, ServiceInterface } from "../DeviceInterface";
import { BluezDbusService } from "./BluezDbusService";
import { DEVICE_IFACE, GATT_SERVICE_IFACE, PROPERTIES_IFACE, firstManufacturerDataBuffer, getBluezDeviceUuidFromPath, getInterfaceValue, normalizeAddress, readVariantValue } from "./BluezDbusUtil";
import { sleep } from "../../util/timingUtil";

function getPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return parsedValue;
  }
  return fallback;
}

function isVerboseScanLoggingEnabled(): boolean {
  return process.env.TTLOCK_VERBOSE_SCAN_LOGS === "1";
}

export class BluezDbusDevice extends EventEmitter implements DeviceInterface {
  id: string;
  uuid: string;
  name: string;
  address: string;
  addressType: string;
  connectable: boolean;
  connected?: boolean | undefined;
  rssi: number;
  mtu: number = 20;
  manufacturerData: Buffer;
  services: Map<string, BluezDbusService> = new Map();
  busy: boolean = false;

  private readonly bus: any;
  private readonly path: string;
  private currentPath: string;
  private deviceIface?: any;
  private propsIface?: any;
  private readonly servicesResolveTimeoutSeconds = getPositiveIntEnv("TTLOCK_DBUS_SERVICES_RESOLVED_TIMEOUT_SECONDS", 1);
  private propsListenerAttached: boolean = false;

  constructor(bus: any, path: string, deviceData: any) {
    super();
    this.bus = bus;
    this.path = path;
    this.currentPath = path;
    this.id = path.split('/').pop() || path;
    this.uuid = getBluezDeviceUuidFromPath(path);
    this.name = '';
    this.address = '';
    this.addressType = 'public';
    this.connectable = true;
    this.connected = false;
    this.rssi = -999;
    this.manufacturerData = Buffer.from([]);
    this.updateFromInterfaceData(deviceData);
  }

  getBus() {
    return this.bus;
  }

  async getManagedObjects() {
    const rootObject = await this.bus.getProxyObject("org.bluez", "/");
    const manager = rootObject.getInterface("org.freedesktop.DBus.ObjectManager");
    return await manager.GetManagedObjects();
  }

  private updateFromInterfaceData(deviceData: any) {
    this.name = getInterfaceValue(deviceData, "Name", getInterfaceValue(deviceData, "Alias", this.name || ""));
    this.address = normalizeAddress(getInterfaceValue(deviceData, "Address", this.address || ""));
    this.addressType = String(getInterfaceValue(deviceData, "AddressType", this.addressType || "public"));
    this.connectable = Boolean(getInterfaceValue(deviceData, "Connected", true) || getInterfaceValue(deviceData, "ServicesResolved", false) || true);
    this.connected = Boolean(getInterfaceValue(deviceData, "Connected", this.connected || false));
    this.rssi = Number(getInterfaceValue(deviceData, "RSSI", this.rssi));
    this.manufacturerData = firstManufacturerDataBuffer(getInterfaceValue(deviceData, "ManufacturerData", undefined));
  }

  updateFromProperties(changed: any) {
    const normalized = Object.fromEntries(
      Object.entries(changed || {}).map(([key, value]) => [key, { value: readVariantValue(value) }])
    );
    this.updateFromInterfaceData(normalized);
  }

  checkBusy(): boolean {
    if (this.busy) {
      throw new Error("BluezDbusDevice is busy");
    }
    this.busy = true;
    return true;
  }

  resetBusy(): boolean {
    this.busy = false;
    return this.busy;
  }

  private async ensureInterfaces() {
    if (!this.deviceIface || !this.propsIface) {
      let deviceObject: any;
      try {
        deviceObject = await this.bus.getProxyObject("org.bluez", this.currentPath);
        this.deviceIface = deviceObject.getInterface(DEVICE_IFACE);
        this.propsIface = deviceObject.getInterface(PROPERTIES_IFACE);
      } catch (_error) {
        await this.refreshPathFromManagedObjects();
        deviceObject = await this.bus.getProxyObject("org.bluez", this.currentPath);
        this.deviceIface = deviceObject.getInterface(DEVICE_IFACE);
        this.propsIface = deviceObject.getInterface(PROPERTIES_IFACE);
      }
      if (!this.propsListenerAttached) {
        this.propsIface.on("PropertiesChanged", (iface: string, changed: any) => {
          if (iface !== DEVICE_IFACE) {
            return;
          }
          const wasConnected = Boolean(this.connected);
          const previousName = this.name;
          this.updateFromProperties(changed);
          const isConnected = Boolean(this.connected);
          const servicesResolved = Boolean(getInterfaceValue(changed, "ServicesResolved", false));
          const hasConnectionChange = Object.prototype.hasOwnProperty.call(changed || {}, "Connected");
          const hasServicesResolvedChange = Object.prototype.hasOwnProperty.call(changed || {}, "ServicesResolved");
          const hasRssiChange = Object.prototype.hasOwnProperty.call(changed || {}, "RSSI");
          if (hasConnectionChange || hasServicesResolvedChange || (hasRssiChange && isVerboseScanLoggingEnabled())) {
            console.log(`BlueZ device properties changed address=${this.address || previousName} connected=${isConnected} servicesResolved=${servicesResolved} rssi=${this.rssi}`);
          }
          if (!wasConnected && isConnected) {
            this.emit("connected");
          }
          if (wasConnected && !isConnected) {
            this.services = new Map();
            this.emit("disconnected");
          }
        });
        this.propsListenerAttached = true;
      }
    }
  }

  private invalidateInterfaces() {
    this.deviceIface = undefined;
    this.propsIface = undefined;
    this.propsListenerAttached = false;
    this.connected = false;
    this.services = new Map();
  }

  private async refreshPathFromManagedObjects() {
    const normalizedAddress = normalizeAddress(this.address);
    if (!normalizedAddress) {
      this.currentPath = this.path;
      return;
    }

    const objects = await this.getManagedObjects();
    for (const [path, interfaces] of Object.entries(objects as Record<string, any>)) {
      const nextInterfaces: any = interfaces;
      const deviceData = nextInterfaces?.[DEVICE_IFACE];
      if (!deviceData) {
        continue;
      }
      const nextAddress = normalizeAddress(getInterfaceValue(deviceData, "Address", ""));
      if (nextAddress === normalizedAddress) {
        this.currentPath = path;
        this.id = path.split('/').pop() || path;
        this.uuid = getBluezDeviceUuidFromPath(path);
        this.updateFromInterfaceData(deviceData);
        return;
      }
    }

    this.currentPath = this.path;
  }

  private formatBluezError(error: any): string {
    return error?.text || error?.message || String(error);
  }

  async connect(timeout: number = getPositiveIntEnv("TTLOCK_DBUS_CONNECT_TIMEOUT_SECONDS", 3)): Promise<boolean> {
    const effectiveTimeout = Math.max(timeout, 4);
    await this.refreshPathFromManagedObjects();
    await this.ensureInterfaces();
    if (this.connected) {
      return true;
    }

    const connectStartedAt = Date.now();
    let connectSettled = false;
    let connectFailed = false;
    try {
      console.log(`Peripheral connect start path=${this.currentPath} address=${this.address} timeout=${effectiveTimeout}s`);
      this.deviceIface.Connect()
        .then(() => {
          connectSettled = true;
          console.log(`Peripheral connect triggered after ${Date.now() - connectStartedAt}ms`);
        })
        .catch((error: any) => {
          connectSettled = true;
          connectFailed = true;
          console.log(`Peripheral connect failed: ${this.formatBluezError(error)}`);
        });
    } catch (error) {
      console.log(`Peripheral connect failed: ${this.formatBluezError(error)}`);
      this.invalidateInterfaces();
      return false;
    }

    const deadline = Date.now() + effectiveTimeout * 1000;
    do {
      let connected = false;
      try {
        connected = Boolean(readVariantValue(await this.propsIface.Get(DEVICE_IFACE, "Connected")));
      } catch (error) {
        console.log(`Peripheral connect state read failed: ${this.formatBluezError(error)}`);
        this.invalidateInterfaces();
        return false;
      }
      this.connected = connected;
      if (connected) {
        const servicesResolved = await this.waitForServicesResolved(Math.min(effectiveTimeout, this.servicesResolveTimeoutSeconds));
        console.log(`Peripheral state: connected servicesResolved=${servicesResolved} totalElapsed=${Date.now() - connectStartedAt}ms`);
        console.log("Device emiting connected");
        this.emit("connected");
        return true;
      }
      if (connectFailed) {
        return false;
      }
      await sleep(100);
    } while (Date.now() < deadline);

    console.log(`Peripheral connect timeout after ${Date.now() - connectStartedAt}ms`);
    if (!connectSettled) {
      try {
        await this.deviceIface.Disconnect();
      } catch (_error) {}
    }
    this.invalidateInterfaces();
    return false;
  }

  private async waitForServicesResolved(timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      const resolved = Boolean(readVariantValue(await this.propsIface.Get(DEVICE_IFACE, "ServicesResolved")));
      if (resolved) {
        return true;
      }
      await sleep(100);
    } while (Date.now() < deadline);
    return false;
  }

  async disconnect(): Promise<boolean> {
    await this.refreshPathFromManagedObjects();
    await this.ensureInterfaces();
    try {
      await this.deviceIface.Disconnect();
      this.connected = false;
      this.services = new Map();
      this.emit("disconnected");
      return true;
    } catch (error) {
      console.log(`Peripheral disconnect failed: ${this.formatBluezError(error)}`);
      this.invalidateInterfaces();
      return false;
    }
  }

  async discoverAll(): Promise<Map<string, ServiceInterface>> {
    await this.discoverServices();
    for (const [, service] of this.services) {
      await service.discoverCharacteristics();
    }
    return this.services;
  }

  async discoverServices(): Promise<Map<string, ServiceInterface>> {
    const maxAttempts = getPositiveIntEnv("TTLOCK_DBUS_DISCOVER_SERVICES_RETRIES", 3);
    const retryDelayMs = getPositiveIntEnv("TTLOCK_DBUS_DISCOVER_SERVICES_RETRY_DELAY_MS", 250);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.services = new Map();
      const objects = await this.getManagedObjects();
      const prefix = `${this.currentPath}/`;

      for (const [path, interfaces] of Object.entries(objects as Record<string, any>)) {
        const nextInterfaces: any = interfaces;
        if (!path.startsWith(prefix) || !nextInterfaces || !nextInterfaces[GATT_SERVICE_IFACE]) {
          continue;
        }
        const service = new BluezDbusService(this, path, nextInterfaces[GATT_SERVICE_IFACE]);
        this.services.set(service.getUUID(), service);
      }

      console.log(`BLE discovered services (attempt ${attempt}/${maxAttempts}): ${Array.from(this.services.keys()).join(", ")}`);
      if (this.services.size > 0 || attempt === maxAttempts) {
        return this.services;
      }

      await sleep(retryDelayMs);
    }
    return this.services;
  }

  async readCharacteristics(): Promise<boolean> {
    if (!this.connected) {
      throw new Error("BluezDbusDevice not connected");
    }
    if (this.services.size === 0) {
      await this.discoverServices();
    }
    for (const [, service] of this.services) {
      await service.readCharacteristics();
    }
    return true;
  }

  toJSON(asObject: boolean): string | Object {
    const json: Record<string, any> = {
      id: this.id,
      uuid: this.uuid,
      name: this.name,
      address: this.address,
      addressType: this.addressType,
      connectable: this.connectable,
      rssi: this.rssi,
      mtu: this.mtu,
      services: {},
    };
    this.services.forEach((service) => {
      json.services[service.uuid] = service.toJSON(true);
    });

    if (asObject) {
      return json;
    }
    return JSON.stringify(json);
  }

  toString(): string {
    return `[BluezDbusDevice ${this.address}]`;
  }
}
