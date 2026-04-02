'use strict';

const dbus = require('dbus-next');

const BLUEZ_SERVICE = 'org.bluez';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const DEVICE_IFACE = 'org.bluez.Device1';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const TTLOCK_UUIDS = ['1910', '00001910-0000-1000-8000-00805f9b34fb'];

function normalizeMac(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function parseArgs(argv) {
  const args = {
    mac: '',
    timeoutMs: 10000,
    connect: false,
    adapter: '',
    mode: 'le-all',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--mac' && argv[index + 1]) {
      args.mac = normalizeMac(argv[index + 1]);
      index += 1;
    } else if (item === '--timeout-ms' && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutMs = parsed;
      }
      index += 1;
    } else if (item === '--connect') {
      args.connect = true;
    } else if (item === '--adapter' && argv[index + 1]) {
      args.adapter = String(argv[index + 1]).trim();
      index += 1;
    } else if (item === '--mode' && argv[index + 1]) {
      args.mode = String(argv[index + 1]).trim().toLowerCase();
      index += 1;
    }
  }

  if (!args.mac && process.env.TARGET_MAC) {
    args.mac = normalizeMac(process.env.TARGET_MAC);
  }

  if (!args.adapter && process.env.BLUEZ_ADAPTER) {
    args.adapter = String(process.env.BLUEZ_ADAPTER).trim();
  }

  if (!args.mode && process.env.BLUEZ_SCAN_MODE) {
    args.mode = String(process.env.BLUEZ_SCAN_MODE).trim().toLowerCase();
  }

  if (args.mode !== 'le-all' && args.mode !== 'ttlock') {
    args.mode = 'le-all';
  }

  return args;
}

function readVariantValue(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return value.value;
  }
  return value;
}

function getInterfaceValue(iface, key, fallback = undefined) {
  if (!iface || typeof iface !== 'object' || !Object.prototype.hasOwnProperty.call(iface, key)) {
    return fallback;
  }
  return readVariantValue(iface[key]);
}

function parseDeviceInfo(path, interfaces) {
  const device = interfaces?.[DEVICE_IFACE];
  if (!device) {
    return null;
  }

  const uuids = getInterfaceValue(device, 'UUIDs', []);
  const manufacturerData = getInterfaceValue(device, 'ManufacturerData', new Map());

  return {
    path,
    address: normalizeMac(getInterfaceValue(device, 'Address', '')),
    name: getInterfaceValue(device, 'Name', ''),
    alias: getInterfaceValue(device, 'Alias', ''),
    connected: Boolean(getInterfaceValue(device, 'Connected', false)),
    rssi: getInterfaceValue(device, 'RSSI', null),
    uuids: Array.isArray(uuids) ? uuids : [],
    manufacturerData,
  };
}

async function getManagedObjects(bus) {
  const rootObject = await bus.getProxyObject(BLUEZ_SERVICE, '/');
  const manager = rootObject.getInterface(OBJECT_MANAGER_IFACE);
  const objects = await manager.GetManagedObjects();
  return { manager, objects };
}

function findAdapterPath(objects, preferredAdapter = '') {
  const normalizedPreferred = preferredAdapter.trim();
  for (const [path, interfaces] of Object.entries(objects)) {
    if (!interfaces[ADAPTER_IFACE]) {
      continue;
    }
    if (!normalizedPreferred || path.endsWith(`/${normalizedPreferred}`)) {
      return path;
    }
  }
  return '';
}

async function setAdapterPowered(bus, adapterPath) {
  const adapterObject = await bus.getProxyObject(BLUEZ_SERVICE, adapterPath);
  const props = adapterObject.getInterface(PROPERTIES_IFACE);
  const powered = readVariantValue(await props.Get(ADAPTER_IFACE, 'Powered'));
  if (!powered) {
    await props.Set(ADAPTER_IFACE, 'Powered', new dbus.Variant('b', true));
  }
}

async function setDiscoveryFilter(bus, adapterPath, mode) {
  const adapterObject = await bus.getProxyObject(BLUEZ_SERVICE, adapterPath);
  const adapter = adapterObject.getInterface(ADAPTER_IFACE);
  const filter = {
    Transport: new dbus.Variant('s', 'le'),
    DuplicateData: new dbus.Variant('b', true),
  };

  if (mode === 'ttlock') {
    filter.UUIDs = new dbus.Variant('as', TTLOCK_UUIDS);
  }

  try {
    await adapter.SetDiscoveryFilter(filter);
  } catch (error) {
    console.log(`SetDiscoveryFilter failed: ${error.message || error}`);
  }
}

async function startDiscovery(bus, adapterPath) {
  const adapterObject = await bus.getProxyObject(BLUEZ_SERVICE, adapterPath);
  const adapter = adapterObject.getInterface(ADAPTER_IFACE);
  await adapter.StartDiscovery();
  return adapter;
}

async function stopDiscovery(adapter) {
  if (!adapter) {
    return;
  }
  try {
    await adapter.StopDiscovery();
  } catch (_error) {}
}

async function connectDevice(bus, path) {
  const startedAt = Date.now();
  const deviceObject = await bus.getProxyObject(BLUEZ_SERVICE, path);
  const device = deviceObject.getInterface(DEVICE_IFACE);
  console.log(`D-Bus connect start for ${path}`);
  await device.Connect();
  console.log(`D-Bus connect completed in ${Date.now() - startedAt}ms`);
  return device;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bus = dbus.systemBus();
  let adapter = null;

  try {
    const { manager, objects } = await getManagedObjects(bus);
    const adapterPath = findAdapterPath(objects, args.adapter);
    if (!adapterPath) {
      throw new Error('No BlueZ adapter found');
    }

    await setAdapterPowered(bus, adapterPath);
    await setDiscoveryFilter(bus, adapterPath, args.mode);
    adapter = await startDiscovery(bus, adapterPath);
    console.log(`BlueZ discovery started on ${adapterPath} mode=${args.mode}`);

    const devicesByPath = new Map();
    const seenAddresses = new Set();

    const printDevice = (device, source) => {
      if (!device?.address) {
        return false;
      }
      if (!seenAddresses.has(device.address)) {
        seenAddresses.add(device.address);
        const suffix = device.name ? ` ${device.name}` : '';
        const uuidSuffix = Array.isArray(device.uuids) && device.uuids.length > 0
          ? ` uuids=${device.uuids.join(',')}`
          : '';
        console.log(`[${source}] ${device.address} rssi=${device.rssi ?? 'n/a'}${suffix}${uuidSuffix}`);
      }
      if (!args.mac) {
        return false;
      }
      return device.address === args.mac;
    };

    let matchedPath = '';

    for (const [path, interfaces] of Object.entries(objects)) {
      const device = parseDeviceInfo(path, interfaces);
      if (!device) {
        continue;
      }
      devicesByPath.set(path, device);
      if (printDevice(device, 'existing') && !matchedPath) {
        matchedPath = path;
      }
    }

    const onInterfacesAdded = (path, interfaces) => {
      const device = parseDeviceInfo(path, interfaces);
      if (!device) {
        return;
      }
      devicesByPath.set(path, device);
      if (printDevice(device, 'discover') && !matchedPath) {
        matchedPath = path;
      }
    };

    const onPropertiesChanged = (iface, changed, _invalidated, path) => {
      if (iface !== DEVICE_IFACE || !devicesByPath.has(path)) {
        return;
      }
      const previous = devicesByPath.get(path);
      const next = {
        ...previous,
        name: Object.prototype.hasOwnProperty.call(changed, 'Name') ? readVariantValue(changed.Name) : previous.name,
        alias: Object.prototype.hasOwnProperty.call(changed, 'Alias') ? readVariantValue(changed.Alias) : previous.alias,
        connected: Object.prototype.hasOwnProperty.call(changed, 'Connected') ? Boolean(readVariantValue(changed.Connected)) : previous.connected,
        rssi: Object.prototype.hasOwnProperty.call(changed, 'RSSI') ? readVariantValue(changed.RSSI) : previous.rssi,
      };
      devicesByPath.set(path, next);
    };

    manager.on('InterfacesAdded', onInterfacesAdded);
    manager.on('PropertiesChanged', onPropertiesChanged);

    const deadline = Date.now() + args.timeoutMs;
    while (Date.now() < deadline && (!args.mac || !matchedPath)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    manager.off('InterfacesAdded', onInterfacesAdded);
    manager.off('PropertiesChanged', onPropertiesChanged);

    if (args.mac && !matchedPath) {
      throw new Error(`Target MAC ${args.mac} not discovered within ${args.timeoutMs}ms`);
    }

    if (args.mac) {
      console.log(`Matched target ${args.mac} via D-Bus at ${matchedPath}`);
    }

    if (args.connect && matchedPath) {
      const device = await connectDevice(bus, matchedPath);
      const deviceObject = await bus.getProxyObject(BLUEZ_SERVICE, matchedPath);
      const props = deviceObject.getInterface('org.freedesktop.DBus.Properties');
      const connected = Boolean(readVariantValue(await props.Get(DEVICE_IFACE, 'Connected')));
      console.log(`Connected property after Connect(): ${connected}`);
      try {
        await device.Disconnect();
        console.log('D-Bus disconnect completed');
      } catch (error) {
        console.log(`D-Bus disconnect failed: ${error.message || error}`);
      }
    }
  } finally {
    await stopDiscovery(adapter);
    bus.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
