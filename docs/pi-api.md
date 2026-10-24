# pihumtemp HTTP API

The contract the LocalHumTemp menu bar app relies on. Keep it in sync with the copy in the app repo.

- Base URL: `http://pihumtemp.local:8080` (LAN) or `http://pihumtemp:8080` (Tailscale MagicDNS).
- All timestamps are epoch **milliseconds**. Temperature is always **°C**.
- Responses are `application/json; charset=utf-8`. Bad query params return `400 {"error": "..."}`.
- No auth; reachable only on the home LAN and the tailnet.

```ts
interface Reading { ts: number; tempC: number; humidity: number; battery?: number; rssi?: number }
```

## `GET /api/health`

Fast; the client calls it with a 1.5 s timeout to choose between LAN and tailnet.

```json
{ "ok": true, "version": "1.0.0", "readings": 43021, "oldest": 1790238960000, "newest": 1792830960000, "lastAdvertisement": 1792830985107 }
```

Only `ok` is required by the client. `readings` is the number of stored minute rows; `lastAdvertisement` is the time of the last decoded advertisement from the sensor (or `null` since startup).

## `GET /api/latest`

```json
{ "reading": { "ts": 1792830985107, "tempC": 21.7, "humidity": 43.2, "battery": 87, "rssi": -65 } }
```

The most recent raw sample (updated every ~2 s). After a restart, before the first advertisement, it falls back to the newest stored minute row. `reading` is `null` if there is no data at all.

## `GET /api/readings?from=<ms>&to=<ms>&maxPoints=<n>`

```json
{ "readings": [ { "ts": 1792744586000, "tempC": 20.59, "humidity": 47.28, "battery": 87, "rssi": -62 } ] }
```

- Oldest first, `from <= ts <= to`. `from` and `to` are required integers with `from <= to`.
- `maxPoints` is clamped to 1..5000 (default 1000 if omitted).
- If the range holds ≤ `maxPoints` rows, they are returned as-is (one per minute).
- Otherwise `[from, to]` is split into `maxPoints` equal buckets of `ceil((to - from + 1) / maxPoints)` ms. One averaged reading is returned per **non-empty** bucket with `ts` = bucket start (`from + i * bucketMs`). Empty buckets are left out, so the client can draw gaps where data is missing.
