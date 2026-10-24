# pihumtemp

Records Govee H5075 thermo-hygrometers (one or several, one per room) over Bluetooth LE on a Raspberry Pi, indefinitely, and serves the data over HTTP for the LocalHumTemp macOS menu bar app.

- Passive BLE scanning with `@abandonware/noble`. The H5075 broadcasts a reading about every 2 s, so no pairing or connection is needed.
- SQLite tables in `better-sqlite3` (WAL mode):
  - `sensors`: one row per sensor (MAC address, BLE name, room, and running row counts).
  - `readings`: one row per sensor per minute (mean temperature and humidity, last battery and RSSI, sample count). That's about 525k rows, a few tens of MB, a year. These rows back `/api/readings` and are kept forever.
  - `samples`: every decoded advertisement with its exact receive time, at the sensor's 0.1 resolution. That's about 15.8M rows, roughly 410 MB, per sensor per year (measured at 26 bytes per sample). Kept forever by default; set `RAW_RETENTION_DAYS` to limit it. Served by `/api/samples`.
  - A closed minute and its samples are written in a single transaction, one commit per minute instead of one every 2 s, to spare the SD card.
- HTTP API on `0.0.0.0:8080`, documented in [docs/pi-api.md](docs/pi-api.md).

## Quick start on a Mac (no sensor)

```sh
nvm use            # Node 22+ (.nvmrc)
npm install
npm run simulate   # = npm run build && node dist/index.js --simulate
```

Simulate mode generates fake H5075 advertisements from three sensors: Living room (the primary), Bedroom and Office, each with its own climate. It also simulates one unconfigured "neighbour" sensor, which shows up under `nearby`. On first run it seeds 30 days of history per sensor into `./data/simulate.db`, each with a 3-hour gap on a different day. To change these, set `SIMULATE_SENSORS` (1–9) and `SIMULATE_BACKFILL_DAYS`; to start over, delete `data/`.

```sh
curl localhost:8080/api/health
curl localhost:8080/api/latest
curl "localhost:8080/api/readings?from=$(($(date +%s)*1000-86400000))&to=$(($(date +%s)*1000))&maxPoints=300"
curl localhost:8080/api/sensors
curl "localhost:8080/api/latest?sensor=a4:c1:38:00:5e:71"     # Bedroom
```

(macOS's curl rejects the `:8080/...` shorthand. Use `localhost:8080`.)

To point the Mac app at it, set its local address to `http://localhost:8080` and switch the mode to local.

## Development

| Command | |
|---|---|
| `npm run build` | compile `src/` to `dist/` |
| `npm start` | run `dist/index.js` (BLE mode) |
| `npm run simulate` | build and run with fake advertisements |
| `npm run typecheck` | type-check sources and tests |
| `npm test` | unit tests (decoder, bucketing query, raw samples and pruning, aggregation, param validation) |

Flags: `--simulate` (or `SIMULATE=1`) and `--debug`. `--debug` logs every Govee advertisement's raw manufacturer data along with the decoded values, and sets `LOG_LEVEL=debug`.

### Configuration

All settings are environment variables. See [.env.example](.env.example).

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port (binds `0.0.0.0`) |
| `DB_PATH` | `/var/lib/pihumtemp/pihumtemp.db` | `./data/simulate.db` in simulate mode |
| `SENSORS` | — | sensors and rooms, e.g. `A4:C1:38:12:34:56=Living room;A4:C1:38:AB:CD:EF=Bedroom`; first = primary |
| `SENSOR_ADDRESS` / `SENSOR_NAME` | — | single-sensor shorthand (no room); can't be combined with `SENSORS` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `RAW_RETENTION_DAYS` | `0` | delete raw samples older than N days; `0` keeps them forever |

### Multiple sensors and rooms

Each H5075 is identified by its MAC address and can be given a room through `SENSORS`. Entries can also be BLE names (`GVH5075_9A2F`) if you don't have the address yet.

- **Primary sensor:** the first entry. `/api/latest`, `/api/readings` and `/api/samples` default to it, so the Mac app keeps working unchanged. Pass `?sensor=<MAC>` to get another sensor's data.
- **Listing:** `GET /api/sensors` lists every sensor in config order, with its room, latest reading, and row counts, which is enough for a dashboard or layout view. It also lists `nearby` H5075s that are heard but not configured, strongest signal first, to help you find the addresses to add.
- **Adding a sensor:** add an entry and restart. **Renaming a room:** edit its entry and restart.
- **Removing a sensor from `SENSORS`:** recording stops, but its history stays queryable, and it is listed with `recording: false`.
- **No `SENSORS` set:** the sensors already in the database keep being recorded. On an empty database, the first `GVH5075_*` heard is adopted and its address is logged.
- **Upgrading an older single-sensor database:** its history is attached to the primary sensor the first time it's registered.

### Layout

```
src/
  index.ts            wiring: source → selector → aggregator → store; HTTP; watchdog; shutdown
  config.ts, logger.ts
  sources/            AdvertisementSource implementations: noble (BLE), simulate
  govee/h5075.ts      manufacturer-data decoder/encoder
  sensors.ts          sensor config parsing; picks configured sensors out of the advertisement stream
  recorder.ts         per-sensor state: registration, primary, minute aggregation, latest, stale checks
  aggregator.ts       per-minute aggregation
  store.ts            SQLite schema/migrations, upsert, bucketed range query
  server.ts           HTTP API
Dockerfile, compose.yaml          container deployment (compose.simulate.yaml for Macs)
```

The code leaves room for later additions. **On-device history backfill over GATT:** it would be another producer of `MinuteRow`s, and `Store.writeMinute` already merges duplicate minutes by sample-weighted averaging and ignores samples it already has.

## Raspberry Pi setup

Use Raspberry Pi OS 64-bit (Bookworm or newer) on a Pi with built-in Bluetooth (3B+, 4, 5, Zero 2 W).

### 1. Hostname → `pihumtemp.local`

Avahi (mDNS) ships with Raspberry Pi OS, so the hostname is all that's needed:

```sh
sudo hostnamectl set-hostname pihumtemp
sudo sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tpihumtemp/' /etc/hosts
sudo systemctl restart avahi-daemon
```

(Alternatively, use `sudo raspi-config` → System Options → Hostname.) From the Mac, `ping pihumtemp.local` should then answer.

### 2. Install pihumtemp

Copy this repo to the Pi (e.g. `git clone` or `rsync -a --exclude node_modules ./ pi@pihumtemp.local:pihumtemp/`), then:

```sh
cd pihumtemp
sudo ./install.sh
```

`install.sh` is safe to re-run; run it again after pulling changes. It does the following:

1. Installs the apt packages `bluetooth bluez libbluetooth-dev libudev-dev build-essential`, plus `python3 rsync sqlite3 libcap2-bin curl`.
2. Installs Node.js 22 from NodeSource if `node` is missing or older.
3. Creates the system user `pihumtemp` (in the `bluetooth` group) and `/var/lib/pihumtemp`.
4. Syncs the app to `/opt/pihumtemp`, runs `npm ci`, builds, and prunes dev dependencies.
5. Creates `/etc/default/pihumtemp` from `.env.example` if it doesn't already exist.
6. Installs `deploy/pihumtemp.service`, then enables and (re)starts it.

To change settings, edit `/etc/default/pihumtemp`, then run `sudo systemctl restart pihumtemp`.

```sh
journalctl -u pihumtemp -f
curl http://pihumtemp.local:8080/api/health
```

### 3. Verify the decoding

The decoder follows the commonly documented H5075 format, but it has not yet been checked against real hardware. Before relying on the data:

```sh
sudo systemctl stop pihumtemp
sudo -u pihumtemp env $(grep -v '^#' /etc/default/pihumtemp | xargs) node /opt/pihumtemp/dist/index.js --debug
# needs the setcap below, since this runs outside systemd
```

Each Govee advertisement is logged like this:

```
DEBUG adv a4:c1:38:12:34:56 name=GVH5075_3456 rssi=-71 mfr=88ec00034a8b6400 decoded={"tempC":21.5,"humidity":69.1,"battery":100}
```

Compare `decoded` with the sensor's display. The display may round differently by 0.1. If it is set to °F, convert first, because the API is always °C. Then list your sensors with their rooms in `/etc/default/pihumtemp` (or `.env` for Docker), e.g. `SENSORS=A4:C1:38:12:34:56=Living room`, and start the service again. A negative-temperature check (e.g. the sensor in a freezer for a few minutes) is worthwhile too.

### 2b. Alternative: run in Docker

This replaces step 2: use either `install.sh` (systemd) or Docker, not both. Hostname, Tailscale and backups (steps 1, 4 and 5) work the same way.

```sh
# One-time host setup
sudo apt-get install -y bluetooth bluez sqlite3      # host BlueZ owns the adapter; sqlite3 for backups
curl -fsSL https://get.docker.com | sh               # Docker Engine + compose plugin
sudo usermod -aG docker $USER && newgrp docker
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/pihumtemp   # the container runs as uid 1000 (node)

# Run (and after every git pull)
cp -n .env.example .env        # optional: set SENSORS (rooms) etc.
docker compose up -d --build
docker compose logs -f
curl http://localhost:8080/api/health
```

**Persistence:** the database is bind-mounted from the host at `/var/lib/pihumtemp`, the same path the systemd install uses. Rebuilding the image, `docker compose down` (even with `-v`), or deleting the checkout leaves the data alone. SQLite's `-wal`/`-shm` files sit next to the database in the same directory, so the host's `sqlite3 .backup` (step 5, run as root or uid 1000) is safe while the container runs.

If you're switching from the systemd install, run `sudo systemctl disable --now pihumtemp`, then `sudo chown -R 1000:1000 /var/lib/pihumtemp`.

How the container gets at Bluetooth:

- **Host networking:** `network_mode: host` is required because Linux Bluetooth sockets exist only in the host network namespace. As a result, port 8080 is the host's port, reachable over the LAN and `tailscale0` with no port mapping.
- **Raw sockets without root:** the image gives the node binary `cap_net_raw`, and compose keeps `NET_RAW` in the container. The process runs as the unprivileged `node` user.
- **Restarts and logs:** `restart: unless-stopped` brings the container back after crashes and reboots. Log size is capped at 3 × 10 MB to spare the SD card.

To try the container on a Mac, where there's no Bluetooth, use `docker compose -f compose.yaml -f compose.simulate.yaml up --build`. That runs simulate mode on `localhost:8080`, with a named volume for the database.

### BLE without root

The systemd unit grants the service `CAP_NET_RAW`/`CAP_NET_ADMIN` via `AmbientCapabilities`, so nothing else is needed for the service. To run `node` by hand (e.g. `npm start` or the `--debug` run above) as a non-root user, give the node binary the capability:

```sh
sudo setcap cap_net_raw+eip $(readlink -f $(which node))
```

This must be re-applied whenever Node is upgraded. It lets every process that runs that node binary open raw sockets, so the unit's ambient capabilities are the narrower choice for the service itself.

### 4. Tailscale (access from anywhere)

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In the Tailscale admin console:

- Under **DNS**, enable **MagicDNS**.
- Make sure the machine is named `pihumtemp`. Tailscale defaults to the hostname, so set the hostname first, or rename the machine in the console.

From any device on the tailnet, `curl http://pihumtemp:8080/api/health` should then work. The server binds `0.0.0.0`, so it answers on `tailscale0` as well as the LAN.

### 5. Optional: nightly backup

`sqlite3 .backup` takes a consistent copy even while the service is writing. Create `/etc/cron.d/pihumtemp-backup` with:

```cron
# m h dom mon dow user      command
15 3 * * * pihumtemp sqlite3 /var/lib/pihumtemp/pihumtemp.db ".backup '/var/lib/pihumtemp/backup-$(date +\%F).db'" && find /var/lib/pihumtemp -name 'backup-*.db' -mtime +14 -delete
```

This keeps two weeks of daily snapshots. Copy them off the SD card now and then (e.g. `rsync` from the Mac).

## Robustness notes

- **Scan recovery:** if the adapter powers off or scanning stops, it is restarted when the adapter comes back.
- **Watchdog:** a sensor silent for 5 minutes gets a warning, repeated every 30 minutes. If *no* recorded sensor has been heard for 5 minutes, the scan is restarted, again every 5 minutes while the silence lasts.
- **Crashes:** systemd restarts the service on failure, with no start-rate limit.
- **Clock not yet synced:** readings are ignored while the system clock is before 2024. This avoids 1970 timestamps from a Pi without an RTC that booted before NTP sync.
- **Duplicate events:** noble reports a device again when its scan response arrives, a few ms after the advertisement and with the same data. Identical readings less than 500 ms apart are dropped as echoes, so each broadcast is stored once.
- **Shutdown:** on SIGTERM the partial minute and its raw samples are flushed. If the same minute is written again after the restart, the two rows are merged by sample-weighted average.

### Troubleshooting

- **No advertisements at all:**
  - Run `bluetoothctl show` and check that the adapter shows as `Powered: yes`.
  - Run `rfkill list` to check that Bluetooth isn't soft-blocked.
  - Check that the sensor is within range (RSSI better than about −90).
- **`EPERM`/`EACCES` from noble when run by hand:** the setcap above is missing, or was lost in a Node upgrade.
- **Native module build errors in `npm ci`:** make sure `build-essential`, `libbluetooth-dev` and `libudev-dev` are installed. `install.sh` installs them.
