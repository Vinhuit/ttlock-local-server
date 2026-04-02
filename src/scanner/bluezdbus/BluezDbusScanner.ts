'use strict';

import { EventEmitter } from "events";
import { ScannerInterface, ScannerOptions, ScannerStateType } from "../ScannerInterface";
import { BluezDbusDevice } from "./BluezDbusDevice";
import { ADAPTER_IFACE, BLUEZ_SERVICE, DEVICE_IFACE, OBJECT_MANAGER_IFACE, PROPERTIES_IFACE, TTLOCK_UUIDS } from "./BluezDbusUtil";

const dbus: any = require("dbus-next");

function isVerboseScanLoggingEnabled(): boolean {
  return process.env.TTLOCK_VERBOSE_SCAN_LOGS === "1";
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsedValue) && parsedValue >= 0) {
    return parsedValue;
  }
  return fallback;
}

export class BluezDbusScanner extends EventEmitter implements ScannerInterface {
  uuids: string[];
  scannerState: ScannerStateType = "unknown";

  private readonly scannerOptions: ScannerOptions;
  private readonly devices: Map<string, BluezDbusDevice> = new Map();
  private readonly bus: any;
  private objectManager: any;
  private adapterPath: string = "";
  private adapterIface: any;
  private ready: boolean = false;
  private pollHandle?: NodeJS.Timeout;

  constructor(uuids: string[] = TTLOCK_UUIDS, scannerOptions: ScannerOptions = {}) {
    super();
    this.uuids = uuids;
    this.scannerOptions = scannerOptions;
    this.bus = dbus.systemBus();
    this.init().catch((error: any) => {
      console.error(error);
    });
  }

  private async init() {
    const rootObject = await this.bus.getProxyObject(BLUEZ_SERVICE, "/");
    this.objectManager = rootObject.getInterface(OBJECT_MANAGER_IFACE);
    const objects = await this.objectManager.GetManagedObjects();
    this.adapterPath = this.findAdapterPath(objects);
    if (!this.adapterPath) {
      throw new Error("No BlueZ adapter found");
    }

    const adapterObject = await this.bus.getProxyObject(BLUEZ_SERVICE, this.adapterPath);
    this.adapterIface = adapterObject.getInterface(ADAPTER_IFACE);
    const props = adapterObject.getInterface(PROPERTIES_IFACE);
    const powered = await props.Get(ADAPTER_IFACE, "Powered");
    if (!powered.value) {
      await props.Set(ADAPTER_IFACE, "Powered", new dbus.Variant("b", true));
    }

    this.ready = true;
    this.emit("ready");
  }

  private findAdapterPath(objects: Record<string, any>) {
    const preferred = String(this.scannerOptions.bluezAdapter || "").trim();
    for (const [path, interfaces] of Object.entries(objects)) {
      if (!interfaces[ADAPTER_IFACE]) {
        continue;
      }
      if (!preferred || path.endsWith(`/${preferred}`)) {
        return path;
      }
    }
    return "";
  }

  getState(): ScannerStateType {
    return this.scannerState;
  }

  async startScan(_passive: boolean): Promise<boolean> {
    if (!this.ready || this.scannerState === "scanning" || this.scannerState === "starting") {
      return false;
    }

    this.scannerState = "starting";
    await this.setDiscoveryFilter();
    await this.adapterIface.StartDiscovery();
    this.scannerState = "scanning";
    this.emit("scanStart");
    await this.pollObjects();
    this.startPolling();
    return true;
  }

  async stopScan(): Promise<boolean> {
    if (this.scannerState !== "scanning") {
      return false;
    }
    this.scannerState = "stopping";
    this.stopPolling();
    try {
      await this.adapterIface.StopDiscovery();
    } catch (error) {
      console.error(error);
    }
    const settleMs = getPositiveIntEnv("TTLOCK_DBUS_STOP_SCAN_SETTLE_MS", 250);
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    this.scannerState = "stopped";
    this.emit("scanStop");
    return true;
  }

  private startPolling() {
    this.stopPolling();
    const intervalMs = Number(this.scannerOptions.bluezDiscoveryIntervalMs || 500);
    this.pollHandle = setInterval(() => {
      this.pollObjects().catch((error: any) => console.error(error));
    }, intervalMs > 0 ? intervalMs : 500);
  }

  private stopPolling() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  private async setDiscoveryFilter() {
    const mode = String(this.scannerOptions.bluezMode || "le-all").toLowerCase();
    const filter: Record<string, any> = {
      Transport: new dbus.Variant("s", "le"),
      DuplicateData: new dbus.Variant("b", true),
    };

    if (mode === "ttlock" && this.uuids.length > 0) {
      filter.UUIDs = new dbus.Variant("as", this.uuids);
    }

    try {
      await this.adapterIface.SetDiscoveryFilter(filter);
    } catch (error) {
      console.error(error);
    }
  }

  private async pollObjects() {
    const objects = await this.objectManager.GetManagedObjects();
    for (const [path, interfaces] of Object.entries(objects as Record<string, any>)) {
      const nextInterfaces: any = interfaces;
      if (!nextInterfaces || !nextInterfaces[DEVICE_IFACE]) {
        continue;
      }
      const deviceInterfaces: any = nextInterfaces[DEVICE_IFACE];
      const deviceAddress = String(deviceInterfaces.Address?.value || "").toUpperCase();
      if (!deviceAddress) {
        continue;
      }

      const candidate = this.devices.get(path);
      if (candidate) {
        candidate.updateFromProperties({
          Address: deviceInterfaces.Address,
          AddressType: deviceInterfaces.AddressType,
          Name: deviceInterfaces.Name,
          Alias: deviceInterfaces.Alias,
          Connected: deviceInterfaces.Connected,
          RSSI: deviceInterfaces.RSSI,
          ManufacturerData: deviceInterfaces.ManufacturerData,
        });
        if (this.matchesFilter(deviceInterfaces)) {
          if (isVerboseScanLoggingEnabled()) {
            console.log(`BlueZ scanner rediscovered address=${candidate.address} name=${candidate.name || ""} rssi=${candidate.rssi}`);
          }
          this.emit("discover", candidate);
        }
        continue;
      }

      if (!this.matchesFilter(deviceInterfaces)) {
        continue;
      }

      const nextDevice = new BluezDbusDevice(this.bus, path, deviceInterfaces);
      this.devices.set(path, nextDevice);
      if (isVerboseScanLoggingEnabled()) {
        console.log(`BlueZ scanner discovered address=${nextDevice.address} name=${nextDevice.name || ""} rssi=${nextDevice.rssi}`);
      }
      this.emit("discover", nextDevice);
    }
  }

  private matchesFilter(deviceInterfaces: any): boolean {
    if (!this.uuids || this.uuids.length === 0) {
      return true;
    }
    const mode = String(this.scannerOptions.bluezMode || "le-all").toLowerCase();
    if (mode === "le-all") {
      return true;
    }

    const deviceUuids = Array.isArray(deviceInterfaces.UUIDs?.value) ? deviceInterfaces.UUIDs.value : [];
    const normalizedDeviceUuids = deviceUuids.map((item: string) => item.toLowerCase());
    return this.uuids.some((uuid) => normalizedDeviceUuids.includes(String(uuid).toLowerCase()));
  }
}
