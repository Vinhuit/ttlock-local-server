'use strict';

import { Characteristic } from "@abandonware/noble";
import { EventEmitter } from "events";
import { sleep } from "../../util/timingUtil";
import { CharacteristicInterface, DescriptorInterface } from "../DeviceInterface";
import { NobleDescriptor } from "./NobleDescriptor";
import { NobleDevice } from "./NobleDevice";

const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 4000;

export class NobleCharacteristic extends EventEmitter implements CharacteristicInterface {
  uuid: string;
  name?: string | undefined;
  type?: string | undefined;
  properties: string[];
  isReading: boolean = false;
  lastValue?: Buffer;
  descriptors: Map<string, NobleDescriptor> = new Map();
  private device: NobleDevice;
  private characteristic: Characteristic;

  constructor(device: NobleDevice, characteristic: Characteristic) {
    super();
    this.device = device;
    this.characteristic = characteristic;
    this.uuid = characteristic.uuid;
    this.name = characteristic.name;
    this.type = characteristic.type;
    this.properties = characteristic.properties;
    this.characteristic.on("read", this.onRead.bind(this));
  }

  getUUID(): string {
    return normalizeBluetoothUuid(this.uuid);
  }

  async discoverDescriptors(): Promise<Map<string, DescriptorInterface>> {
    this.device.checkBusy();
    if (!this.device.connected) {
      this.device.resetBusy();
      throw new Error("NobleDevice is not connected");
    }
    try {
      const descriptors = await this.characteristic.discoverDescriptorsAsync();
      this.descriptors = new Map();
      descriptors.forEach((descriptor) => {
        this.descriptors.set(descriptor.uuid, new NobleDescriptor(this.device, descriptor));
      });
    } catch (error) {
      console.error(error);
    }
    this.device.resetBusy();
    return this.descriptors;
  }

  async read(): Promise<Buffer | undefined> {
    if (!this.properties.includes("read")) {
      return;
    }
    this.device.checkBusy();
    if (!this.device.connected) {
      this.device.resetBusy();
      throw new Error("NobleDevice is not connected");
    }
    this.isReading = true;
    try {
      this.lastValue = await this.characteristic.readAsync();
    } catch (error) {
      console.error(error);
    }
    this.isReading = false;
    this.device.resetBusy();
    return this.lastValue;
  }

  async write(data: Buffer, withoutResponse: boolean): Promise<boolean> {
    if (!this.properties.includes("write") && !this.properties.includes("writeWithoutResponse")) {
      return false;
    }
    this.device.checkBusy();
    if (!this.device.connected) {
      this.device.resetBusy();
      return false;
      // throw new Error("NobleDevice is not connected");
    }

    let written = false;
    let writeError = false;
    let counter = 5000;

    // await this.characteristic.writeAsync(data, withoutResponse);
    this.characteristic.write(data, withoutResponse, (error) => {
      if (error) {
        writeError = true;
      }
      written = true;
    });
    do {
      await sleep(1);
      counter--;
    } while (!written && counter > 0);

    this.device.resetBusy();
    return written && !writeError;
  }

  async subscribe(): Promise<void> {
    if (!this.device.connected) {
      throw new Error("NobleDevice is not connected");
    }

    const subscribeTimeoutMs = getPositiveIntEnv("TTLOCK_SUBSCRIBE_TIMEOUT_MS", DEFAULT_SUBSCRIBE_TIMEOUT_MS);
    await promiseWithTimeout(this.characteristic.subscribeAsync(), subscribeTimeoutMs, "Characteristic subscribe timed out");

    if (!this.device.connected) {
      throw new Error("NobleDevice disconnected during subscribe");
    }
    // await this.characteristic.notifyAsync(true);
  }

  async unsubscribe(): Promise<void> {
    if (!this.device.connected) {
      return;
    }

    try {
      await this.characteristic.unsubscribeAsync();
    } catch (error) {
      console.error(error);
    }
  }

  private onRead(data: Buffer) {
    // if the read notification comes from a manual read, just ignore it
    // we are only interested in data pushed by the device
    if (!this.isReading) {
      this.lastValue = data;
      this.emit("dataRead", this.lastValue);
    }
  }

  toJSON(asObject: boolean): string | Object {
    let json: Record<string, any> = {
      uuid: this.uuid,
      name: this.name,
      type: this.type,
      properties: this.properties,
      value: this.lastValue?.toString("hex"),
      descriptors: {}
    }
    this.descriptors.forEach((descriptor) => {
      json.descriptors[this.uuid] = this.toJSON(true);
    });

    if (asObject) {
      return json;
    } else {
      return JSON.stringify(json);
    }
  }

  toString(): string {
    return this.characteristic.toString();
  }
}

function normalizeBluetoothUuid(uuid: string): string {
  const normalized = uuid.toLowerCase().replace(/-/g, "");
  const bluetoothBaseUuid = "00001000800000805f9b34fb";
  if (normalized.length === 32 && normalized.endsWith(bluetoothBaseUuid)) {
    return normalized.slice(4, 8);
  }
  return normalized;
}

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

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
