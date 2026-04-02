'use strict';

import { EventEmitter } from "events";
import { CharacteristicInterface, DescriptorInterface } from "../DeviceInterface";
import { BluezDbusDevice } from "./BluezDbusDevice";
import { GATT_CHARACTERISTIC_IFACE, PROPERTIES_IFACE, normalizeBluetoothUuid, readVariantValue, toBuffer } from "./BluezDbusUtil";

const dbus: any = require("dbus-next");

export class BluezDbusCharacteristic extends EventEmitter implements CharacteristicInterface {
  uuid: string;
  name?: string | undefined;
  type?: string | undefined;
  properties: string[];
  isReading: boolean = false;
  lastValue?: Buffer | undefined;
  descriptors: Map<string, DescriptorInterface> = new Map();

  private readonly device: BluezDbusDevice;
  private readonly path: string;
  private propsIface?: any;
  private characteristicIface?: any;
  private notifyListenerAttached: boolean = false;
  private propsChangedListener?: (iface: string, changed: any) => void;

  constructor(device: BluezDbusDevice, path: string, characteristicData: any) {
    super();
    this.device = device;
    this.path = path;
    this.uuid = normalizeBluetoothUuid(readVariantValue(characteristicData.UUID || ""));
    this.properties = Array.isArray(readVariantValue(characteristicData.Flags))
      ? Array.from(readVariantValue(characteristicData.Flags))
      : [];
  }

  getUUID(): string {
    return this.uuid;
  }

  async discoverDescriptors(): Promise<Map<string, DescriptorInterface>> {
    return this.descriptors;
  }

  private async ensureInterfaces() {
    if (!this.characteristicIface || !this.propsIface) {
      const object = await this.device.getBus().getProxyObject("org.bluez", this.path);
      this.characteristicIface = object.getInterface(GATT_CHARACTERISTIC_IFACE);
      this.propsIface = object.getInterface(PROPERTIES_IFACE);
    }
  }

  async read(): Promise<Buffer | undefined> {
    if (!this.properties.includes("read")) {
      return undefined;
    }
    this.device.checkBusy();
    if (!this.device.connected) {
      this.device.resetBusy();
      throw new Error("BluezDbusDevice is not connected");
    }

    this.isReading = true;
    try {
      await this.ensureInterfaces();
      const value = await this.characteristicIface.ReadValue({});
      this.lastValue = toBuffer(value);
      return this.lastValue;
    } finally {
      this.isReading = false;
      this.device.resetBusy();
    }
  }

  async write(data: Buffer, withoutResponse: boolean): Promise<boolean> {
    if (!this.properties.includes("write") && !this.properties.includes("write-without-response") && !this.properties.includes("writeWithoutResponse")) {
      return false;
    }
    this.device.checkBusy();
    if (!this.device.connected) {
      this.device.resetBusy();
      return false;
    }

    try {
      await this.ensureInterfaces();
      const options = {
        type: new dbus.Variant("s", withoutResponse ? "command" : "request"),
      };
      await this.characteristicIface.WriteValue([...data], options);
      this.lastValue = Buffer.from(data);
      return true;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      this.device.resetBusy();
    }
  }

  async subscribe(): Promise<void> {
    if (!this.device.connected) {
      throw new Error("BluezDbusDevice is not connected");
    }

    await this.ensureInterfaces();
    console.log(`BlueZ characteristic subscribe start uuid=${this.uuid} path=${this.path} flags=${this.properties.join(",")}`);

    if (!this.notifyListenerAttached) {
      this.propsChangedListener = (iface: string, changed: any) => {
        if (iface !== GATT_CHARACTERISTIC_IFACE) {
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(changed, "Value")) {
          return;
        }
        const nextValue = toBuffer(changed.Value);
        this.lastValue = nextValue;
        if (!this.isReading) {
          console.log(`BlueZ notify value uuid=${this.uuid} bytes=${nextValue.length}`);
          this.emit("dataRead", nextValue);
        }
      };
      this.propsIface.on("PropertiesChanged", this.propsChangedListener);
      this.notifyListenerAttached = true;
    }

    try {
      await this.characteristicIface.StartNotify();
      console.log(`BlueZ characteristic subscribe success uuid=${this.uuid}`);
    } catch (error: any) {
      const message = error?.message || String(error);
      if (!message.includes("Already notifying")) {
        throw error;
      }
      console.log(`BlueZ characteristic already notifying uuid=${this.uuid}`);
    }
  }

  async unsubscribe(): Promise<void> {
    if (!this.characteristicIface) {
      return;
    }

    try {
      await this.characteristicIface.StopNotify();
    } catch (error: any) {
      const message = error?.message || String(error);
      if (!message.includes("Not notifying") && !message.includes("not supported")) {
        console.log(`BlueZ characteristic unsubscribe failed uuid=${this.uuid}: ${message}`);
      }
    }
  }

  async dispose(): Promise<void> {
    this.removeAllListeners("dataRead");

    try {
      await this.unsubscribe();
    } catch (_error) {}

    if (this.propsIface && this.propsChangedListener) {
      this.propsIface.removeListener("PropertiesChanged", this.propsChangedListener);
    }

    this.propsChangedListener = undefined;
    this.notifyListenerAttached = false;
    this.propsIface = undefined;
    this.characteristicIface = undefined;
  }

  toJSON(asObject: boolean): string | Object {
    const json: Record<string, any> = {
      uuid: this.uuid,
      name: this.name,
      type: this.type,
      properties: this.properties,
      value: this.lastValue?.toString("hex"),
      descriptors: {},
    };

    if (asObject) {
      return json;
    }
    return JSON.stringify(json);
  }

  toString(): string {
    return `[BluezDbusCharacteristic ${this.uuid}]`;
  }
}
