// server.js
// Express server that runs ttlock-sdk-js examples as subprocesses with timeout & process management.

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// --- Config ---
const PORT = process.env.PORT || 8080;
// Default timeout in ms (overridable per request). Some examples (e.g., init, add-fingerprint, listen) may need longer.
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 60_000);

// Path to the built examples (after `npm run build` in ttlock-sdk-js).
// Change this if you’ve placed this server elsewhere.
const EXAMPLES_DIR = process.env.EXAMPLES_DIR ||
  path.resolve(__dirname, "examples");

// Optional: environment toggles for Noble websocket gateway supported by the SDK README.
const BASE_ENV = {
  // Uncomment/override via request body if you use the websocket gateway:
  // WEBSOCKET_ENABLE: "1",
  // WEBSOCKET_HOST: "127.0.0.1",
  // WEBSOCKET_PORT: "2846",
  // WEBSOCKET_DEBUG: "1",

  // Debug helpers from README:
  // TTLOCK_IGNORE_CRC: "1",
  // TTLOCK_DEBUG_COMM: "1",
};

// Map simple endpoint names -> example filenames in dist/examples.
// Names mirror the npm scripts listed in the README.
const EXAMPLES = {
  "init": "init.js",
  "unlock": "unlock.js",
  "lock": "lock.js",
  "status": "status.js",

  // Passage mode
  "set-passage": "set-passage.js",
  "get-passage": "get-passage.js",
  "delete-passage": "delete-passage.js",
  "clear-passage": "clear-passage.js",

  // Reset
  "reset": "reset.js",

  // Passcodes
  "add-passcode": "add-passcode.js",
  "update-passcode": "update-passcode.js",
  "delete-passcode": "delete-passcode.js",
  "clear-passcodes": "clear-passcodes.js",

  // IC Cards
  "add-card": "add-card.js",
  "get-cards": "get-cards.js",
  "clear-cards": "clear-cards.js",

  // Fingerprints
  "add-fingerprint": "addFR.js",
  "get-fingerprints": "getFR.js",
  "clear-fingerprints": "clearFR.js",

  // Lock sound
  "delete-locksound": "delete-locksound.js",

  // Operation log
  "get-operations": "get-operations.js",

  // Passive listener
  "listen": "listen.js",
};

// In-memory task registry
const tasks = new Map(); // id -> { child, startedAt, timeoutMs, timer, name, status, stdout, stderr }

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function examplePath(name) {
  const file = EXAMPLES[name];
  if (!file) return null;
  return path.join(EXAMPLES_DIR, file);
}

function startTask(name, args = [], env = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const script = examplePath(name);
  if (!script) throw Object.assign(new Error(`Unknown example: ${name}`), { status: 404 });

  const id = makeId();
  const childEnv = { ...process.env, ...BASE_ENV, ...env };

  // Spawn the Node process running the example script.
  const child = spawn(process.execPath, [script, ...args], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const startedAt = Date.now();
  const task = {
    id,
    name,
    args,
    env: childEnv,
    startedAt,
    timeoutMs,
    status: "running",
    stdout: "",
    stderr: "",
    pid: child.pid,
    child,
    timer: null,
    exitCode: null,
    signal: null,
  };

  // Collect logs
  child.stdout.on("data", (chunk) => { task.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { task.stderr += chunk.toString(); });

  // Handle exit
  child.on("exit", (code, signal) => {
    task.exitCode = code;
    task.signal = signal;
    task.status = code === 0 ? "success" : (signal ? "killed" : "error");
    if (task.timer) clearTimeout(task.timer);
  });

  // Enforce timeout
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    task.timer = setTimeout(() => {
      if (task.status === "running") {
        try { process.kill(child.pid, "SIGTERM"); } catch {}
        // Fallback killer
        setTimeout(() => {
          try { process.kill(child.pid, "SIGKILL"); } catch {}
        }, 2500);
        task.status = "timeout";
      }
    }, timeoutMs);
  }

  tasks.set(id, task);
  return task;
}

// --- REST API ---

// Simple health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// List supported endpoints
app.get("/examples", (_req, res) => {
  res.json({
    examples: Object.keys(EXAMPLES),
    dir: EXAMPLES_DIR,
  });
});

// Start an example by name
// POST /run/:name
// Body: { args?: string[], env?: Record<string,string>, timeoutMs?: number }
app.post("/run/:name", (req, res) => {
  try {
    const name = req.params.name;
    const args = Array.isArray(req.body?.args) ? req.body.args.map(String) : [];
    const env = typeof req.body?.env === "object" && req.body.env ? req.body.env : {};
    const timeoutMs = req.body?.timeoutMs != null ? Number(req.body.timeoutMs) : DEFAULT_TIMEOUT_MS;

    const task = startTask(name, args, env, timeoutMs);
    res.status(202).json({
      id: task.id,
      pid: task.pid,
      name: task.name,
      status: task.status,
      timeoutMs: task.timeoutMs,
      startedAt: task.startedAt,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// Fixed, pretty endpoints that match the README scripts, e.g. POST /unlock
for (const name of Object.keys(EXAMPLES)) {
  app.post(`/${name}`, (req, res) => {
    try {
      const args = Array.isArray(req.body?.args) ? req.body.args.map(String) : [];
      const env = typeof req.body?.env === "object" && req.body.env ? req.body.env : {};
      const timeoutMs = req.body?.timeoutMs != null ? Number(req.body.timeoutMs) : DEFAULT_TIMEOUT_MS;
      const task = startTask(name, args, env, timeoutMs);
      res.status(202).json({ id: task.id, pid: task.pid, name: task.name, status: task.status });
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });
}

// Get task status (and final result when finished)
app.get("/tasks/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  res.json({
    id: task.id,
    name: task.name,
    status: task.status,
    pid: task.pid,
    exitCode: task.exitCode,
    signal: task.signal,
    startedAt: task.startedAt,
    durationMs: Date.now() - task.startedAt,
    timeoutMs: task.timeoutMs,
    // Return entire logs (also see /logs/:id for SSE streaming)
    stdout: task.stdout,
    stderr: task.stderr,
  });
});

// Server-Sent Events to stream logs live
app.get("/logs/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).end();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Send backlog first
  res.write(`event: stdout\ndata: ${JSON.stringify(task.stdout)}\n\n`);
  if (task.stderr) res.write(`event: stderr\ndata: ${JSON.stringify(task.stderr)}\n\n`);

  const onStdout = (chunk) => res.write(`event: stdout\ndata: ${JSON.stringify(chunk.toString())}\n\n`);
  const onStderr = (chunk) => res.write(`event: stderr\ndata: ${JSON.stringify(chunk.toString())}\n\n`);
  const onExit = () => {
    res.write(`event: status\ndata: ${JSON.stringify(task.status)}\n\n`);
    res.end();
    cleanup();
  };

  function cleanup() {
    if (task.child) {
      task.child.stdout?.off("data", onStdout);
      task.child.stderr?.off("data", onStderr);
      task.child.off("exit", onExit);
    }
  }

  task.child.stdout?.on("data", onStdout);
  task.child.stderr?.on("data", onStderr);
  task.child.on("exit", onExit);

  req.on("close", cleanup);
});

// Cancel/kill a running task
app.post("/tasks/:id/cancel", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });

  if (task.status !== "running") {
    return res.json({ id: task.id, status: task.status, message: "not running" });
  }
  try {
    process.kill(task.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    if (task.status === "running") {
      try { process.kill(task.pid, "SIGKILL"); } catch {}
    }
  }, 1500);
  task.status = "killed";
  return res.json({ id: task.id, status: task.status });
});

// List tasks
app.get("/tasks", (_req, res) => {
  res.json(
    [...tasks.values()].map(t => ({
      id: t.id, name: t.name, status: t.status, pid: t.pid,
      startedAt: t.startedAt, timeoutMs: t.timeoutMs,
    }))
  );
});

app.listen(PORT, () => {
  console.log(`TTLock SDK Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} for API documentation`);
  console.log('Make sure you have a compatible Bluetooth adapter and the required dependencies installed.');
});
