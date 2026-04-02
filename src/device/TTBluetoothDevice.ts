'use strict';

import { CommandEnvelope } from "../api/CommandEnvelope";
import { LockType, LockVersion } from "../constant/Lock";
import { CharacteristicInterface, DeviceInterface, ServiceInterface } from "../scanner/DeviceInterface";
import { ScannerInterface } from "../scanner/ScannerInterface";
import { sleep } from "../util/timingUtil";
import { TTDevice } from "./TTDevice";

const CRLF = "0d0a";
const MTU = 20;
const DEFAULT_COMMAND_RESPONSE_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_RETRIES = 3;
const DEFAULT_POST_CONNECT_DELAY_MS = 150;
const DEFAULT_SUBSCRIBE_RETRIES = 2;
const DEFAULT_SUBSCRIBE_RETRY_DELAY_MS = 250;

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

export interface TTBluetoothDevice {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: () => void): this;
  on(event: "updated", listener: () => void): this;
  on(event: "dataReceived", listener: (command: CommandEnvelope) => void): this;
}

export class TTBluetoothDevice extends TTDevice implements TTBluetoothDevice {
  device?: DeviceInterface;
  connected: boolean = false;
  incomingDataBuffer: Buffer = Buffer.from([]);
  private scanner: ScannerInterface;
  private waitingForResponse: boolean = false;
  private responses: CommandEnvelope[] = [];
  private readonly incomingDataListener: (data: Buffer) => void;
  private activeNotifyCharacteristic?: CharacteristicInterface;

  private constructor(scanner: ScannerInterface) {
    super();
    this.scanner = scanner;
    this.incomingDataListener = this.onIncomingData.bind(this);
  }

  static createFromDevice(device: DeviceInterface, scanner: ScannerInterface): TTBluetoothDevice {
    const bDevice = new TTBluetoothDevice(scanner);
    bDevice.updateFromDevice(device);
    return bDevice;
  }

  updateFromDevice(device?: DeviceInterface): void {
    if (typeof device != "undefined") {
      if (typeof this.device != "undefined") {
        this.device.removeAllListeners();
      }
      void this.detachNotifyCharacteristic();
      this.device = device;
      this.device.on("connected", this.onDeviceConnected.bind(this));
      this.device.on("disconnected", this.onDeviceDisconnected.bind(this));
    }

    if (typeof this.device != "undefined") {
      this.id = this.device.id;
      this.name = this.device.name;
      this.address = this.device.address;
      this.rssi = this.device.rssi;
      if (this.device.manufacturerData.length >= 15) {
        const discoveredAddress = this.device.address;
        this.parseManufacturerData(this.device.manufacturerData);
        if (discoveredAddress && this.address && this.address !== discoveredAddress) {
          if (isVerboseScanLoggingEnabled()) {
            console.log(`TTBluetoothDevice manufacturer MAC mismatch discovered=${discoveredAddress} parsed=${this.address}; keeping discovered address`);
          }
          this.address = discoveredAddress;
          this.protocolType = 0;
          this.protocolVersion = 0;
          this.scene = 0;
          this.groupId = 0;
          this.orgId = 0;
          this.lockType = LockType.UNKNOWN;
        }
      }
    }

    this.emit("updated");
  }

  async connect(): Promise<boolean> {
    if (typeof this.device != "undefined" && this.device.connectable) {
      this.resetTransientState();
      const transportName = this.device.constructor?.name || "UnknownDevice";
      const postConnectDelayMs = getPositiveIntEnv("TTLOCK_BLE_POST_CONNECT_DELAY_MS", DEFAULT_POST_CONNECT_DELAY_MS);
      console.log(`TTBluetoothDevice connect start transport=${transportName} address=${this.device.address}`);
      // stop scan
      await this.scanner.stopScan();
      await this.detachNotifyCharacteristic();
      if (await this.device.connect()) {
        console.log(`TTBluetoothDevice connected transport=${transportName}, waiting ${postConnectDelayMs}ms before subscribe`);
        await sleep(postConnectDelayMs);
        if (!this.device.connected) {
          console.log("Device disconnected before subscribe");
          this.resetTransientState();
          return false;
        }
        let subscribed = false;
        try {
          subscribed = await this.subscribe();
        } catch (error) {
          console.log("BLE subscribe threw error:", error instanceof Error ? error.message : error);
          subscribed = false;
        }
        if (!subscribed) {
          console.log("BLE subscribe failed");
          await this.device.disconnect();
          this.resetTransientState();
          return false;
        } else {
          this.connected = true;
          this.emit("connected");
          return true;
        }
      } else {
        console.log("Connect failed");
      }
    } else {
      console.log("Missing device or not connectable");
    }
    return false;
  }

  private async onDeviceConnected() {
    // await this.readBasicInfo();
    // await this.subscribe();
    // this.connected = true;
    // this.emit("connected");
    // console.log("TTBluetoothDevice connected", this.device?.id);
  }

  private async onDeviceDisconnected() {
    this.connected = false;
    await this.detachNotifyCharacteristic();
    this.resetTransientState();
    // console.log("TTBluetoothDevice disconnected", this.device?.id);
    this.emit("disconnected");
  }

  private async readBasicInfo() {
    if (typeof this.device != "undefined") {
      console.log("BLE Device discover services start");
      await this.device.discoverServices();
      console.log("BLE Device discover services end");
      // update some basic information
      let service: ServiceInterface | undefined;
      if (this.device.services.has("1800")) {
        service = this.device.services.get("1800");
        if (typeof service != "undefined") {
          console.log("BLE Device read characteristics start");
          await service.readCharacteristics();
          console.log("BLE Device read characteristics end");
          this.putCharacteristicValue(service, "2a00", "name");
        }
      }
      if (this.device.services.has("180a")) {
        service = this.device.services.get("180a");
        if (typeof service != "undefined") {
          console.log("BLE Device read characteristics start");
          await service.readCharacteristics();
          console.log("BLE Device read characteristics end");
          this.putCharacteristicValue(service, "2a29", "manufacturer");
          this.putCharacteristicValue(service, "2a24", "model");
          this.putCharacteristicValue(service, "2a27", "hardware");
          this.putCharacteristicValue(service, "2a26", "firmware");
        }
      }
    }
  }

  private async subscribe(): Promise<boolean> {
    if (typeof this.device != "undefined") {
      let service: ServiceInterface | undefined;
      const subscribeRetries = getPositiveIntEnv("TTLOCK_BLE_SUBSCRIBE_RETRIES", DEFAULT_SUBSCRIBE_RETRIES);
      const subscribeRetryDelayMs = getPositiveIntEnv("TTLOCK_BLE_SUBSCRIBE_RETRY_DELAY_MS", DEFAULT_SUBSCRIBE_RETRY_DELAY_MS);
      console.log(`BLE subscribe start address=${this.device.address} retries=${subscribeRetries}`);
      if (!this.device.connected) {
        console.log("BLE subscribe skipped because device is not connected");
        return false;
      }
      for (let attempt = 1; attempt <= subscribeRetries; attempt += 1) {
        if (!this.device.services.has("1910")) {
          console.log(`BLE subscribe discovering services (attempt ${attempt}/${subscribeRetries})`);
          await this.device.discoverServices();
          console.log(`BLE subscribe services after attempt ${attempt}: ${Array.from(this.device.services.keys()).join(", ")}`);
        }
        if (!this.device.connected) {
          console.log("BLE disconnected while discovering services");
          return false;
        }
        if (this.device.services.has("1910")) {
          service = this.device.services.get("1910");
          break;
        }
        if (attempt < subscribeRetries) {
          console.log(`BLE service 1910 still missing, waiting ${subscribeRetryDelayMs}ms before retry`);
          await sleep(subscribeRetryDelayMs);
        }
      }
      if (typeof service != "undefined") {
        console.log("BLE discovering characteristics for service 1910");
        await service.discoverCharacteristics();
        console.log("BLE discovered characteristics for 1910:", Array.from(service.characteristics.keys()).join(", "));
        if (!this.device.connected) {
          console.log("BLE disconnected while discovering characteristics");
          return false;
        }
        if (service.characteristics.has("fff4")) {
          const characteristic = service.characteristics.get("fff4");
          if (typeof characteristic != "undefined") {
            try {
              console.log("BLE subscribing to notify characteristic fff4");
              await characteristic.subscribe();
              if (!this.device.connected) {
                console.log("BLE disconnected right after subscribe");
                return false;
              }
              console.log("BLE subscribe to fff4 succeeded");
              await this.attachNotifyCharacteristic(characteristic);
              // does not seem to be required
              // await characteristic.discoverDescriptors();
              // const descriptor = characteristic.descriptors.get("2902");
              // if (typeof descriptor != "undefined") {
              //   console.log("Subscribing to descriptor notifications");
              //   await descriptor.writeValue(Buffer.from([0x01, 0x00])); // BE
              //   // await descriptor.writeValue(Buffer.from([0x00, 0x01])); // LE
              // }
              return true;
            } catch (error) {
              console.log("BLE subscribe error:", error instanceof Error ? error.message : error);
              return false;
            }
          }
        }
        console.log("BLE notify characteristic fff4 not found");
        return false;
      }
      console.log("BLE discovered services:", Array.from(this.device.services.keys()).join(", "));
      console.log("BLE lock service 1910 not found");
    }
    return false;
  }

  async sendCommand(command: CommandEnvelope, waitForResponse: boolean = true, ignoreCrc: boolean = false): Promise<CommandEnvelope | void> {
    if (this.waitingForResponse) {
      throw new Error("Command already in progress");
    }
    if (this.responses.length > 0) {
      this.responses = [];
    }
    const commandData = command.buildCommandBuffer();
    if (commandData) {
      let data = Buffer.concat([
        commandData,
        Buffer.from(CRLF, "hex")
      ]);
      // write with 20 bytes MTU
      const service = this.device?.services.get("1910");
      if (typeof service != "undefined") {
        const characteristic = service?.characteristics.get("fff2");
        if (typeof characteristic != "undefined") {
          if (waitForResponse) {
            const maxAttempts = getPositiveIntEnv("TTLOCK_COMMAND_RETRIES", DEFAULT_COMMAND_RETRIES);
            const responseTimeout = getPositiveIntEnv("TTLOCK_COMMAND_RESPONSE_TIMEOUT_MS", DEFAULT_COMMAND_RESPONSE_TIMEOUT_MS);
            let retry = 0;
            let crcs: number[] = [];
            let response: CommandEnvelope | undefined;
            this.waitingForResponse = true;
            try {
              do {
                if (retry > 0) {
                  await sleep(200);
                }
                const written = await this.writeCharacteristic(characteristic, data);
                if (!written) {
                  this.responses = [];
                  throw new Error("Unable to send data to lock");
                }
                response = await this.waitForQueuedResponse(responseTimeout);
                if (!this.connected) {
                  this.responses = [];
                  throw new Error("Disconnected while waiting for response");
                }
                if (typeof response != "undefined") {
                  crcs.push(response.getCrc());
                }
                retry++;
              } while ((typeof response == "undefined" || (!response.isCrcOk() && !ignoreCrc)) && retry < maxAttempts);
            } finally {
              this.waitingForResponse = false;
            }
            if (typeof response == "undefined") {
              throw new Error("No response from lock");
            }
            if (!response.isCrcOk() && !ignoreCrc) {
              // check if all CRCs match and auto-ignore bad CRC
              if (crcs.length > 1) {
                for (let i = 1; i < crcs.length; i++) {
                  if (crcs[i-1] != crcs[i]) {
                    throw new Error("Malformed response, bad CRC");
                  }
                }
              } else {
                throw new Error("Malformed response, bad CRC");
              }
            }
            return response;
          } else {
            await this.writeCharacteristic(characteristic, data);
            return;
          }
        }
      }
      throw new Error("Lock write characteristic not available");
    }
    throw new Error("Unable to build command buffer");
  }

  /**
   * 
   * @param timeout Timeout to wait in ms
   */
  async waitForResponse(timeout: number = 10000): Promise<CommandEnvelope | undefined> {
    if (this.waitingForResponse) {
      throw new Error("Command already in progress");
    }
    this.waitingForResponse = true;
    try {
      return await this.waitForQueuedResponse(timeout);
    } finally {
      this.waitingForResponse = false;
    }
  }

  private async writeCharacteristic(characteristic: CharacteristicInterface, data: Buffer): Promise<boolean> {
    if (process.env.TTLOCK_DEBUG_COMM == "1") {
      console.log("Sending command:", data.toString("hex"));
    }
    let index = 0;
    do {
      const remaining = data.length - index;
      const written = await characteristic.write(data.subarray(index, index + Math.min(MTU, remaining)), true);
      if (!written) {
        return false;
      }
      // await sleep(10);
      index += MTU;
    } while (index < data.length);
    return true;
  }

  private onIncomingData(data: Buffer) {
    this.incomingDataBuffer = Buffer.concat([this.incomingDataBuffer, data]);
    this.readDeviceResponse();
  }

  private readDeviceResponse() {
    if (this.incomingDataBuffer.length >= 2) {
      // check for CRLF at the end of data
      const ending = this.incomingDataBuffer.subarray(this.incomingDataBuffer.length - 2);
      if (ending.toString("hex") == CRLF) {
        // we have a command response
        if (process.env.TTLOCK_DEBUG_COMM == "1") {
          console.log("Received response:", this.incomingDataBuffer.toString("hex"));
        }
        try {
          const command = CommandEnvelope.createFromRawData(this.incomingDataBuffer.subarray(0, this.incomingDataBuffer.length - 2));
          if (this.waitingForResponse) {
            this.responses.push(command);
          } else {
            // discard unsolicited messages if CRC is not ok
            if (command.isCrcOk()) {
              this.emit("dataReceived", command);
            }
          }
        } catch (error) {
          // TODO: in case of a malformed response we should notify the waiting cycle and stop waiting
          console.error(error);
        }
        this.incomingDataBuffer = Buffer.from([]);
      }
    }
  }

  private putCharacteristicValue(service: ServiceInterface, uuid: string, property: string) {
    const value = service.characteristics.get(uuid);
    if (typeof value != "undefined" && typeof value.lastValue != "undefined") {
      Reflect.set(this, property, value.lastValue.toString());
    }
  }

  async disconnect() {
    await this.detachNotifyCharacteristic();
    if (await this.device?.disconnect()) {
      this.connected = false;
      this.resetTransientState();
    }
  }

  private async waitForQueuedResponse(timeout: number): Promise<CommandEnvelope | undefined> {
    let elapsed = 0;
    const sleepPerCycle = 10;

    while (this.responses.length == 0 && this.connected && elapsed < timeout) {
      await sleep(sleepPerCycle);
      elapsed += sleepPerCycle;
    }

    return this.responses.pop();
  }

  private resetTransientState() {
    this.waitingForResponse = false;
    this.responses = [];
    this.incomingDataBuffer = Buffer.from([]);
  }

  private async attachNotifyCharacteristic(characteristic: CharacteristicInterface) {
    if (this.activeNotifyCharacteristic === characteristic) {
      characteristic.removeListener("dataRead", this.incomingDataListener);
      characteristic.on("dataRead", this.incomingDataListener);
      return;
    }

    await this.detachNotifyCharacteristic();
    characteristic.removeListener("dataRead", this.incomingDataListener);
    characteristic.on("dataRead", this.incomingDataListener);
    this.activeNotifyCharacteristic = characteristic;
  }

  private async detachNotifyCharacteristic() {
    const characteristic = this.activeNotifyCharacteristic;
    if (!characteristic) {
      return;
    }

    characteristic.removeListener("dataRead", this.incomingDataListener);

    if (typeof characteristic.dispose === "function") {
      try {
        await characteristic.dispose();
      } catch (_error) {}
    } else if (typeof characteristic.unsubscribe === "function") {
      try {
        await characteristic.unsubscribe();
      } catch (_error) {}
    }

    this.activeNotifyCharacteristic = undefined;
  }

  parseManufacturerData(manufacturerData: Buffer) {
    // TODO: check offset is within the limits of the Buffer
    // console.log(manufacturerData, manufacturerData.length)
    if (manufacturerData.length < 15) {
      throw new Error("Invalid manufacturer data length:" + manufacturerData.length.toString());
    }

    var offset = 0;
    this.protocolType = manufacturerData.readInt8(offset++);
    this.protocolVersion = manufacturerData.readInt8(offset++);
    if (this.protocolType == 18 && this.protocolVersion == 25) {
      this.isDfuMode = true;
      return;
    }
    if (this.protocolType == -1 && this.protocolVersion == -1) {
      this.isDfuMode = true;
      return;
    }
    if (this.protocolType == 52 && this.protocolVersion == 18) {
      this.isWristband = true;
    }
    if (this.protocolType == 5 && this.protocolVersion == 3) {
      this.scene = manufacturerData.readInt8(offset++);
    } else {
      offset = 4;
      this.protocolType = manufacturerData.readInt8(offset++);
      this.protocolVersion = manufacturerData.readInt8(offset++);
      offset = 7;
      this.scene = manufacturerData.readInt8(offset++);
    }
    if (this.protocolType < 5 || LockVersion.getLockType(this) == LockType.LOCK_TYPE_V2S) {
      this.isRoomLock = true;
      return;
    }
    if (this.scene <= 3) {
      this.isRoomLock = true;
    } else {
      switch (this.scene) {
        case 4: {
          this.isGlassLock = true;
          break;
        }
        case 5:
        case 11: {
          this.isSafeLock = true;
          break;
        }
        case 6: {
          this.isBicycleLock = true;
          break;
        }
        case 7: {
          this.isLockcar = true;
          break;
        }
        case 8: {
          this.isPadLock = true;
          break;
        }
        case 9: {
          this.isCyLinder = true;
          break;
        }
        case 10: {
          if (this.protocolType == 5 && this.protocolVersion == 3) {
            this.isRemoteControlDevice = true;
            break;
          }
          break;
        }
      }
    }

    const params = manufacturerData.readInt8(offset);

    this.isUnlock = ((params & 0x1) == 0x1);

    this.hasEvents = ((params & 0x2) == 0x2);

    this.isSettingMode = ((params & 0x4) != 0x0);
    if (LockVersion.getLockType(this) == LockType.LOCK_TYPE_V3 || LockVersion.getLockType(this) == LockType.LOCK_TYPE_V3_CAR) {
      this.isTouch = ((params && 0x8) != 0x0);
    } else if (LockVersion.getLockType(this) == LockType.LOCK_TYPE_CAR) {
      this.isTouch = false;
      this.isLockcar = true;
    }
    if (this.isLockcar) {
      if (this.isUnlock) {
        if ((params & 0x10) == 0x10) {
          this.parkStatus = 3;
        } else {
          this.parkStatus = 2;
        }
      } else if ((params & 0x10) == 0x10) {
        this.parkStatus = 1;
      } else {
        this.parkStatus = 0;
      }
    }
    offset++;

    this.batteryCapacity = manufacturerData.readInt8(offset);

    // offset += 3 + 4; // Offset in original SDK is + 3, but in scans it's actually +4
    offset = manufacturerData.length - 6; // let's just get the last 6 bytes
    const macBuf = manufacturerData.slice(offset, offset + 6);
    var macArr: string[] = [];
    macBuf.forEach((m: number) => {
      let hexByte: string = m.toString(16);
      if (hexByte.length < 2) {
        hexByte = "0" + hexByte;
      }
      macArr.push(hexByte);
    });
    macArr.reverse();
    this.address = macArr.join(':').toUpperCase();
  }
}
