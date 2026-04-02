'use strict';

const { TTLockClient, sleep, PassageModeType } = require('../dist');
const settingsFile = "lockData.json";

async function doStuff() {
  let lockData = await require("./common/loadData")(settingsFile);
  let options = require("./common/options")(lockData);

  const client = new TTLockClient(options);
  await client.prepareBTService();
  client.startScanLock();
  console.log("Scan started");
  client.on("foundLock", async (lock) => {
    console.log(lock.toJSON());
    console.log();
    
    if (lock.isInitialized() && lock.isPaired()) {
      await lock.connect();
      console.log("Trying to add Fingerprint");
      console.log();
      console.log();
      let progress = 0;
      lock.on("scanFRStart", () => {
        console.log();
        console.log("Ready to scan a finger");
        console.log();
      });
      lock.on("scanFRProgress", () => {
        progress++;
        console.log();
        console.log("Scanning progress", progress);
        console.log();
      });
      // const now = Date.now(); // Current timestamp in milliseconds
      // const tenYearsMs = 10 * 365.25 * 24 * 60 * 60 * 1000;
      // // Ten years, accounting for leap years

      // const start = now;
      // const end = now + tenYearsMs;

      // const result = await lock.addFingerprint(start, end);
      const result = await lock.addFingerprint('202508271430', '203508271430');
      console.log(result);
      await lock.disconnect();

      process.exit(0);
    }
  });
}

doStuff();