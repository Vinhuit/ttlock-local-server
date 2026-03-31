# Server API

HTTP API exposed by the local TTLock backend in [`server.js`](./server.js).

Base URL example:

```text
http://localhost:8990
```

All JSON action routes return a response shaped like:

```json
{
  "ok": true,
  "result": {},
  "state": {}
}
```

On error:

```json
{
  "ok": false,
  "error": "message",
  "state": {}
}
```

## Health and status

### `GET /api/healthz`

Simple backend health probe.

Example response:

```json
{ "ok": true }
```

### `GET /api/status`

Returns current monitor state without waking the backend.

### `GET /api/status?wake=1`

Ensures the monitor is active before returning state.

## Lock selection

### `POST /api/select-lock`

Body:

```json
{
  "address": "0C:49:0E:FD:6A:98"
}
```

Selects the active lock for subsequent actions.

### `POST /api/delete-lock`

Body:

```json
{
  "address": "0C:49:0E:FD:6A:98"
}
```

Deletes a saved lock from backend state and persisted data.

## Init / Pair

### `POST /api/init-scan/start`

Starts init scan mode.

### `POST /api/init-scan/stop`

Stops init scan mode.

### `POST /api/init-lock`

Body:

```json
{
  "address": "0C:49:0E:FD:6A:98"
}
```

Initializes a factory-reset TTLock device.

## Lock actions

### `POST /api/unlock`

Unlocks the currently selected lock.

### `POST /api/lock`

Locks the currently selected lock.

### `POST /api/reset-lock`

Factory resets the currently selected lock.

### `POST /api/reconnect`

Forces reconnect on the currently selected lock.

### `POST /api/refresh`

Refreshes state for the currently selected lock.

## Fingerprints

### `POST /api/get-fingerprints`

Loads fingerprint list from the current lock.

### `POST /api/add-fingerprint`

Body:

```json
{
  "startDate": "202603311449",
  "endDate": "203603311449"
}
```

Both fields are optional. If omitted, backend defaults are used.

### `POST /api/delete-fingerprint`

Body:

```json
{
  "fpNumber": "54282400759808"
}
```

### `POST /api/cancel-fingerprint`

Cancels in-progress fingerprint enrollment.

## Passcodes

### `POST /api/get-passcodes`

Loads passcodes for the current lock.

### `POST /api/add-passcode`

Body:

```json
{
  "passCode": "123456",
  "type": 1,
  "startDate": "202603311449",
  "endDate": "203603311449"
}
```

Notes:

- `passCode` is required
- `type` defaults to `1`
- `startDate` and `endDate` are optional

### `POST /api/delete-passcode`

Body:

```json
{
  "passCode": "123456",
  "type": 1
}
```

## Passage mode

### `POST /api/get-passage`

Loads passage mode entries.

### `POST /api/set-passage`

Body:

```json
{
  "type": 1,
  "weekOrDay": 5,
  "month": 0,
  "startHour": "0000",
  "endHour": "2359"
}
```

### `POST /api/delete-passage`

Body:

```json
{
  "type": 1,
  "weekOrDay": 5,
  "month": 0,
  "startHour": "0000",
  "endHour": "2359"
}
```

### `POST /api/clear-passage`

Removes all passage mode entries from the current lock.

## Notes

- Most mutating routes wake the backend monitor automatically.
- `GET /api/status` without `wake=1` does not force BLE activity.
- The backend is designed for local network use.
- BLE execution and lock credentials stay inside the backend, not in the browser.
