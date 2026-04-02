'use strict';

import { CharacteristicInterface, ServiceInterface } from "../DeviceInterface";
import { BluezDbusCharacteristic } from "./BluezDbusCharacteristic";
import { BluezDbusDevice } from "./BluezDbusDevice";
import { GATT_CHARACTERISTIC_IFACE, normalizeBluetoothUuid } from "./BluezDbusUtil";

export class BluezDbusService implements ServiceInterface {
  uuid: string;
  name?: string | undefined;
  type?: string | undefined;
  includedServiceUuids: string[];
  characteristics: Map<string, BluezDbusCharacteristic> = new Map();

  private readonly device: BluezDbusDevice;
  private readonly path: string;

  constructor(device: BluezDbusDevice, path: string, serviceData: any) {
    this.device = device;
    this.path = path;
    this.uuid = normalizeBluetoothUuid(serviceData?.UUID?.value || serviceData?.UUID || "");
    this.includedServiceUuids = [];
  }

  getUUID(): string {
    return this.uuid;
  }

  async discoverCharacteristics(): Promise<Map<string, CharacteristicInterface>> {
    this.characteristics = new Map();
    const objects = await this.device.getManagedObjects();
    const prefix = `${this.path}/`;

    for (const [path, interfaces] of Object.entries(objects as Record<string, any>)) {
      const nextInterfaces: any = interfaces;
      if (!path.startsWith(prefix) || !nextInterfaces || !nextInterfaces[GATT_CHARACTERISTIC_IFACE]) {
        continue;
      }
      const characteristic = new BluezDbusCharacteristic(this.device, path, nextInterfaces[GATT_CHARACTERISTIC_IFACE]);
      this.characteristics.set(characteristic.getUUID(), characteristic);
    }

    console.log(`BlueZ discovered characteristics for service ${this.uuid}: ${Array.from(this.characteristics.keys()).join(", ")}`);
    return this.characteristics;
  }

  async readCharacteristics(): Promise<Map<string, CharacteristicInterface>> {
    if (this.characteristics.size === 0) {
      await this.discoverCharacteristics();
    }

    for (const [, characteristic] of this.characteristics) {
      if (characteristic.properties.includes("read")) {
        await characteristic.read();
      }
    }
    return this.characteristics;
  }

  toJSON(asObject: boolean): string | Object {
    const json: Record<string, any> = {
      uuid: this.uuid,
      name: this.name,
      type: this.type,
      characteristics: {},
    };

    this.characteristics.forEach((characteristic) => {
      json.characteristics[characteristic.uuid] = characteristic.toJSON(true);
    });

    if (asObject) {
      return json;
    }
    return JSON.stringify(json);
  }

  toString(): string {
    return `[BluezDbusService ${this.uuid}]`;
  }
}
