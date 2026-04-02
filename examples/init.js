'use strict';

const { TTLockClient } = require('../dist');
const loadData = require('./common/loadData');
const saveData = require('./common/saveData');
const makeOptions = require('./common/options');

const settingsFile = process.env.SETTINGS_FILE || 'lockData.json';
const targetMac = typeof process.env.TARGET_MAC === 'string'
  ? process.env.TARGET_MAC.trim().toUpperCase()
  : '';
const scanTimeoutMs = Number(process.env.INIT_SCAN_TIMEOUT_MS || 120000);

async function doStuff() {
  let lockData = await loadData(settingsFile);
  let options = makeOptions(lockData);

  const client = new TTLockClient(options);
  const ready = await client.prepareBTService();
  if (!ready) {
    throw new Error('Bluetooth adapter is not ready');
  }

  let completed = false;
  let busy = false;
  let timer = null;

  const finish = async (code, error) => {
    if (completed) {
      return;
    }
    completed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (client.isScanning()) {
        await client.stopScanLock();
      }
    } catch (stopError) {}
    try {
      client.stopBTService();
    } catch (stopError) {}

    if (error) {
      console.error(error.message || String(error));
    }
    process.exit(code);
  };

  client.on('foundLock', async (lock) => {
    if (completed || busy) {
      return;
    }

    const address = typeof lock.getAddress === 'function' ? lock.getAddress().toUpperCase() : '';
    console.log(lock.toJSON());
    console.log();

    if (targetMac && address !== targetMac) {
      return;
    }

    if (lock.isInitialized()) {
      if (targetMac && address === targetMac) {
        await finish(1, new Error(`Selected lock ${address} is already initialized`));
      }
      return;
    }

    busy = true;
    try {
      const connected = await lock.connect();
      if (!connected || !lock.isConnected()) {
        throw new Error(`Unable to connect to lock ${address || ''} for init`);
      }

      console.log('Trying to init the lock');
      console.log();
      console.log();
      const inited = await lock.initLock();
      await lock.disconnect().catch(() => {});

      if (!inited) {
        throw new Error(`Init lock failed for ${address || 'selected lock'}`);
      }

      await saveData(settingsFile, client.getLockData());
      await finish(0);
    } catch (error) {
      await finish(1, error);
    }
  });

  const started = await client.startScanLock();
  if (!started) {
    throw new Error('Unable to start init scan');
  }

  console.log(`Scan started${targetMac ? ` for ${targetMac}` : ''}`);
  timer = setTimeout(() => {
    finish(1, new Error(targetMac
      ? `Lock ${targetMac} not found during init scan`
      : 'No uninitialized lock found during init scan'));
  }, scanTimeoutMs);
}

doStuff().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
