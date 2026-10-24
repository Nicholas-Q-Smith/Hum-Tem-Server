# pihumtemp HTTP API

The contract the LocalHumTemp menu bar app relies on. Keep it in sync with the copy in the app repo.

- Base URL: `http://pihumtemp.local:8080` (LAN) or `http://pihumtemp:8080` (Tailscale MagicDNS).
- All timestamps are epoch **milliseconds**. Temperature is always **°C**.
- Responses are `application/json; charset=utf-8`. Bad query params return `400 {"error": "..."}`.
- No auth; reachable only on the home LAN and the tailnet.

```ts
interface Reading { ts: number; tempC: number; humidity: number; battery?: number; rssi?: number }
```

## Sensors

Several H5075s can be recorded, one per room. A sensor is identified by its MAC address (`a4:c1:38:12:34:56`;
any case, with `:`/`-` or no separators, is accepted). Sensors have a display order; the **primary** is the first
*recording* sensor in that order. `/api/latest`, `/api/readings` and `/api/samples` take an optional
`sensor=<MAC>` parameter and default to the primary, so single-sensor clients work unchanged. An unknown `sensor`
returns `404 {"error": "unknown sensor: ..."}`.

Sensors are managed through the API (`managedBy: "api"`, the default) unless the server's `SENSORS` setting is
used (`managedBy: "config"`), in which case the write endpoints below answer `409`.

## `GET /api/health`

Fast; the client calls it with a 1.5 s timeout to choose between LAN and tailnet.

```json
{ "ok": true, "version": "1.0.0", "readings": 129060, "oldest": 1790238960000, "newest": 1792830960000, "samples": 5400, "sensors": 3, "lastAdvertisement": 1792830985107,
  "bluetooth": { "state": "poweredOn", "scanning": true, "error": null } }
```

`bluetooth` is the scanner's state, so a client can tell "server up, Bluetooth broken" from "sensor out of range":
`{ "state": "poweredOn", "scanning": true, "error": null }`. `state` is the adapter state (`poweredOn`,
`poweredOff`, `unauthorized`, ...), `"unavailable"` if Bluetooth couldn't be opened at all, or `"simulated"`;
`error` is the last problem, cleared once scanning works. The server keeps serving and retries Bluetooth
every 30 s.

Only `ok` is required by the client. Totals across all sensors: `readings` is the number of stored minute rows,
`samples` the number of raw samples, `sensors` the number of known sensors, and `lastAdvertisement` the time of
the last decoded advertisement from any recorded sensor (or `null` since startup).

## `GET /api/sensors`

Every known sensor in display order, plus H5075s heard nearby that haven't been added.

```json
{
  "managedBy": "api",
  "sensors": [
    {
      "id": "a4:c1:38:00:5e:70", "name": "GVH5075_5E70", "room": "Living room",
      "primary": true, "recording": true, "position": 0, "lastAdvertisement": 1792835578499,
      "latest": { "ts": 1792835578499, "tempC": 22.6, "humidity": 41.5, "battery": 61, "rssi": -61 },
      "readings": 43020, "oldest": 1790243520000, "newest": 1792835460000, "samples": 1800
    }
  ],
  "nearby": [
    { "id": "a4:c1:38:9f:01:23", "name": "GVH5075_0123", "rssi": -91, "lastSeen": 1792835578499,
      "reading": { "tempC": 24.5, "humidity": 31.6, "battery": 61 } }
  ]
}
```

- `name` and `room` may be `null` (name not heard yet, or no room configured).
- `recording: false` means the sensor is kept (with its history) but new readings aren't stored.
- `position` is the index in display order (0 = first).
- `nearby` entries disappear after 10 minutes unheard. Add one with `POST /api/sensors`.

`GET /api/sensors/<MAC>` returns `{ "sensor": <same shape> }` for one sensor.

## `POST /api/sensors`

Start recording a sensor, typically one from `nearby`. Body (`Content-Type: application/json`):

```json
{ "id": "a4:c1:38:9f:01:23", "room": "Kitchen" }
```

`room` is optional. Returns `201 { "sensor": ... }` if it was new, or `200` if it already existed (it is then
set to recording, and its room updated if given). Errors: `400` (not a MAC address, bad room), `409` (managed by config).

## `PATCH /api/sensors/<MAC>`

Change a sensor. Body: any of

| field | |
|---|---|
| `room` | string up to 64 characters; `null` or `""` clears it |
| `recording` | `false` stops storing readings (history is kept); `true` resumes |
| `primary` | `true` moves it to the front of the order |
| `position` | integer ≥ 0; moves it to that index (clamped to the end) |

Returns `200 { "sensor": ... }`. Changes apply immediately and persist. Errors: `400` (unknown field, bad value,
empty body, not JSON), `404` (unknown sensor), `409` (managed by config). A sensor's MAC in the path may be
URL-encoded (`a4%3Ac1%3A...`) or written plainly.
- `latest` is the live reading, or the newest minute row before the sensor is heard after a restart, or `null`.

## `GET /api/latest[?sensor=<MAC>]`

```json
{ "reading": { "ts": 1792830985107, "tempC": 21.7, "humidity": 43.2, "battery": 87, "rssi": -65 } }
```

The most recent raw sample (updated every ~2 s). After a restart, before the first advertisement, it falls back to the newest stored minute row. `reading` is `null` if there is no data at all.

## `GET /api/readings?from=<ms>&to=<ms>&maxPoints=<n>[&sensor=<MAC>]`

```json
{ "readings": [ { "ts": 1792744586000, "tempC": 20.59, "humidity": 47.28, "battery": 87, "rssi": -62 } ] }
```

- Oldest first, `from <= ts <= to`. `from` and `to` are required integers with `from <= to`.
- `maxPoints` is clamped to 1..5000 (default 1000 if omitted).
- If the range holds ≤ `maxPoints` rows, they are returned as-is (one per minute).
- Otherwise `[from, to]` is split into `maxPoints` equal buckets of `ceil((to - from + 1) / maxPoints)` ms. One averaged reading is returned per **non-empty** bucket with `ts` = bucket start (`from + i * bucketMs`). Empty buckets are left out, so the client can draw gaps where data is missing.

## `GET /api/uptime?from=<ms>&to=<ms>`

When the server itself was running, so a client can tell **server down** (no runs) from **sensor not heard**
(a run, but no readings) when it finds a gap in the data.

```json
{ "heartbeatMs": 60000, "since": 1792800000000, "runs": [ { "start": 1792800000000, "end": 1792830000000 }, { "start": 1792833600000, "end": 1792840000000 } ] }
```

- `runs` overlap `[from, to]`, oldest first. Time between two runs is downtime.
- Each run's `end` is its last heartbeat, written every `heartbeatMs`, so downtime is accurate to about a minute.
  The current run's `end` is the time of the request.
- `since` is the start of the first recorded run. Before it, uptime is unknown (the database predates uptime
  tracking); `null` if nothing has been recorded yet.
- A run is split if the clock jumps (e.g. a Pi without a real-time clock correcting its time after boot), and
  nothing is recorded while the clock is unset (before 2024).

## `GET /api/samples?from=<ms>&to=<ms>&limit=<n>[&sensor=<MAC>]`

Raw samples: every decoded advertisement (about one every 2 s), with its exact receive time.

```json
{ "readings": [ { "ts": 1792834985869, "tempC": 22.4, "humidity": 40.9, "battery": 61, "rssi": -59 } ], "next": 1792834989872 }
```

- Oldest first, `from <= ts <= to`. `from` and `to` are required integers with `from <= to`.
- `limit` is clamped to 1..50000 (default 10000). One day is about 43,200 samples.
- If more samples remain in the range, `next` is the `from` to use for the next page; otherwise it is `null`.
- Values have the sensor's 0.1 resolution. Samples are stored once their minute closes; the current,
  still-open minute's samples are served from memory, so results are current to within seconds.
- Samples older than `RAW_RETENTION_DAYS` (if set) are deleted; `/api/readings` minute rows are kept forever.
