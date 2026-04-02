'use strict';

const { TTLockClient, sleep } = require('../dist');
const fs = require('fs/promises');
const settingsFile = "lockData.json";

async function doStuff() {
  let lockData = await require("./common/loadData")(settingsFile);
  let options = require("./common/options")(lockData);

  const client = new TTLockClient(options);
  const TARGET_MAC = process.env.TARGET_MAC || (Array.isArray(lockData) && lockData[0] && lockData[0].address) || null;
  await client.prepareBTService();
  client.startScanLock();
  console.log("Scan started");
  let actionInProgress = false;
  client.on("foundLock", async (lock) => {
    if (TARGET_MAC && lock.getAddress() && lock.getAddress().toUpperCase() !== TARGET_MAC.toUpperCase()) {
      return;
    }
    if (actionInProgress) return;
    console.log(lock.toJSON());
    console.log();
    
    if (lock.isInitialized() && lock.isPaired()) {
      actionInProgress = true;
      await client.stopScanLock();
      await lock.connectFast(5);
      console.log("Trying to lock the lock");
      console.log();
      console.log();
      const unlock = await lock.lock();
      await lock.disconnect();
      const newLockData = client.getLockData();
      console.log(JSON.stringify(newLockData));
      try {
        await fs.writeFile(settingsFile, Buffer.from(JSON.stringify(newLockData)));
      } catch (error) {
        process.exit(1);
      }

      process.exit(0);
    }
  });
}

doStuff();
