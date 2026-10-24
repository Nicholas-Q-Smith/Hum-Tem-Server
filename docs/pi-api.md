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
any case, with `:`/`-` or no separators, is accepted). `/api/latest`, `/api/readings` and `/api/samples` take an
optional `sensor=<MAC>` parameter. Without it they use the **primary** sensor (the first configured), so
single-sensor clients work unchanged. An unknown `sensor` returns `404 {"error": "unknown sensor: ..."}`.

## `GET /api/health`

Fast; the client calls it with a 1.5 s timeout to choose between LAN and tailnet.

```json
{ "ok": true, "version": "1.0.0", "readings": 129060, "oldest": 1790238960000, "newest": 1792830960000, "samples": 5400, "sensors": 3, "lastAdvertisement": 1792830985107 }
```

Only `ok` is required by the client. Totals across all sensors: `readings` is the number of stored minute rows,
`samples` the number of raw samples, `sensors` the number of known sensors, and `lastAdvertisement` the time of
the last decoded advertisement from any recorded sensor (or `null` since startup).

## `GET /api/sensors`

Every known sensor in display order (configured order first), plus H5075s heard nearby that aren't configured.

```json
{
  "sensors": [
    {
      "id": "a4:c1:38:00:5e:70", "name": "GVH5075_5E70", "room": "Living room",
      "primary": true, "recording": true, "lastAdvertisement": 1792835578499,
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
- `recording: false` means the sensor has history but is no longer configured.
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

## `GET /api/samples?from=<ms>&to=<ms>&limit=<n>[&sensor=<MAC>]` (additive; not used by the Mac app yet)

Raw samples: every decoded advertisement (about one every 2 s), with its exact receive time.

```json
{ "readings": [ { "ts": 1792834985869, "tempC": 22.4, "humidity": 40.9, "battery": 61, "rssi": -59 } ], "next": 1792834989872 }
```

- Oldest first, `from <= ts <= to`. `from` and `to` are required integers with `from <= to`.
- `limit` is clamped to 1..50000 (default 10000). One day is about 43,200 samples.
- If more samples remain in the range, `next` is the `from` to use for the next page; otherwise it is `null`.
- Values have the sensor's 0.1 resolution. Samples are written once their minute closes, so the newest
  minute appears up to ~1 min late; use `/api/latest` for the live value.
- Samples older than `RAW_RETENTION_DAYS` (if set) are deleted; `/api/readings` minute rows are kept forever.
