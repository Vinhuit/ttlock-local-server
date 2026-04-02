'use strict';

const { TTLockClient, sleep } = require('../dist');
const settingsFile = "lockData.json";

async function doStuff() {
  let lockData = await require("./common/loadData")(settingsFile);
  let options = require("./common/options")(lockData);

  const client = new TTLockClient(options);
  // Optional: restrict to a single lock by MAC (env TARGET_MAC) or the first saved lock
  const TARGET_MAC = process.env.TARGET_MAC || (Array.isArray(lockData) && lockData[0] && lockData[0].address) || null;
  await client.prepareBTService();
  client.startScanLock();
  console.log("Scan started");
  let actionInProgress = false;
  client.on("foundLock", async (lock) => {
    if (TARGET_MAC && lock.getAddress() && lock.getAddress().toUpperCase() !== TARGET_MAC.toUpperCase()) {
      return; // ignore other locks
    }
    if (actionInProgress) return; // prevent duplicate handling
    console.log(lock.toJSON());
    console.log();
    
    if (lock.isInitialized() && lock.isPaired()) {
      actionInProgress = true;
      // stop scanning to speed up connection and reduce BLE noise
      await client.stopScanLock();
      await lock.connectFast(5);
      console.log("Trying to unlock the lock");
      console.log();
      console.log();
      const unlock = await lock.unlock();
      await lock.disconnect();
      
      await require("./common/saveData")(settingsFile, client.getLockData());

      process.exit(0);
    }
  });
}

doStuff();
