# pihumtemp

Records a Govee H5075 thermo-hygrometer over Bluetooth LE on a Raspberry Pi, indefinitely, and serves the data over HTTP for the LocalHumTemp macOS menu bar app.

- Passive BLE scanning with `@abandonware/noble`. The H5075 broadcasts a reading about every 2 s, so no pairing or connection is needed.
- One SQLite row per minute (mean temperature and humidity, last battery and RSSI, sample count) in `better-sqlite3` (WAL mode). That is about 525k rows a year, which is fine to keep forever.
- HTTP API on `0.0.0.0:8080`, documented in [docs/pi-api.md](docs/pi-api.md).

## Quick start on a Mac (no sensor)

```sh
nvm use            # Node 22+ (.nvmrc)
npm install
npm run simulate   # = npm run build && node dist/index.js --simulate
```

Simulate mode generates fake H5075 advertisements. On first run it also seeds 30 days of history, with a 3-hour gap two days ago, into `./data/simulate.db`. To change how much history it seeds, set `SIMULATE_BACKFILL_DAYS`; to start over, delete `data/`.

```sh
curl localhost:8080/api/health
curl localhost:8080/api/latest
curl "localhost:8080/api/readings?from=$(($(date +%s)*1000-86400000))&to=$(($(date +%s)*1000))&maxPoints=300"
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
| `npm test` | unit tests (decoder, bucketing query, aggregation, param validation) |

Flags: `--simulate` (or `SIMULATE=1`) and `--debug`. `--debug` logs every Govee advertisement's raw manufacturer data along with the decoded values, and sets `LOG_LEVEL=debug`.

### Configuration

All settings are environment variables. See [.env.example](.env.example).

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port (binds `0.0.0.0`) |
| `DB_PATH` | `/var/lib/pihumtemp/pihumtemp.db` | `./data/simulate.db` in simulate mode |
| `SENSOR_ADDRESS` | — | MAC of the sensor to record |
| `SENSOR_NAME` | — | e.g. `GVH5075_3456` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

If neither `SENSOR_ADDRESS` nor `SENSOR_NAME` is set, the first `GVH5075_*` seen is used and its address is logged, so you can pin it.

### Layout

```
src/
  index.ts            wiring: source → selector → aggregator → store; HTTP; watchdog; shutdown
  config.ts, logger.ts
  sources/            AdvertisementSource implementations: noble (BLE), simulate
  govee/h5075.ts      manufacturer-data decoder/encoder
  sensor.ts           picks the configured sensor out of the advertisement stream
  aggregator.ts       per-minute aggregation
  store.ts            SQLite schema/migrations, upsert, bucketed range query
  server.ts           HTTP API
```

The code leaves room for two later additions. **Multiple sensors:** samples already carry a `sensorId`, and migrations are versioned via `PRAGMA user_version`, so a `sensor` column plus one selector or aggregator per sensor fits in. **On-device history backfill over GATT:** it would be another producer of `MinuteRow`s, and `Store.upsertMinute` already merges duplicate minutes by sample-weighted averaging.

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

Compare `decoded` with the sensor's display. The display may round differently by 0.1. If it is set to °F, convert first, because the API is always °C. Then pin the sensor in `/etc/default/pihumtemp` with `SENSOR_ADDRESS=...` and start the service again. A negative-temperature check (e.g. the sensor in a freezer for a few minutes) is worthwhile too.

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
- **Watchdog:** if no advertisement from the sensor arrives for 5 minutes, it logs a warning and restarts the scan, repeating every 5 minutes while the sensor stays silent.
- **Crashes:** systemd restarts the service on failure, with no start-rate limit.
- **Clock not yet synced:** readings are ignored while the system clock is before 2024. This avoids 1970 timestamps from a Pi without an RTC that booted before NTP sync.
- **Shutdown:** on SIGTERM the partial minute is flushed. If the same minute is written again after the restart, the two rows are merged by sample-weighted average.

### Troubleshooting

- **No advertisements at all:**
  - Run `bluetoothctl show` and check that the adapter shows as `Powered: yes`.
  - Run `rfkill list` to check that Bluetooth isn't soft-blocked.
  - Check that the sensor is within range (RSSI better than about −90).
- **`EPERM`/`EACCES` from noble when run by hand:** the setcap above is missing, or was lost in a Node upgrade.
- **Native module build errors in `npm ci`:** make sure `build-essential`, `libbluetooth-dev` and `libudev-dev` are installed. `install.sh` installs them.
