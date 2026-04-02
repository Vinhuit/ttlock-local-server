const express = require('express');
const path = require('path');

if (process.env.BLE_HCI_DEVICE && !process.env.NOBLE_HCI_DEVICE_ID) {
  process.env.NOBLE_HCI_DEVICE_ID = process.env.BLE_HCI_DEVICE;
}

const monitor = require('./monitor');

const app = express();
const PORT = Number(process.env.PORT || 8990);
const publicDir = path.join(__dirname, 'public');
const WEBUI_IDLE_TIMEOUT_MS = Number(process.env.TTLOCK_WEBUI_IDLE_TIMEOUT_MS || 300000);
const KEEP_MONITOR_RUNNING = process.env.TTLOCK_WEBUI_KEEP_MONITOR === '1';
let idleTimer = null;

app.use(express.json());
app.use(express.static(publicDir));

async function ensureMonitorActive() {
  await monitor.start();
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleMonitorSuspend() {
  if (KEEP_MONITOR_RUNNING) {
    return;
  }
  clearIdleTimer();
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (monitor.isBusy()) {
      scheduleMonitorSuspend();
      return;
    }
    try {
      await monitor.pause('web idle');
    } catch (error) {
      console.error('Monitor pause failed:', error);
    }
  }, WEBUI_IDLE_TIMEOUT_MS);
}

function handleAction(handler, options = {}) {
  return async (req, res) => {
    try {
      clearIdleTimer();
      if (!options.skipEnsureMonitorActive) {
        await ensureMonitorActive();
      }
      const result = await handler(req);
      res.json({
        ok: true,
        result,
        state: monitor.getState(),
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message || String(error),
        state: monitor.getState(),
      });
    } finally {
      scheduleMonitorSuspend();
    }
  };
}

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/export-lockdata', async (_req, res) => {
  try {
    clearIdleTimer();
    const lockData = await monitor.exportLockData();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ttlock-lockData-${stamp}.json"`);
    res.send(JSON.stringify(lockData, null, 2));
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || String(error),
      state: monitor.getState(),
    });
  } finally {
    scheduleMonitorSuspend();
  }
});

app.get('/api/status', (req, res) => {
  clearIdleTimer();
  const shouldWake = req.query?.wake === '1';

  if (!shouldWake) {
    scheduleMonitorSuspend();
    res.json(monitor.getState());
    return;
  }

  const ensureReady = monitor.isBusy()
    ? Promise.resolve()
    : ensureMonitorActive();

  ensureReady
    .then(() => {
      scheduleMonitorSuspend();
      res.json(monitor.getState());
    })
    .catch((error) => {
      res.status(500).json({
        ok: false,
        error: error.message || String(error),
        state: monitor.getState(),
      });
    });
});

app.post('/api/select-lock', handleAction((req) => {
  const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  return monitor.selectLock(address);
}));
app.post('/api/delete-lock', handleAction((req) => {
  const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  return monitor.deleteLock(address);
}));
app.post('/api/rename-lock', handleAction((req) => {
  const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  return monitor.renameLock(address, name);
}));
app.post('/api/import-lockdata', handleAction((req) => {
  const lockData = Array.isArray(req.body?.lockData) ? req.body.lockData : req.body;
  return monitor.importLockData(lockData);
}, { skipEnsureMonitorActive: true }));
app.post('/api/init-scan/start', handleAction(() => monitor.startInitScan()));
app.post('/api/init-scan/stop', handleAction(() => monitor.stopInitScan()));
app.post('/api/init-lock', handleAction((req) => {
  const address = typeof req.body?.address === 'string' ? req.body.address.trim() : '';
  console.log(`HTTP init-lock requested for ${address || '(empty)'}`);
  return monitor.initLock(address);
}, { skipEnsureMonitorActive: true }));

app.post('/api/unlock', handleAction(() => monitor.unlock()));
app.post('/api/lock', handleAction(() => monitor.lock()));
app.post('/api/get-passage', handleAction(() => monitor.getPassageMode()));
app.post('/api/set-passage', handleAction((req) => {
  const type = Number(req.body?.type || 1);
  const weekOrDay = Number(req.body?.weekOrDay || 0);
  const month = Number(req.body?.month || 0);
  const startHour = typeof req.body?.startHour === 'string' ? req.body.startHour.trim() : '';
  const endHour = typeof req.body?.endHour === 'string' ? req.body.endHour.trim() : '';
  return monitor.setPassageMode({ type, weekOrDay, month, startHour, endHour });
}));
app.post('/api/delete-passage', handleAction((req) => {
  const type = Number(req.body?.type || 1);
  const weekOrDay = Number(req.body?.weekOrDay || 0);
  const month = Number(req.body?.month || 0);
  const startHour = typeof req.body?.startHour === 'string' ? req.body.startHour.trim() : '';
  const endHour = typeof req.body?.endHour === 'string' ? req.body.endHour.trim() : '';
  return monitor.deletePassageMode({ type, weekOrDay, month, startHour, endHour });
}));
app.post('/api/clear-passage', handleAction(() => monitor.clearPassageMode()));
app.post('/api/get-passcodes', handleAction(() => monitor.getPasscodes()));
app.post('/api/add-passcode', handleAction((req) => {
  const passCode = typeof req.body?.passCode === 'string' ? req.body.passCode.trim() : '';
  const type = Number(req.body?.type || 1);
  const startDate = typeof req.body?.startDate === 'string' && req.body.startDate.trim()
    ? req.body.startDate.trim()
    : undefined;
  const endDate = typeof req.body?.endDate === 'string' && req.body.endDate.trim()
    ? req.body.endDate.trim()
    : undefined;
  return monitor.addPasscode(passCode, startDate, endDate, type);
}));
app.post('/api/delete-passcode', handleAction((req) => {
  const passCode = typeof req.body?.passCode === 'string' ? req.body.passCode.trim() : '';
  const type = Number(req.body?.type || 1);
  return monitor.deletePasscode(passCode, type);
}));
app.post('/api/add-fingerprint', handleAction((req) => {
  const window = monitor.getDefaultFingerprintWindow();
  const startDate = typeof req.body?.startDate === 'string' && req.body.startDate.trim()
    ? req.body.startDate.trim()
    : window.startDate;
  const endDate = typeof req.body?.endDate === 'string' && req.body.endDate.trim()
    ? req.body.endDate.trim()
    : window.endDate;
  return monitor.addFingerprint(startDate, endDate);
}));
app.post('/api/cancel-fingerprint', handleAction(() => monitor.cancelFingerprintEnrollment()));
app.post('/api/get-fingerprints', handleAction(() => monitor.getFingerprints()));
app.post('/api/delete-fingerprint', handleAction((req) => {
  const fpNumber = typeof req.body?.fpNumber === 'string' ? req.body.fpNumber.trim() : '';
  return monitor.deleteFingerprint(fpNumber);
}));
app.post('/api/rename-fingerprint', handleAction((req) => {
  const fpNumber = typeof req.body?.fpNumber === 'string' ? req.body.fpNumber.trim() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  return monitor.renameFingerprint(fpNumber, name);
}));
app.post('/api/reset-lock', handleAction(() => monitor.resetLock()));
app.post('/api/reconnect', handleAction(() => monitor.reconnect()));
app.post('/api/refresh', handleAction(() => monitor.refresh()));

app.use((_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

async function main() {
  app.listen(PORT, () => {
    console.log(`TTLock Web UI listening on http://localhost:${PORT}`);
  });
}

main();
