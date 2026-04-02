'use strict';

const EventEmitter = require('events');
const { spawn } = require('child_process');
const { TTLockClient, LockedStatus, KeyboardPwdType, PassageModeType } = require('./dist');

const loadData = require('./examples/common/loadData');
const saveData = require('./examples/common/saveData');
const makeOptions = require('./examples/common/options');

const settingsFile = 'lockData.json';
const emitter = new EventEmitter();

let client = null;
let lock = null;
let targetMac = null;
let pausedTargetMac = null;
let startPromise = null;
let actionQueue = Promise.resolve();
let reconnectTimer = null;
let currentScannerType = 'noble';
let lastLockDisconnectAt = 0;
const wiredLocks = new WeakSet();
const discoveredLocks = new Map();
let cachedLockData = [];
const fingerprintCacheByAddress = new Map();

let state = {
  started: false,
  ready: false,
  connected: false,
  status: 'idle',
  address: null,
  name: null,
  battery: null,
  is_locked: null,
  last_action: null,
  last_error: null,
  logs: [],
  fingerprints: [],
  passcodes: [],
  passage_modes: [],
  fingerprint_scan: {
    active: false,
    progress_count: 0,
    message: null,
  },
  init_scanning: false,
  discovered_locks: [],
  managed_locks: [],
  updated_at: null,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const autoConnectMonitor = process.env.TTLOCK_WEBUI_AUTO_CONNECT === '1';
const isolatedScanEnabled = process.env.TTLOCK_WEBUI_ENABLE_ISOLATED_SCAN === '1';

function readPositiveNumberEnv(name, fallback) {
  const rawValue = process.env[name];
  if (typeof rawValue === 'undefined' || rawValue === '') {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

const fingerprintReadTimeoutMs = Number(process.env.TTLOCK_FINGERPRINT_READ_TIMEOUT_MS || 15000);
const monitorDiscoveryTimeoutMs = readPositiveNumberEnv('TTLOCK_DISCOVERY_TIMEOUT_MS', 3000);
const activeScanDiscoveryTimeoutMs = readPositiveNumberEnv('TTLOCK_ACTIVE_SCAN_TIMEOUT_MS', 5000);
const isolatedScanDiscoveryTimeoutMs = readPositiveNumberEnv('TTLOCK_ISOLATED_SCAN_TIMEOUT_MS', 6000);
const postRestartDiscoveryTimeoutMs = readPositiveNumberEnv('TTLOCK_POST_RESTART_DISCOVERY_TIMEOUT_MS', 3000);
const connectTimeoutSeconds = readPositiveNumberEnv('TTLOCK_CONNECT_TIMEOUT_SECONDS', 3);
const connectRetryDelayMs = readPositiveNumberEnv('TTLOCK_CONNECT_RETRY_DELAY_MS', 700);
const linuxWakeWindowMs = readPositiveNumberEnv('TTLOCK_LINUX_WAKE_WINDOW_MS', 12000);
const linuxWakeRetryDelayMs = readPositiveNumberEnv('TTLOCK_LINUX_WAKE_RETRY_DELAY_MS', 1200);
const linuxWakeRediscoveryTimeoutMs = readPositiveNumberEnv('TTLOCK_LINUX_WAKE_REDISCOVERY_TIMEOUT_MS', 1800);
const linuxWakeDisconnectCooldownMs = readPositiveNumberEnv('TTLOCK_LINUX_WAKE_DISCONNECT_COOLDOWN_MS', 1500);
const linuxWakeMaxAttempts = readPositiveNumberEnv('TTLOCK_LINUX_WAKE_MAX_ATTEMPTS', 6);
const busyStatuses = new Set([
  'starting',
  'connecting',
  'unlocking',
  'locking',
  'clearing_passage',
  'getting_passage',
  'setting_passage',
  'deleting_passage',
  'init_scanning',
  'stopping_init_scan',
  'initializing_lock',
  'adding_fingerprint',
  'getting_passcodes',
  'adding_passcode',
  'deleting_passcode',
  'canceling_fingerprint',
  'getting_fingerprints',
  'deleting_fingerprint',
  'resetting_lock',
  'reconnecting',
  'refreshing',
  'selecting_lock',
]);

function formatFingerprintDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}`;
}

function getDefaultFingerprintWindow() {
  const start = new Date();
  const end = new Date(start.getTime());
  end.setFullYear(end.getFullYear() + 10);
  return {
    startDate: formatFingerprintDate(start),
    endDate: formatFingerprintDate(end),
  };
}

function normalizeAddress(address) {
  return typeof address === 'string' ? address.toUpperCase() : null;
}

async function prepareBtServiceWithRetry(targetClient, label, attempts = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const ready = await targetClient.prepareBTService();
      if (ready) {
        return true;
      }
    } catch (error) {
      appendLog(`${label} prepareBTService failed (attempt ${attempt}/${attempts}): ${error.message || error}`);
    }

    if (attempt < attempts) {
      await delay(delayMs);
    }
  }
  return false;
}

function emitState(patch = {}) {
  state = {
    ...state,
    ...patch,
    managed_locks: getManagedLocks(),
    updated_at: new Date().toISOString(),
  };
  emitter.emit('update', getState());
}

function appendLog(message) {
  console.log(message);
  state = {
    ...state,
    logs: [
      { timestamp: new Date().toISOString(), message },
      ...state.logs,
    ].slice(0, 50),
    updated_at: new Date().toISOString(),
  };
  emitter.emit('update', getState());
}

function getDiscoveredLocks() {
  return Array.from(discoveredLocks.values()).sort((a, b) => {
    if (a.initialized !== b.initialized) {
      return a.initialized ? 1 : -1;
    }
    return (b.rssi || -999) - (a.rssi || -999);
  });
}

function getSavedLockDataMap() {
  const savedLocks = new Map();
  for (const item of cachedLockData) {
    const address = normalizeAddress(item?.address);
    if (!address) {
      continue;
    }
    savedLocks.set(address, item);
  }
  return savedLocks;
}

function loadFingerprintCacheFromLockData() {
  fingerprintCacheByAddress.clear();
  for (const item of cachedLockData) {
    const address = normalizeAddress(item?.address);
    const cachedFingerprints = Array.isArray(item?.fingerprint_cache) ? item.fingerprint_cache : null;
    if (!address || !cachedFingerprints) {
      continue;
    }
    fingerprintCacheByAddress.set(address, cachedFingerprints);
  }
}

function getCachedFingerprints(address = targetMac) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return [];
  }
  const cached = fingerprintCacheByAddress.get(normalizedAddress);
  return Array.isArray(cached) ? cached.map((item) => ({ ...item })) : [];
}

function setCachedFingerprints(address, fingerprints) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return;
  }

  const nextFingerprints = Array.isArray(fingerprints)
    ? fingerprints.map((item) => ({ ...item }))
    : [];
  fingerprintCacheByAddress.set(normalizedAddress, nextFingerprints);

  cachedLockData = cachedLockData.map((item) => {
    if (normalizeAddress(item?.address) !== normalizedAddress) {
      return item;
    }
    return {
      ...item,
      fingerprint_cache: nextFingerprints,
    };
  });
}

function mergeFingerprintNamesWithLive(address, liveFingerprints) {
  const normalizedAddress = normalizeAddress(address);
  const live = Array.isArray(liveFingerprints) ? liveFingerprints : [];
  const cachedByNumber = new Map(
    getCachedFingerprints(normalizedAddress)
      .filter((item) => item?.fpNumber)
      .map((item) => [String(item.fpNumber), item])
  );

  return live.map((item) => {
    const fpNumber = item?.fpNumber ? String(item.fpNumber) : '';
    const cached = cachedByNumber.get(fpNumber);
    if (!cached?.name) {
      return { ...item };
    }
    return {
      ...item,
      name: cached.name,
    };
  });
}

function normalizeImportedLockData(lockData) {
  if (!Array.isArray(lockData)) {
    throw new Error('lockData must be a JSON array');
  }

  const seenAddresses = new Set();
  return lockData.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Lock entry #${index + 1} must be an object`);
    }

    const address = normalizeAddress(item.address);
    if (!address) {
      throw new Error(`Lock entry #${index + 1} is missing address`);
    }
    if (seenAddresses.has(address)) {
      throw new Error(`Duplicate lock address ${address}`);
    }
    seenAddresses.add(address);

    return {
      ...item,
      address,
      fingerprint_cache: Array.isArray(item.fingerprint_cache)
        ? item.fingerprint_cache.map((fingerprint) => ({ ...fingerprint }))
        : [],
    };
  });
}

function resolveFingerprintsForUi(address, liveFingerprints, options = {}) {
  const normalizedAddress = normalizeAddress(address);
  const live = mergeFingerprintNamesWithLive(address, liveFingerprints);
  if (live.length > 0) {
    setCachedFingerprints(normalizedAddress, live);
    return {
      fingerprints: live,
      stale: false,
    };
  }

  const cached = getCachedFingerprints(normalizedAddress);
  if (cached.length > 0) {
    if (options.logFallback !== false) {
      appendLog(`Lock returned an empty fingerprint list; keeping ${cached.length} cached fingerprint(s) for ${normalizedAddress}`);
    }
    return {
      fingerprints: cached,
      stale: true,
    };
  }

  setCachedFingerprints(normalizedAddress, []);
  return {
    fingerprints: [],
    stale: false,
  };
}

async function readFingerprintsWithTimeout(target, timeoutMs = fingerprintReadTimeoutMs) {
  let timeoutHandle = null;
  try {
    const result = await Promise.race([
      target.getFingerprints(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Get fingerprints timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return {
      fingerprints: Array.isArray(result) ? result : [],
      timedOut: false,
      failed: false,
    };
  } catch (error) {
    appendLog(`Get fingerprints fallback: ${error.message || error}`);
    try {
      if (target?.isConnected?.()) {
        await target.disconnect();
      }
    } catch (_error) {}
    return {
      fingerprints: getCachedFingerprints(target?.getAddress?.()),
      timedOut: /timed out/i.test(String(error?.message || error)),
      failed: true,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function getManagedLocks() {
  const savedLocks = getSavedLockDataMap();
  const addresses = Array.from(savedLocks.keys());

  return addresses.map((address) => {
    const savedLock = savedLocks.get(address);
    const device = client?.getLock(address);
    const liveLockData = typeof device?.getLockData === 'function' ? device.getLockData() : savedLock;
    const discovered = discoveredLocks.get(address);

    return {
      address,
      name: savedLock?.name || discovered?.name || `TTLock ${address}`,
      saved: Boolean(savedLock),
      discovered: Boolean(discovered),
      initialized: discovered?.initialized ?? Boolean(savedLock),
      paired: discovered?.paired ?? Boolean(savedLock),
      connected: typeof device?.isConnected === 'function' ? device.isConnected() : false,
      active: address === targetMac,
      rssi: discovered?.rssi ?? liveLockData?.rssi ?? null,
      battery: liveLockData?.battery ?? null,
      is_locked: toLockedBoolean(liveLockData?.lockedStatus ?? null),
    };
  }).sort((a, b) => {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }
    if (a.saved !== b.saved) {
      return a.saved ? -1 : 1;
    }
    return a.address.localeCompare(b.address);
  });
}

function getManagedLock(address) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return null;
  }
  return getManagedLocks().find((item) => item.address === normalizedAddress) || null;
}

function setActiveLock(address, patch = {}) {
  const normalizedAddress = normalizeAddress(address);
  targetMac = normalizedAddress;

  if (!normalizedAddress) {
    lock = null;
    emitState({
      address: null,
      name: null,
      battery: null,
      is_locked: null,
      connected: false,
      ...patch,
    });
    return;
  }

  const selectedLock = client?.getLock(normalizedAddress);
  if (selectedLock) {
    lock = selectedLock;
    wireLockEvents(lock);
  } else if (lock && normalizeAddress(lock.getAddress?.()) !== normalizedAddress) {
    lock = null;
  }

  const managedLock = getManagedLock(normalizedAddress);
  emitState({
    address: normalizedAddress,
    name: managedLock?.name || `TTLock ${normalizedAddress}`,
    battery: managedLock?.battery ?? null,
    is_locked: typeof managedLock?.is_locked === 'boolean' ? managedLock.is_locked : null,
    connected: Boolean(managedLock?.connected),
    fingerprints: getCachedFingerprints(normalizedAddress),
    ...patch,
  });
}

function emitDiscoveredLocks() {
  emitState({
    discovered_locks: getDiscoveredLocks(),
  });
}

function isBusy() {
  return busyStatuses.has(state.status);
}

function toLockedBoolean(lockedStatus) {
  if (lockedStatus === LockedStatus.LOCKED || lockedStatus === 0) {
    return true;
  }
  if (lockedStatus === LockedStatus.UNLOCKED || lockedStatus === 1) {
    return false;
  }
  return null;
}

function shouldUseLock(target) {
  const address = normalizeAddress(target?.getAddress?.());
  return Boolean(address) && Boolean(targetMac) && address === targetMac;
}

function recordDiscoveredLock(target) {
  if (!target || typeof target.getAddress !== 'function') {
    return;
  }

  const address = normalizeAddress(target.getAddress());
  if (!address) {
    return;
  }

  discoveredLocks.set(address, {
    address,
    name: typeof target.getName === 'function' ? target.getName() : null,
    rssi: typeof target.getRssi === 'function' ? target.getRssi() : null,
    initialized: typeof target.isInitialized === 'function' ? target.isInitialized() : null,
    paired: typeof target.isPaired === 'function' ? target.isPaired() : null,
    connected: typeof target.isConnected === 'function' ? target.isConnected() : null,
  });
  emitDiscoveredLocks();
}

function syncStateFromLock(target) {
  if (!target) {
    return;
  }

  recordDiscoveredLock(target);

  if (!shouldUseLock(target)) {
    emitState({});
    return;
  }

  const lockData = typeof target.getLockData === 'function' ? target.getLockData() : undefined;
  const json = typeof target.toJSON === 'function' ? target.toJSON(true) : {};
  const nextLocked = toLockedBoolean(
    lockData?.lockedStatus ?? json.lockedStatus ?? null
  );

  emitState({
    address: target.getAddress ? target.getAddress() : state.address,
    name: target.getName ? target.getName() : state.name,
    connected: typeof target.isConnected === 'function' ? target.isConnected() : state.connected,
    battery: lockData?.battery ?? json.batteryCapacity ?? state.battery,
    is_locked: nextLocked,
  });
}

async function persistLockData() {
  if (!client) {
    await saveData(settingsFile, cachedLockData);
    return;
  }
  const previousByAddress = new Map(
    cachedLockData
      .map((item) => [normalizeAddress(item?.address), item])
      .filter(([address]) => Boolean(address))
  );

  cachedLockData = client.getLockData().map((item) => {
    const address = normalizeAddress(item?.address);
    const previous = previousByAddress.get(address) || {};
    const fingerprintCache = getCachedFingerprints(address);
    return {
      ...previous,
      ...item,
      name: previous?.name || item?.name,
      fingerprint_cache: fingerprintCache,
    };
  });
  await saveData(settingsFile, cachedLockData);
}

function scheduleReconnect() {
  if (!autoConnectMonitor || reconnectTimer || !lock || state.init_scanning || !targetMac) {
    return;
  }

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    if (!lock || lock.isConnected()) {
      return;
    }

    await ensureMonitorRunning(false);

    await safeConnect(1);
  }, 2000);
}

async function ensureMonitorRunning(logOnStart = true) {
  if (!client || state.init_scanning) {
    return false;
  }

  if (client.isMonitoring()) {
    return true;
  }

  if (client.isScanning()) {
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const started = await client.startMonitor();
      if (started || client.isMonitoring()) {
        emitState({
          started: true,
          ready: true,
          status: targetMac ? 'monitoring' : 'idle',
          last_error: null,
        });
        if (logOnStart) {
          appendLog('Bluetooth monitor started');
        }
        return true;
      }
    } catch (error) {
      emitState({
        last_error: error.message || String(error),
      });
      appendLog(`Unable to start monitor (attempt ${attempt}/3): ${error.message || error}`);
    }
    await delay(500);
  }

  emitState({
    last_error: 'Unable to start Bluetooth monitor',
  });
  return false;
}

async function safeConnect(retries = 3) {
  if (!lock) {
    return false;
  }

  const useLinuxWakeWindow = currentScannerType === 'bluez-dbus';
  const wakeWindowDeadline = useLinuxWakeWindow ? Date.now() + linuxWakeWindowMs : 0;
  const maxAttempts = useLinuxWakeWindow ? Math.max(retries, linuxWakeMaxAttempts) : retries;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (lock.isConnected()) {
        syncStateFromLock(lock);
        return true;
      }

      if (useLinuxWakeWindow) {
        const cooldownRemainingMs = (lastLockDisconnectAt + linuxWakeDisconnectCooldownMs) - Date.now();
        if (cooldownRemainingMs > 0) {
          appendLog(`Waiting ${cooldownRemainingMs}ms for lock BLE cooldown before retry`);
          await delay(cooldownRemainingMs);
        }
      }

      emitState({
        status: 'connecting',
        last_error: null,
      });
      appendLog(`Connecting to lock (attempt ${attempt}/${maxAttempts})`);

      const connected = await lock.connectFast(connectTimeoutSeconds);
      if (connected) {
        syncStateFromLock(lock);
        emitState({
          ready: true,
          connected: true,
          status: 'ready',
          last_error: null,
        });
        appendLog('Connected to lock');
        return true;
      }
    } catch (error) {
      emitState({
        last_error: error.message || String(error),
      });
      appendLog(`Connect failed: ${error.message || error}`);
    }

    const remainingWakeWindowMs = wakeWindowDeadline - Date.now();
    const canKeepWakeRetrying = useLinuxWakeWindow
      && remainingWakeWindowMs > 0
      && attempt < maxAttempts;

    if (canKeepWakeRetrying) {
      appendLog(`Lock may be sleeping; keeping wake window open for ${Math.ceil(remainingWakeWindowMs / 1000)}s`);
      try {
        await waitForTargetLockDiscoveryWithActiveScan(
          Math.min(linuxWakeRediscoveryTimeoutMs, activeScanDiscoveryTimeoutMs),
          Math.min(monitorDiscoveryTimeoutMs, 1200),
        );
      } catch (_error) {}
      await delay(linuxWakeRetryDelayMs);
      continue;
    }

    if (attempt >= retries && !useLinuxWakeWindow) {
      break;
    }

    if (useLinuxWakeWindow && attempt < maxAttempts) {
      await delay(connectRetryDelayMs);
    } else if (!useLinuxWakeWindow && attempt < retries) {
      await delay(connectRetryDelayMs);
    }
  }

  emitState({
    connected: false,
    status: 'monitoring',
  });
  return false;
}

async function waitForTargetLockDiscovery(timeoutMs = monitorDiscoveryTimeoutMs) {
  await start();

  if (!targetMac) {
    throw new Error('No target lock configured');
  }

  if (lock && normalizeAddress(lock.getAddress?.()) === targetMac) {
    return lock;
  }

  const deadline = Date.now() + timeoutMs;
  do {
    const discoveredLock = client?.getLock(targetMac);
    if (discoveredLock) {
      lock = discoveredLock;
      wireLockEvents(lock);
      syncStateFromLock(lock);
      return lock;
    }
    await delay(250);
  } while (Date.now() < deadline);

  throw new Error('Target lock not discovered yet');
}

async function waitForTargetLockDiscoveryWithActiveScan(activeScanTimeoutMs = activeScanDiscoveryTimeoutMs, monitorTimeoutMs = monitorDiscoveryTimeoutMs) {
  try {
    return await waitForTargetLockDiscovery(monitorTimeoutMs);
  } catch (error) {
    if (!targetMac || !client) {
      throw error;
    }

    appendLog(`Target lock ${targetMac} was not discovered via monitor, trying active scan...`);

    try {
      if (client.isMonitoring()) {
        await client.stopMonitor();
      }
    } catch (_error) {}

    const deadline = Date.now() + activeScanTimeoutMs;
    let started = false;
    let foundViaActiveScan = false;

    try {
      started = await client.startScanLock();
      if (!started) {
        throw error;
      }

      do {
        const discoveredLock = client.getLock(targetMac);
        if (discoveredLock) {
          foundViaActiveScan = true;
          lock = discoveredLock;
          wireLockEvents(lock);
          syncStateFromLock(lock);
          appendLog(`Discovered target lock ${targetMac} via active scan`);
          return lock;
        }
        await delay(250);
      } while (Date.now() < deadline);
    } finally {
      try {
        if (client.isScanning()) {
          await client.stopScanLock();
        }
      } catch (_error) {}

      if (!state.init_scanning && !foundViaActiveScan) {
        await ensureMonitorRunning(false);
      }
    }

    throw error;
  }
}

async function waitForTargetLockDiscoveryWithIsolatedScan(timeoutMs = isolatedScanDiscoveryTimeoutMs) {
  if (!targetMac) {
    throw new Error('No target lock configured');
  }

  const lockData = await loadData(settingsFile);
  const options = makeOptions(lockData);
  const isolatedClient = new TTLockClient(options);

  try {
    appendLog(`Target lock ${targetMac} was not discovered via active scan, trying isolated scan...`);
    const ready = await prepareBtServiceWithRetry(isolatedClient, 'Isolated scan client', 2, 800);
    if (!ready) {
      throw new Error('Bluetooth adapter is not ready for isolated scan');
    }

    const discoveredLock = await discoverLockForInit(isolatedClient, targetMac, timeoutMs);
    if (!discoveredLock) {
      throw new Error(`Target lock ${targetMac} not found during isolated scan`);
    }

    recordDiscoveredLock(discoveredLock);
    appendLog(`Discovered target lock ${targetMac} via isolated scan`);
    return true;
  } finally {
    try {
      if (isolatedClient.isScanning()) {
        await isolatedClient.stopScanLock();
      }
    } catch (_error) {}
    try {
      isolatedClient.stopBTService();
    } catch (_error) {}
  }
}

async function ensureConnectedLock() {
  let target;
  try {
    target = await waitForTargetLockDiscoveryWithActiveScan(activeScanDiscoveryTimeoutMs, monitorDiscoveryTimeoutMs);
  } catch (error) {
    if (!isolatedScanEnabled) {
      appendLog(`Target lock ${targetMac} is still unavailable after active scan; isolated scan is disabled`);
      throw error;
    }

    await waitForTargetLockDiscoveryWithIsolatedScan(isolatedScanDiscoveryTimeoutMs);
    await disposeMainClient();
    await start();
    target = await waitForTargetLockDiscovery(postRestartDiscoveryTimeoutMs);
  }

  if (!target.isInitialized() || !target.isPaired()) {
    throw new Error('Target lock is not paired');
  }
  if (!target.isConnected()) {
    const connected = await safeConnect(2);
    if (!connected) {
      throw new Error('Unable to connect to lock');
    }
  }

  return target;
}

async function fetchLatestStatus(force = false) {
  if (!lock) {
    return getState();
  }

  syncStateFromLock(lock);

  if (force && lock.isConnected()) {
    try {
      const lockedStatus = await lock.getLockStatus(true);
      emitState({
        is_locked: toLockedBoolean(lockedStatus),
      });
    } catch (error) {
      emitState({
        last_error: error.message || String(error),
      });
    }
  }

  return getState();
}

async function queueAction(actionName, action) {
  const run = async () => {
    emitState({
      status: actionName,
      last_action: actionName,
      last_error: null,
    });

    try {
      const result = await action();
      await persistLockData();
      syncStateFromLock(lock);
      const nextStatus = state.init_scanning
        ? 'init_scanning'
        : (lock?.isConnected() ? 'ready' : (targetMac ? 'monitoring' : 'idle'));
      emitState({
        status: nextStatus,
      });
      return result;
    } catch (error) {
      emitState({
        status: 'error',
        last_error: error.message || String(error),
      });
      appendLog(`${actionName} failed: ${error.message || error}`);
      throw error;
    }
  };

  const task = actionQueue.catch(() => {}).then(run);
  actionQueue = task.catch(() => {});
  return task;
}

function wireLockEvents(target) {
  if (wiredLocks.has(target)) {
    return;
  }
  wiredLocks.add(target);

  target.on('connected', async () => {
    syncStateFromLock(target);
    emitState({
      ready: true,
      connected: true,
      status: 'ready',
      last_error: null,
    });
    appendLog('Lock connected');
  });

  target.on('disconnected', async () => {
    lastLockDisconnectAt = Date.now();
    emitState({
      connected: false,
      status: state.init_scanning ? 'init_scanning' : (targetMac ? 'monitoring' : 'idle'),
    });
    appendLog('Lock disconnected');

    if (state.init_scanning || !targetMac) {
      return;
    }

    await ensureMonitorRunning(false);

    scheduleReconnect();
  });

  target.on('locked', () => {
    emitState({
      is_locked: true,
    });
    appendLog('Lock reported locked');
  });

  target.on('unlocked', () => {
    emitState({
      is_locked: false,
    });
    appendLog('Lock reported unlocked');
  });

  target.on('updated', async (updatedLock, paramsChanged) => {
    syncStateFromLock(updatedLock);

    if (paramsChanged.newEvents && updatedLock.isConnected()) {
      try {
        const operations = await updatedLock.getOperationLog();
        for (const operation of operations) {
          appendLog(`Operation ${operation.recordType} at ${operation.operateDate}`);
        }
      } catch (error) {
        appendLog(`Unable to read operation log: ${error.message || error}`);
      }
    }
  });

  target.on('scanFRStart', () => {
    emitState({
      fingerprint_scan: {
        active: true,
        progress_count: 0,
        message: 'Place your finger on the lock sensor.',
      },
    });
    appendLog('Fingerprint scan started. Place your finger on the lock sensor.');
  });

  target.on('scanFRProgress', () => {
    const currentCount = Number(state.fingerprint_scan?.progress_count || 0) + 1;
    emitState({
      fingerprint_scan: {
        active: true,
        progress_count: currentCount,
        message: `Fingerprint scan ${currentCount} captured.`,
      },
    });
    appendLog('Fingerprint scan progress updated');
  });

  target.on('lockReset', (address) => {
    const normalizedAddress = normalizeAddress(address);
    if (normalizeAddress(address) === normalizeAddress(lock?.getAddress?.())) {
      lock = null;
    }
    cachedLockData = cachedLockData.filter((item) => normalizeAddress(item?.address) !== normalizedAddress);
    fingerprintCacheByAddress.delete(normalizedAddress);
    if (normalizedAddress === targetMac) {
      targetMac = cachedLockData[0]?.address ? normalizeAddress(cachedLockData[0].address) : null;
    }
    pausedTargetMac = null;
    discoveredLocks.delete(normalizedAddress);
    emitState({
      connected: false,
      ready: true,
      status: targetMac ? 'monitoring' : 'idle',
      address: targetMac,
      name: getManagedLock(targetMac)?.name || null,
      battery: getManagedLock(targetMac)?.battery ?? null,
      is_locked: getManagedLock(targetMac)?.is_locked ?? null,
      fingerprints: [],
      fingerprint_scan: {
        active: false,
        progress_count: 0,
        message: null,
      },
    });
    emitDiscoveredLocks();
    appendLog(`Lock reset completed for ${address}`);
  });
}

async function start() {
  if (startPromise) {
    await ensureMonitorRunning();
    return startPromise;
  }

  startPromise = (async () => {
    try {
      const lockData = await loadData(settingsFile);
      cachedLockData = Array.isArray(lockData) ? lockData : [];
      loadFingerprintCacheFromLockData();
      const options = makeOptions(lockData);
      currentScannerType = typeof options?.scannerType === 'string' ? options.scannerType : 'noble';

      targetMac = normalizeAddress(
        process.env.TARGET_MAC || targetMac || (cachedLockData[0] && cachedLockData[0].address)
      );
      const selectedLock = getManagedLock(targetMac);

      emitState({
        started: true,
        status: 'starting',
        address: targetMac,
        name: selectedLock?.name || null,
        battery: selectedLock?.battery ?? null,
        is_locked: selectedLock?.is_locked ?? null,
        fingerprints: getCachedFingerprints(targetMac),
        ready: false,
        connected: false,
      });

      client = new TTLockClient(options);

      client.on('foundLock', async (foundLock) => {
        wireLockEvents(foundLock);
        recordDiscoveredLock(foundLock);

        if (state.init_scanning) {
          return;
        }

        if (!shouldUseLock(foundLock)) {
          return;
        }

        lock = foundLock;
        syncStateFromLock(lock);
        appendLog(`Discovered target lock ${lock.getAddress()}`);

        if (autoConnectMonitor && lock.isInitialized() && lock.isPaired() && !lock.isConnected()) {
          await safeConnect(2);
        }
      });

      client.on('updatedLockData', async () => {
        try {
          await persistLockData();
        } catch (error) {
          appendLog(`Unable to save lock data: ${error.message || error}`);
        }
        if (!targetMac && cachedLockData[0]?.address) {
          setActiveLock(cachedLockData[0].address);
        }
        syncStateFromLock(lock);
      });

      const ready = await prepareBtServiceWithRetry(client, 'Main client', 3, 1200);
      if (!ready) {
        emitState({
          ready: false,
          started: false,
          status: 'idle',
          last_error: 'Bluetooth adapter is not ready',
        });
        appendLog('Bluetooth adapter is not ready');
        await disposeMainClient();
        return getState();
      }

      await ensureMonitorRunning();

      return getState();
    } catch (error) {
      await disposeMainClient();
      emitState({
        started: false,
        ready: false,
        connected: false,
        status: 'idle',
        last_error: error.message || String(error),
      });
      throw error;
    }
  })();

  return startPromise;
}

async function pause(reason = 'idle') {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (lock?.isConnected()) {
    try {
      await lock.disconnect();
    } catch (error) {}
  }

  if (client?.isMonitoring()) {
    try {
      await client.stopMonitor();
    } catch (error) {}
  }

  if (client?.isScanning()) {
    try {
      await client.stopScanLock();
    } catch (error) {}
  }

  emitState({
    connected: false,
    status: 'idle',
    last_error: null,
  });
  appendLog(`Bluetooth monitor paused (${reason})`);
  return getState();
}

async function suspend(reason = 'idle') {
  const wasActive = Boolean(client || startPromise || lock);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  await disposeMainClient();
  discoveredLocks.clear();

  emitState({
    started: false,
    ready: false,
    connected: false,
    status: 'idle',
    name: null,
    battery: null,
    is_locked: null,
    fingerprints: [],
    passcodes: [],
    passage_modes: [],
    fingerprint_scan: {
      active: false,
      progress_count: 0,
      message: null,
    },
    discovered_locks: [],
    last_error: null,
  });

  if (wasActive) {
    appendLog(`Bluetooth monitor stopped (${reason})`);
  }

  return getState();
}

async function lockDoor() {
  return queueAction('locking', async () => {
    const target = await ensureConnectedLock();
    const ok = await target.lock();
    if (!ok) {
      throw new Error('Lock command failed');
    }
    emitState({
      is_locked: true,
    });
    appendLog('Lock command succeeded');
    return { ok: true };
  });
}

async function unlockDoor() {
  return queueAction('unlocking', async () => {
    const target = await ensureConnectedLock();
    const ok = await target.unlock();
    if (!ok) {
      throw new Error('Unlock command failed');
    }
    emitState({
      is_locked: false,
    });
    appendLog('Unlock command succeeded');
    return { ok: true };
  });
}

async function clearPassageMode() {
  return queueAction('clearing_passage', async () => {
    const target = await ensureConnectedLock();
    const result = await target.clearPassageMode();
    emitState({
      passage_modes: [],
    });
    appendLog('Clear passage mode command succeeded');
    return {
      ok: true,
      result,
    };
  });
}

async function getPassageMode() {
  return queueAction('getting_passage', async () => {
    const target = await ensureConnectedLock();
    const result = await target.getPassageMode();
    const passageModes = Array.isArray(result) ? result : [];
    emitState({
      passage_modes: passageModes,
    });
    appendLog(`Loaded ${passageModes.length} passage mode rule(s)`);
    return {
      ok: true,
      passage_modes: passageModes,
    };
  });
}

async function setPassageMode(data) {
  return queueAction('setting_passage', async () => {
    if (!data || !String(data.startHour || '').trim() || !String(data.endHour || '').trim()) {
      throw new Error('Passage mode start/end time is required');
    }
    const target = await ensureConnectedLock();
    const ok = await target.setPassageMode(data);
    if (!ok) {
      throw new Error('Set passage mode failed');
    }
    const result = await target.getPassageMode();
    const passageModes = Array.isArray(result) ? result : [];
    emitState({
      passage_modes: passageModes,
    });
    appendLog('Set passage mode command succeeded');
    return {
      ok: true,
      passage_modes: passageModes,
    };
  });
}

async function deletePassageMode(data) {
  return queueAction('deleting_passage', async () => {
    if (!data || !String(data.startHour || '').trim() || !String(data.endHour || '').trim()) {
      throw new Error('Passage mode start/end time is required');
    }
    const target = await ensureConnectedLock();
    const ok = await target.deletePassageMode(data);
    if (!ok) {
      throw new Error('Delete passage mode failed');
    }
    const result = await target.getPassageMode();
    const passageModes = Array.isArray(result) ? result : [];
    emitState({
      passage_modes: passageModes,
    });
    appendLog('Delete passage mode command succeeded');
    return {
      ok: true,
      passage_modes: passageModes,
    };
  });
}

async function getPasscodes() {
  return queueAction('getting_passcodes', async () => {
    const target = await ensureConnectedLock();
    const result = await target.getPassCodes();
    const passcodes = Array.isArray(result) ? result : [];
    emitState({
      passcodes,
    });
    appendLog(`Loaded ${passcodes.length} passcode(s)`);
    return {
      ok: true,
      passcodes,
    };
  });
}

async function addPasscode(passCode, startDate, endDate, type = KeyboardPwdType.PWD_TYPE_PERMANENT) {
  return queueAction('adding_passcode', async () => {
    const normalizedPassCode = typeof passCode === 'string' ? passCode.trim() : '';
    if (!normalizedPassCode) {
      throw new Error('Passcode is required');
    }
    const target = await ensureConnectedLock();
    const ok = await target.addPassCode(type, normalizedPassCode, startDate, endDate);
    if (!ok) {
      throw new Error('Add passcode failed');
    }
    const result = await target.getPassCodes();
    const passcodes = Array.isArray(result) ? result : [];
    emitState({
      passcodes,
    });
    appendLog(`Passcode ${normalizedPassCode} added`);
    return {
      ok: true,
      passcodes,
      passCode: normalizedPassCode,
    };
  });
}

async function deletePasscode(passCode, type = KeyboardPwdType.PWD_TYPE_PERMANENT) {
  return queueAction('deleting_passcode', async () => {
    const normalizedPassCode = typeof passCode === 'string' ? passCode.trim() : '';
    if (!normalizedPassCode) {
      throw new Error('Passcode is required');
    }
    const target = await ensureConnectedLock();
    const ok = await target.deletePassCode(type, normalizedPassCode);
    if (!ok) {
      throw new Error('Delete passcode failed');
    }
    const result = await target.getPassCodes();
    const passcodes = Array.isArray(result) ? result : [];
    emitState({
      passcodes,
    });
    appendLog(`Passcode ${normalizedPassCode} deleted`);
    return {
      ok: true,
      passcodes,
      passCode: normalizedPassCode,
    };
  });
}

async function startInitScan() {
  return queueAction('init_scanning', async () => {
    await start();
    discoveredLocks.clear();
    pausedTargetMac = targetMac;
    targetMac = null;
    emitState({
      init_scanning: true,
      connected: false,
      status: 'init_scanning',
      address: null,
      name: null,
      battery: null,
      is_locked: null,
      discovered_locks: [],
    });

    if (client?.isMonitoring()) {
      await client.stopMonitor();
    }
    if (lock?.isConnected()) {
      await lock.disconnect();
    }

    const started = await client.startScanLock();
    if (!started) {
      throw new Error('Unable to start init scan');
    }
    emitDiscoveredLocks();
    appendLog('Init scan started');
    return {
      ok: true,
      discovered_locks: getDiscoveredLocks(),
    };
  });
}

async function stopInitScan() {
  return queueAction('stopping_init_scan', async () => {
    await start();
    if (client?.isScanning()) {
      await client.stopScanLock();
    }

    if (!targetMac && pausedTargetMac) {
      targetMac = pausedTargetMac;
    }
    pausedTargetMac = null;

    if (targetMac) {
      await ensureMonitorRunning();
    }

    setActiveLock(targetMac, {
      init_scanning: false,
      status: targetMac ? 'monitoring' : 'idle',
    });
    appendLog('Init scan stopped');
    return { ok: true };
  });
}

async function disposeMainClient() {
  if (lock?.isConnected()) {
    try {
      await lock.disconnect();
    } catch (error) {}
  }

  if (client?.isMonitoring()) {
    try {
      await client.stopMonitor();
    } catch (error) {}
  }

  if (client?.isScanning()) {
    try {
      await client.stopScanLock();
    } catch (error) {}
  }

  if (client) {
    try {
      client.stopBTService();
    } catch (error) {}
  }

  client = null;
  lock = null;
  startPromise = null;
}

async function discoverLockForInit(initClient, normalizedAddress, timeoutMs = 15000) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      initClient.off('foundLock', onFoundLock);
      try {
        if (initClient.isScanning()) {
          await initClient.stopScanLock();
        }
      } catch (error) {}
    };

    const finish = async (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      await cleanup();
      handler(value);
    };

    const onFoundLock = async (foundLock) => {
      const foundAddress = normalizeAddress(foundLock?.getAddress?.());
      if (foundAddress !== normalizedAddress) {
        return;
      }
      await finish(resolve, foundLock);
    };

    initClient.on('foundLock', onFoundLock);

    try {
      const started = await initClient.startScanLock();
      if (!started) {
        await finish(reject, new Error('Unable to start isolated init scan'));
        return;
      }
    } catch (error) {
      await finish(reject, error);
      return;
    }

    timer = setTimeout(() => {
      finish(reject, new Error(`Lock ${normalizedAddress} not found during isolated init scan`));
    }, timeoutMs);
  });
}

async function initNewLock(address) {
  return queueAction('initializing_lock', async () => {
    const normalizedAddress = normalizeAddress(address);
    if (!normalizedAddress) {
      throw new Error('Lock address is required');
    }

    appendLog(`Init requested for ${normalizedAddress}`);

    let initialized = false;

    emitState({
      init_scanning: true,
      connected: false,
      ready: false,
      status: 'initializing_lock',
      address: normalizedAddress,
      last_error: null,
    });

    try {
      await disposeMainClient();
      await delay(1500);
      appendLog(`Starting helper process for init ${normalizedAddress}`);
      await runInitHelper(normalizedAddress);
      cachedLockData = await loadData(settingsFile);
      loadFingerprintCacheFromLockData();
      await saveData(settingsFile, cachedLockData);
      initialized = true;
      targetMac = normalizedAddress;
      pausedTargetMac = null;
      discoveredLocks.clear();
      emitDiscoveredLocks();
      appendLog(`Lock ${normalizedAddress} initialized successfully`);
    } finally {
      await disposeMainClient();

      if (initialized) {
        targetMac = normalizedAddress;
        pausedTargetMac = null;
      } else if (pausedTargetMac || targetMac) {
        if (initialized) {
          targetMac = normalizedAddress;
        } else if (!targetMac && pausedTargetMac) {
          targetMac = pausedTargetMac;
        }
        pausedTargetMac = null;
      }
    }

    setActiveLock(normalizedAddress, {
      init_scanning: false,
      started: false,
      ready: false,
      connected: false,
      status: 'idle',
      last_action: 'init_lock',
      last_error: null,
      discovered_locks: [],
      fingerprints: [],
    });

    return {
      ok: true,
      address: normalizedAddress,
    };
  });
}

async function runInitHelper(address) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['examples/init.js'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TARGET_MAC: address,
        SETTINGS_FILE: settingsFile,
        INIT_SCAN_TIMEOUT_MS: process.env.INIT_SCAN_TIMEOUT_MS || '120000',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const trimmed = chunk.toString().trim();
      if (trimmed) {
        appendLog(`[init script] ${trimmed}`);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const trimmed = text.trim();
      if (trimmed) {
        appendLog(`[init script] ${trimmed}`);
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, address });
        return;
      }

      const message = stderr.trim() || stdout.trim() || `Init script exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

async function addFingerprint(startDate, endDate) {
  return queueAction('adding_fingerprint', async () => {
    emitState({
      fingerprint_scan: {
        active: true,
        progress_count: 0,
        message: 'Connecting to lock for fingerprint enrollment...',
      },
    });

    try {
      const target = await ensureConnectedLock();
      emitState({
        fingerprint_scan: {
          active: true,
          progress_count: 0,
          message: 'Preparing fingerprint enrollment...',
        },
      });
      const fpNumber = await target.addFingerprint(startDate, endDate);
      if (!fpNumber) {
        throw new Error('Add fingerprint failed');
      }
      const { fingerprints: liveFingerprints, failed: fingerprintReadFailed } = await readFingerprintsWithTimeout(target);
      let { fingerprints, stale } = resolveFingerprintsForUi(target.getAddress(), liveFingerprints);
      if (!fingerprints.some((item) => item.fpNumber === fpNumber)) {
        fingerprints = [
          {
            fpNumber,
            startDate,
            endDate,
          },
          ...fingerprints,
        ];
        setCachedFingerprints(target.getAddress(), fingerprints);
        stale = true;
        appendLog(`Fingerprint ${fpNumber} was added, but the lock did not return it in the live list. Keeping it in cache.`);
      }
      emitState({
        fingerprints,
        fingerprint_scan: {
          active: false,
          progress_count: Number(state.fingerprint_scan?.progress_count || 0),
          message: stale
            ? `Fingerprint added with number ${fpNumber} (cached list)`
            : `Fingerprint added with number ${fpNumber}`,
        },
      });
      if (fingerprintReadFailed) {
        appendLog('Post-add fingerprint refresh used cached data because the lock did not return a live list in time.');
      }
      appendLog(`Fingerprint added with number ${fpNumber}`);
      return {
        ok: true,
        fingerprint_number: fpNumber,
        fingerprints,
        startDate,
        endDate,
      };
    } catch (error) {
      emitState({
        fingerprint_scan: {
          active: false,
          progress_count: Number(state.fingerprint_scan?.progress_count || 0),
          message: null,
        },
      });
      throw error;
    }
  });
}

async function cancelFingerprintEnrollment() {
  return queueAction('canceling_fingerprint', async () => {
    if (state.status !== 'adding_fingerprint') {
      emitState({
        fingerprint_scan: {
          active: false,
          progress_count: Number(state.fingerprint_scan?.progress_count || 0),
          message: null,
        },
      });
      return { ok: true, canceled: false };
    }

    emitState({
      fingerprint_scan: {
        active: false,
        progress_count: Number(state.fingerprint_scan?.progress_count || 0),
        message: 'Canceling fingerprint enrollment...',
      },
    });

    try {
      if (lock?.isConnected()) {
        await lock.disconnect();
      }
    } catch (error) {}

    emitState({
      fingerprint_scan: {
        active: false,
        progress_count: Number(state.fingerprint_scan?.progress_count || 0),
        message: null,
      },
    });
    appendLog('Fingerprint enrollment canceled');
    return { ok: true, canceled: true };
  });
}

async function getFingerprints() {
  return queueAction('getting_fingerprints', async () => {
    const target = await ensureConnectedLock();
    const { fingerprints: liveFingerprints, failed, timedOut } = await readFingerprintsWithTimeout(target);
    const { fingerprints, stale } = resolveFingerprintsForUi(target.getAddress(), liveFingerprints);
    emitState({
      fingerprints,
    });
    appendLog(`Loaded ${fingerprints.length} fingerprint(s)${stale ? ' from cache' : ''}`);
    return {
      ok: true,
      fingerprints,
      stale,
      timed_out: timedOut,
      used_fallback: failed,
    };
  });
}

async function deleteFingerprint(fpNumber) {
  return queueAction('deleting_fingerprint', async () => {
    const target = await ensureConnectedLock();
    const fingerprintNumber = typeof fpNumber === 'string' ? fpNumber.trim() : '';
    if (!fingerprintNumber) {
      throw new Error('Fingerprint number is required');
    }

    const ok = await target.deleteFingerprint(fingerprintNumber);
    if (!ok) {
      throw new Error('Delete fingerprint failed');
    }

    const { fingerprints: liveFingerprints, failed: fingerprintReadFailed } = await readFingerprintsWithTimeout(target);
    let { fingerprints, stale } = resolveFingerprintsForUi(target.getAddress(), liveFingerprints, { logFallback: false });
    fingerprints = fingerprints.filter((item) => item.fpNumber !== fingerprintNumber);
    setCachedFingerprints(target.getAddress(), fingerprints);
    emitState({
      fingerprints,
    });
    appendLog(`Fingerprint deleted with number ${fingerprintNumber}${stale ? ' (cache adjusted)' : ''}`);
    if (fingerprintReadFailed) {
      appendLog('Post-delete fingerprint refresh used cached data because the lock did not return a live list in time.');
    }
    return {
      ok: true,
      fingerprint_number: fingerprintNumber,
      fingerprints,
      stale,
    };
  });
}

async function renameFingerprint(fpNumber, name) {
  return queueAction('getting_fingerprints', async () => {
    const normalizedAddress = normalizeAddress(targetMac);
    const fingerprintNumber = typeof fpNumber === 'string' ? fpNumber.trim() : '';
    const nextName = typeof name === 'string' ? name.trim() : '';

    if (!normalizedAddress) {
      throw new Error('No active lock selected');
    }
    if (!fingerprintNumber) {
      throw new Error('Fingerprint number is required');
    }
    if (!nextName) {
      throw new Error('Fingerprint name is required');
    }

    const fingerprints = getCachedFingerprints(normalizedAddress).map((item) => {
      if (String(item?.fpNumber || '') !== fingerprintNumber) {
        return { ...item };
      }
      return {
        ...item,
        name: nextName,
      };
    });

    if (!fingerprints.some((item) => String(item?.fpNumber || '') === fingerprintNumber)) {
      throw new Error(`Unknown fingerprint ${fingerprintNumber}`);
    }

    setCachedFingerprints(normalizedAddress, fingerprints);
    await saveData(settingsFile, cachedLockData);
    emitState({
      fingerprints,
    });
    appendLog(`Renamed fingerprint ${fingerprintNumber} to ${nextName}`);
    return {
      ok: true,
      fpNumber: fingerprintNumber,
      name: nextName,
      fingerprints,
    };
  });
}

async function resetLock() {
  return queueAction('resetting_lock', async () => {
    const target = await ensureConnectedLock();
    const ok = await target.resetLock();
    if (!ok) {
      throw new Error('Reset lock failed');
    }
    emitState({
      passcodes: [],
      passage_modes: [],
    });
    appendLog('Reset lock command succeeded');
    return { ok: true };
  });
}

async function reconnect() {
  return queueAction('reconnecting', async () => {
    await start();
    await waitForTargetLockDiscovery(12000);

    if (lock.isConnected()) {
      await lock.disconnect();
      await delay(500);
    }

    const connected = await safeConnect(3);
    if (!connected) {
      throw new Error('Reconnect failed');
    }

    await fetchLatestStatus(true);
    appendLog('Reconnect succeeded');
    return { ok: true };
  });
}

async function refresh() {
  return queueAction('refreshing', async () => {
    await ensureConnectedLock();
    await fetchLatestStatus(true);
    appendLog('Refreshed lock status');
    return {
      ok: true,
      state: getState(),
    };
  });
}

async function selectLock(address) {
  return queueAction('selecting_lock', async () => {
    await start();
    const normalizedAddress = normalizeAddress(address);
    if (!normalizedAddress) {
      throw new Error('Lock address is required');
    }

    const managedLock = getManagedLock(normalizedAddress);
    if (!managedLock) {
      throw new Error(`Unknown lock ${normalizedAddress}`);
    }
    if (!managedLock.saved) {
      throw new Error(`Lock ${normalizedAddress} is not initialized yet`);
    }

    setActiveLock(normalizedAddress, {
      status: managedLock.discovered ? 'monitoring' : 'idle',
      last_error: null,
      passcodes: [],
      passage_modes: [],
    });
    appendLog(`Selected lock ${normalizedAddress}`);
    return {
      ok: true,
      address: normalizedAddress,
    };
  });
}

async function deleteLock(address) {
  return queueAction('selecting_lock', async () => {
    await start();
    const normalizedAddress = normalizeAddress(address || targetMac);
    if (!normalizedAddress) {
      throw new Error('Lock address is required');
    }

    const managedLock = getManagedLock(normalizedAddress);
    if (!managedLock || !managedLock.saved) {
      throw new Error(`Unknown saved lock ${normalizedAddress}`);
    }

    const deletingActive = normalizedAddress === targetMac;

    if (lock && normalizeAddress(lock.getAddress?.()) === normalizedAddress && lock.isConnected()) {
      try {
        await lock.disconnect();
      } catch (_error) {}
    }

    cachedLockData = cachedLockData.filter((item) => normalizeAddress(item?.address) !== normalizedAddress);
    fingerprintCacheByAddress.delete(normalizedAddress);
    discoveredLocks.delete(normalizedAddress);

    await saveData(settingsFile, cachedLockData);
    loadFingerprintCacheFromLockData();

    if (client && typeof client.forgetDevice === 'function') {
      try {
        client.forgetDevice(normalizedAddress.replace(/:/g, '').toLowerCase());
      } catch (_error) {}
    }

    if (deletingActive) {
      lock = null;
      targetMac = cachedLockData[0]?.address ? normalizeAddress(cachedLockData[0].address) : null;
    }

    emitDiscoveredLocks();
    setActiveLock(targetMac, {
      status: targetMac ? 'monitoring' : 'idle',
      last_error: null,
      fingerprints: getCachedFingerprints(targetMac),
      passcodes: [],
      passage_modes: [],
    });
    appendLog(`Deleted saved lock ${normalizedAddress} from Web UI`);

    return {
      ok: true,
      address: normalizedAddress,
      next_address: targetMac,
    };
  });
}

async function renameLock(address, name) {
  return queueAction('selecting_lock', async () => {
    await start();
    const normalizedAddress = normalizeAddress(address || targetMac);
    const nextName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedAddress) {
      throw new Error('Lock address is required');
    }
    if (!nextName) {
      throw new Error('Lock name is required');
    }

    const managedLock = getManagedLock(normalizedAddress);
    if (!managedLock || !managedLock.saved) {
      throw new Error(`Unknown saved lock ${normalizedAddress}`);
    }

    cachedLockData = cachedLockData.map((item) => {
      if (normalizeAddress(item?.address) !== normalizedAddress) {
        return item;
      }
      return {
        ...item,
        name: nextName,
      };
    });

    await saveData(settingsFile, cachedLockData);

    if (normalizedAddress === targetMac) {
      emitState({
        name: nextName,
      });
    } else {
      emitState({});
    }

    appendLog(`Renamed lock ${normalizedAddress} to ${nextName}`);
    return {
      ok: true,
      address: normalizedAddress,
      name: nextName,
    };
  });
}

async function importLockData(lockData) {
  return queueAction('refreshing', async () => {
    const importedLocks = normalizeImportedLockData(lockData);
    if (importedLocks.length === 0) {
      throw new Error('lockData is empty');
    }

    await suspend('import lock data');

    cachedLockData = importedLocks;
    await saveData(settingsFile, cachedLockData);
    loadFingerprintCacheFromLockData();

    targetMac = normalizeAddress(cachedLockData[0]?.address);
    lock = null;

    await start();
    setActiveLock(targetMac, {
      status: targetMac ? 'monitoring' : 'idle',
      last_error: null,
      fingerprints: getCachedFingerprints(targetMac),
      passcodes: [],
      passage_modes: [],
    });

    appendLog(`Imported ${cachedLockData.length} saved lock(s) from lockData.json`);
    return {
      ok: true,
      count: cachedLockData.length,
      target_mac: targetMac,
    };
  });
}

async function exportLockData() {
  const lockData = await loadData(settingsFile);
  return Array.isArray(lockData) ? lockData : [];
}

function getState() {
  return {
    ...state,
    has_lock: Boolean(lock),
    target_mac: targetMac,
  };
}

function on(event, callback) {
  emitter.on(event, callback);
}

function off(event, callback) {
  emitter.off(event, callback);
}

module.exports = {
  start,
  pause,
  suspend,
  getState,
  isBusy,
  selectLock,
  lock: lockDoor,
  unlock: unlockDoor,
  clearPassageMode,
  getPassageMode,
  setPassageMode,
  deletePassageMode,
  startInitScan,
  stopInitScan,
  initLock: initNewLock,
  addFingerprint,
  getPasscodes,
  addPasscode,
  deletePasscode,
  cancelFingerprintEnrollment,
  getFingerprints,
  deleteFingerprint,
  renameFingerprint,
  resetLock,
  getDefaultFingerprintWindow,
  reconnect,
  refresh,
  deleteLock,
  renameLock,
  importLockData,
  exportLockData,
  on,
  off,
};
