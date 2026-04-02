# TTLock Local Web UI in Docker

This Docker setup is Linux-only because the current backend BLE path depends on BlueZ / D-Bus.

If you need a Windows-oriented workflow, use the upstream project instead:

- [`kind3r/ttlock-sdk-js`](https://github.com/kind3r/ttlock-sdk-js)

## Build

```bash
docker build -t ttlock-local-webui:latest .
```

## Run

Create a local env file first:

```bash
cp .env.example .env
```

Run without persistence:

```bash
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  --user 0:0 \
  --env-file .env \
  ttlock-local-webui:latest
```

Run with a Docker named volume:

```bash
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  --user 0:0 \
  --env-file .env \
  -v ttlock_local_data:/data \
  ttlock-local-webui:latest
```

## Notes

- The Web UI will listen on `http://localhost:8990`.
- The app always reads and writes runtime files under `/data`:
  - `lockData.json`
  - `state.json`
- If you do not mount `/data`, the app still works, but those files are ephemeral and disappear when the container is removed.
- BLE access in Docker usually needs:
  - `--network host`
  - `--privileged`
- For BLE/HCI access, use rootful Docker. Rootless Docker usually cannot provide the raw Bluetooth access that `@abandonware/noble` needs.
- Run the container as root for BLE access. The examples above include `--user 0:0`.
- If you want to use a host bind mount instead of a named volume:

```bash
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  --user 0:0 \
  --env-file .env \
  -v $(pwd)/data:/data \
  ttlock-local-webui:latest
```

- If you only want to persist `lockData.json`, bind mount that file directly:

```bash
touch $(pwd)/lockData.json
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  --user 0:0 \
  --env-file .env \
  -v $(pwd)/lockData.json:/data/lockData.json \
  ttlock-local-webui:latest
```

- If you also want to persist runtime state separately, mount both files:

```bash
touch $(pwd)/lockData.json
touch $(pwd)/state.json
docker run --rm -it \
  --name ttlock-local-webui \
  --network host \
  --privileged \
  --user 0:0 \
  --env-file .env \
  -v $(pwd)/lockData.json:/data/lockData.json \
  -v $(pwd)/state.json:/data/state.json \
  ttlock-local-webui:latest
```

## Native Linux Permissions

If you run the server directly on the Linux host instead of Docker, grant Bluetooth capabilities to `node`:

```bash
sudo setcap cap_net_raw,cap_net_admin+eip $(which node)
```

Then run:

```bash
npm run webui
```
