import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { MinuteRow } from './aggregator.js';
import type { Sample } from './sensors.js';

/** API shape (see docs/pi-api.md). */
export interface Reading {
  ts: number;
  tempC: number;
  humidity: number;
  battery?: number;
  rssi?: number;
}

/** A row of the `sensors` table. `id` is internal; the API identifies sensors by address. */
export interface SensorRecord {
  id: number;
  /** Canonical MAC address; null only for pre-multi-sensor data not yet claimed by a sensor. */
  address: string | null;
  /** BLE local name, e.g. GVH5075_3456. */
  name: string | null;
  room: string | null;
  firstSeen: number | null;
  /** Whether new advertisements from it are stored. Off keeps its history. */
  recording: boolean;
  /** Display order; the first recording sensor is the primary. */
  position: number;
}

export interface SensorUpdate {
  name?: string;
  /** null clears the room. */
  room?: string | null;
  recording?: boolean;
  position?: number;
}

export interface StoreStats {
  /** Number of stored minute rows. */
  readings: number;
  oldest: number | null;
  newest: number | null;
  /** Number of stored raw samples. */
  samples: number;
}

export interface SamplePage {
  readings: Reading[];
  /** Pass as `from` to fetch the next page, or null if this page reached `to`. */
  next: number | null;
}

export const MAX_POINTS_LIMIT = 5000;
export const MAX_SAMPLES_LIMIT = 50_000;
const PRUNE_BATCH = 10_000;

interface SampleRow {
  ts: number;
  temp_x10: number;
  humidity_x10: number;
  battery: number | null;
  rssi: number | null;
}

interface DbRow {
  ts: number;
  temp_c: number;
  humidity: number;
  battery: number | null;
  rssi: number | null;
}

interface SensorDbRow {
  id: number;
  address: string | null;
  name: string | null;
  room: string | null;
  first_seen: number | null;
  reading_count: number;
  sample_count: number;
  recording: number;
  position: number;
}

/** Schema migrations, applied in order and tracked with PRAGMA user_version. */
const MIGRATIONS = [
  // v1: single sensor, one row per minute.
  `CREATE TABLE readings (
     ts INTEGER PRIMARY KEY,
     temp_c REAL NOT NULL,
     humidity REAL NOT NULL,
     battery INTEGER,
     rssi INTEGER,
     samples INTEGER NOT NULL
   )`,
  // v2: every decoded advertisement.
  `CREATE TABLE samples (
     ts INTEGER PRIMARY KEY,
     temp_x10 INTEGER NOT NULL,
     humidity_x10 INTEGER NOT NULL,
     battery INTEGER,
     rssi INTEGER
   )`,
  // v3: multiple sensors. Existing rows move to sensor 1 with a NULL address,
  // which the primary sensor claims when it is registered.
  `CREATE TABLE sensors (
     id INTEGER PRIMARY KEY,
     address TEXT UNIQUE,      -- canonical MAC, lower-case with colons
     name TEXT,                -- BLE local name, e.g. GVH5075_3456
     room TEXT,
     first_seen INTEGER,       -- epoch ms
     -- Maintained on every write: COUNT(*) over years of samples takes too long at startup on a Pi.
     reading_count INTEGER NOT NULL DEFAULT 0,
     sample_count INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE readings_v3 (
     sensor_id INTEGER NOT NULL REFERENCES sensors(id),
     ts INTEGER NOT NULL,      -- minute start, epoch ms
     temp_c REAL NOT NULL,
     humidity REAL NOT NULL,
     battery INTEGER,
     rssi INTEGER,
     samples INTEGER NOT NULL,
     PRIMARY KEY (sensor_id, ts)
   ) WITHOUT ROWID;
   -- Values in tenths (the sensor's resolution), so INTEGER is lossless and compact.
   CREATE TABLE samples_v3 (
     sensor_id INTEGER NOT NULL REFERENCES sensors(id),
     ts INTEGER NOT NULL,      -- receive time, epoch ms
     temp_x10 INTEGER NOT NULL,
     humidity_x10 INTEGER NOT NULL,
     battery INTEGER,
     rssi INTEGER,
     PRIMARY KEY (sensor_id, ts)
   ) WITHOUT ROWID;
   INSERT INTO sensors (id, address, first_seen)
     SELECT 1, NULL, MIN(ts) FROM readings HAVING COUNT(*) > 0;
   INSERT OR IGNORE INTO sensors (id, address) SELECT 1, NULL FROM samples LIMIT 1;
   INSERT INTO readings_v3 SELECT 1, ts, temp_c, humidity, battery, rssi, samples FROM readings;
   INSERT INTO samples_v3 SELECT 1, ts, temp_x10, humidity_x10, battery, rssi FROM samples;
   UPDATE sensors SET
     reading_count = (SELECT COUNT(*) FROM readings_v3 WHERE sensor_id = sensors.id),
     sample_count = (SELECT COUNT(*) FROM samples_v3 WHERE sensor_id = sensors.id);
   DROP TABLE readings;
   DROP TABLE samples;
   ALTER TABLE readings_v3 RENAME TO readings;
   ALTER TABLE samples_v3 RENAME TO samples;`,
  // v4: sensors are managed at runtime (from the app), not only via SENSORS.
  `ALTER TABLE sensors ADD COLUMN recording INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE sensors ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
   UPDATE sensors SET position = id;`,
];

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

function toReading(row: DbRow): Reading {
  const reading: Reading = { ts: row.ts, tempC: round(row.temp_c, 2), humidity: round(row.humidity, 2) };
  if (row.battery !== null) reading.battery = Math.round(row.battery);
  if (row.rssi !== null) reading.rssi = Math.round(row.rssi);
  return reading;
}

function sampleToReading(row: SampleRow): Reading {
  const reading: Reading = { ts: row.ts, tempC: row.temp_x10 / 10, humidity: row.humidity_x10 / 10 };
  if (row.battery !== null) reading.battery = row.battery;
  if (row.rssi !== null) reading.rssi = row.rssi;
  return reading;
}

function toSensor(row: SensorDbRow): SensorRecord {
  return {
    id: row.id,
    address: row.address,
    name: row.name,
    room: row.room,
    firstSeen: row.first_seen,
    recording: row.recording !== 0,
    position: row.position,
  };
}

const emptyStats = (): StoreStats => ({ readings: 0, oldest: null, newest: null, samples: 0 });

type Range = { sensor: number; from: number; to: number };

export class Store {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement<Record<string, unknown>, { samples: number }>;
  private readonly newestStmt: Database.Statement<{ sensor: number }, DbRow>;
  private readonly countRangeStmt: Database.Statement<Range, { n: number }>;
  private readonly rangeStmt: Database.Statement<Range, DbRow>;
  private readonly bucketStmt: Database.Statement<Range & { bucketMs: number }, DbRow>;
  private readonly insertSampleStmt: Database.Statement;
  private readonly sampleRangeStmt: Database.Statement<Range & { limit: number }, SampleRow>;
  private readonly pruneStmt: Database.Statement<{ sensor: number; before: number; batch: number }>;
  private readonly sensorByAddressStmt: Database.Statement<{ address: string }, SensorDbRow>;
  private readonly allSensorsStmt: Database.Statement<[], SensorDbRow>;
  private readonly bumpCountsStmt: Database.Statement<{ sensor: number; readings: number; samples: number }>;
  /**
   * Per-sensor counts and bounds. COUNT(*) over millions of rows is slow on a
   * Pi, so they're computed once at startup and then maintained on each write.
   */
  private readonly sensorStatsCache = new Map<number, StoreStats>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();

    // If a minute is written twice (e.g. a partial minute flushed at shutdown and
    // the rest after restart), merge it as a sample-weighted average. RETURNING
    // samples tells the two apart: it equals the new count only on a fresh insert.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO readings (sensor_id, ts, temp_c, humidity, battery, rssi, samples)
      VALUES (@sensor, @ts, @tempC, @humidity, @battery, @rssi, @samples)
      ON CONFLICT(sensor_id, ts) DO UPDATE SET
        temp_c   = (temp_c * samples + excluded.temp_c * excluded.samples) / (samples + excluded.samples),
        humidity = (humidity * samples + excluded.humidity * excluded.samples) / (samples + excluded.samples),
        battery  = COALESCE(excluded.battery, battery),
        rssi     = COALESCE(excluded.rssi, rssi),
        samples  = samples + excluded.samples
      RETURNING samples`);
    this.newestStmt = this.db.prepare(
      'SELECT ts, temp_c, humidity, battery, rssi FROM readings WHERE sensor_id = @sensor ORDER BY ts DESC LIMIT 1',
    );
    this.countRangeStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM readings WHERE sensor_id = @sensor AND ts BETWEEN @from AND @to',
    );
    this.rangeStmt = this.db.prepare(`
      SELECT ts, temp_c, humidity, battery, rssi FROM readings
      WHERE sensor_id = @sensor AND ts BETWEEN @from AND @to ORDER BY ts`);
    // CAST guards against the division being done in floating point if a
    // parameter is bound as REAL; bucket indexes are never negative here.
    this.bucketStmt = this.db.prepare(`
      SELECT @from + CAST((ts - @from) / @bucketMs AS INTEGER) * @bucketMs AS ts,
             AVG(temp_c) AS temp_c, AVG(humidity) AS humidity, AVG(battery) AS battery, AVG(rssi) AS rssi
      FROM readings
      WHERE sensor_id = @sensor AND ts BETWEEN @from AND @to
      GROUP BY CAST((ts - @from) / @bucketMs AS INTEGER)
      ORDER BY ts`);
    this.insertSampleStmt = this.db.prepare(`
      INSERT OR IGNORE INTO samples (sensor_id, ts, temp_x10, humidity_x10, battery, rssi)
      VALUES (@sensor, @ts, @temp, @humidity, @battery, @rssi)`);
    this.sampleRangeStmt = this.db.prepare(`
      SELECT ts, temp_x10, humidity_x10, battery, rssi FROM samples
      WHERE sensor_id = @sensor AND ts BETWEEN @from AND @to ORDER BY ts LIMIT @limit`);
    this.pruneStmt = this.db.prepare(`
      DELETE FROM samples WHERE sensor_id = @sensor AND ts IN
        (SELECT ts FROM samples WHERE sensor_id = @sensor AND ts < @before ORDER BY ts LIMIT @batch)`);
    this.sensorByAddressStmt = this.db.prepare('SELECT * FROM sensors WHERE address = @address');
    this.allSensorsStmt = this.db.prepare('SELECT * FROM sensors ORDER BY position, id');
    this.bumpCountsStmt = this.db.prepare(
      'UPDATE sensors SET reading_count = reading_count + @readings, sample_count = sample_count + @samples WHERE id = @sensor',
    );

    this.loadStats();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  /** Counts come from the sensors table; MIN/MAX are cheap primary-key lookups. */
  private loadStats(): void {
    const bounds = this.db.prepare(
      'SELECT (SELECT MIN(ts) FROM readings WHERE sensor_id = @id) AS oldest, (SELECT MAX(ts) FROM readings WHERE sensor_id = @id) AS newest',
    );
    for (const s of this.allSensorsStmt.all()) {
      const { oldest, newest } = bounds.get({ id: s.id }) as { oldest: number | null; newest: number | null };
      this.sensorStatsCache.set(s.id, { readings: s.reading_count, oldest, newest, samples: s.sample_count });
    }
  }

  private statsFor(sensorId: number): StoreStats {
    let s = this.sensorStatsCache.get(sensorId);
    if (!s) this.sensorStatsCache.set(sensorId, (s = emptyStats()));
    return s;
  }

  // --- sensors ---------------------------------------------------------------

  sensors(): SensorRecord[] {
    return this.allSensorsStmt.all().map(toSensor);
  }

  sensor(id: number): SensorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sensors WHERE id = ?').get(id) as SensorDbRow | undefined;
    return row ? toSensor(row) : undefined;
  }

  /**
   * Finds or creates the sensor with this address; on creation it goes last in
   * display order. Fields left undefined are unchanged. With `claimLegacy`, a
   * new address takes over the pre-multi-sensor data (the NULL-address sensor).
   */
  registerSensor(
    address: string,
    opts: SensorUpdate & { claimLegacy?: boolean; seenAt?: number } = {},
  ): SensorRecord {
    return this.db.transaction(() => {
      const { claimLegacy, seenAt, ...update } = opts;
      const existing = this.sensorByAddressStmt.get({ address });
      if (existing) return this.updateSensor(existing.id, update);
      const legacy = claimLegacy
        ? (this.db.prepare('SELECT * FROM sensors WHERE address IS NULL ORDER BY id LIMIT 1').get() as
            | SensorDbRow
            | undefined)
        : undefined;
      let id: number;
      if (legacy) {
        this.db.prepare('UPDATE sensors SET address = ? WHERE id = ?').run(address, legacy.id);
        id = legacy.id;
      } else {
        const { lastInsertRowid } = this.db
          .prepare(
            `INSERT INTO sensors (address, first_seen, position)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM sensors))`,
          )
          .run(address, seenAt ?? null);
        id = Number(lastInsertRowid);
        this.statsFor(id);
      }
      return this.updateSensor(id, update);
    })();
  }

  updateSensor(id: number, update: SensorUpdate): SensorRecord {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (update.name !== undefined) (sets.push('name = ?'), values.push(update.name));
    if (update.room !== undefined) (sets.push('room = ?'), values.push(update.room));
    if (update.recording !== undefined) (sets.push('recording = ?'), values.push(update.recording ? 1 : 0));
    if (update.position !== undefined) (sets.push('position = ?'), values.push(update.position));
    if (sets.length) this.db.prepare(`UPDATE sensors SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    const record = this.sensor(id);
    if (!record) throw new Error(`No sensor with id ${id}`);
    return record;
  }

  /** Renumbers display positions to 0..n-1 in the given order (ids not listed keep their relative order after). */
  reorderSensors(ids: readonly number[]): void {
    this.db.transaction(() => {
      const rest = this.allSensorsStmt.all().filter((s) => !ids.includes(s.id)).map((s) => s.id);
      const set = this.db.prepare('UPDATE sensors SET position = ? WHERE id = ?');
      [...ids, ...rest].forEach((id, i) => set.run(i, id));
    })();
  }

  // --- writes ----------------------------------------------------------------

  /** Writes a closed minute and its raw samples in one transaction (one SD-card commit per minute). */
  writeMinute(sensorId: number, row: MinuteRow, samples: readonly Sample[]): void {
    const stats = this.statsFor(sensorId);
    let inserted = 0;
    let newRow = false;
    this.db.transaction(() => {
      newRow = this.upsertRow(sensorId, row);
      for (const s of samples) {
        inserted += this.insertSampleStmt.run({
          sensor: sensorId,
          ts: s.ts,
          temp: Math.round(s.tempC * 10),
          humidity: Math.round(s.humidity * 10),
          battery: s.battery,
          rssi: s.rssi,
        }).changes;
      }
      this.bumpCountsStmt.run({ sensor: sensorId, readings: newRow ? 1 : 0, samples: inserted });
      this.db.prepare('UPDATE sensors SET first_seen = ? WHERE id = ? AND first_seen IS NULL').run(row.ts, sensorId);
    })();
    if (newRow) this.noteRow(stats, row.ts);
    stats.samples += inserted;
  }

  /** Bulk-writes minute rows (used to seed simulated history). */
  upsertMany(sensorId: number, rows: Iterable<MinuteRow>): void {
    const stats = this.statsFor(sensorId);
    this.db.transaction(() => {
      let added = 0;
      for (const row of rows) {
        if (this.upsertRow(sensorId, row)) {
          this.noteRow(stats, row.ts);
          added++;
        }
      }
      this.bumpCountsStmt.run({ sensor: sensorId, readings: added, samples: 0 });
    })();
  }

  private upsertRow(sensorId: number, row: MinuteRow): boolean {
    const result = this.upsertStmt.get({ battery: null, rssi: null, ...row, sensor: sensorId })!;
    return result.samples === row.samples;
  }

  private noteRow(stats: StoreStats, ts: number): void {
    stats.readings += 1;
    if (stats.oldest === null || ts < stats.oldest) stats.oldest = ts;
    if (stats.newest === null || ts > stats.newest) stats.newest = ts;
  }

  /** Deletes raw samples older than `before`, in small batches so readers aren't blocked. */
  pruneSamples(before: number): number {
    let total = 0;
    for (const [sensor, stats] of this.sensorStatsCache) {
      for (;;) {
        const changes = this.db.transaction(() => {
          const n = this.pruneStmt.run({ sensor, before, batch: PRUNE_BATCH }).changes;
          this.bumpCountsStmt.run({ sensor, readings: 0, samples: -n });
          return n;
        })();
        total += changes;
        stats.samples -= changes;
        if (changes < PRUNE_BATCH) break;
      }
    }
    return total;
  }

  // --- reads -----------------------------------------------------------------

  /** Totals across all sensors. Served from memory, so /api/health never scans a table. */
  stats(): StoreStats {
    const total = emptyStats();
    for (const s of this.sensorStatsCache.values()) {
      total.readings += s.readings;
      total.samples += s.samples;
      if (s.oldest !== null && (total.oldest === null || s.oldest < total.oldest)) total.oldest = s.oldest;
      if (s.newest !== null && (total.newest === null || s.newest > total.newest)) total.newest = s.newest;
    }
    return total;
  }

  sensorStats(sensorId: number): StoreStats {
    return { ...this.statsFor(sensorId) };
  }

  newest(sensorId: number): Reading | null {
    const row = this.newestStmt.get({ sensor: sensorId });
    return row ? toReading(row) : null;
  }

  /**
   * Minute rows with from <= ts <= to, oldest first. If there are more than
   * `maxPoints`, the range is split into `maxPoints` equal buckets and one
   * averaged reading is returned per non-empty bucket (ts = bucket start).
   */
  readings(sensorId: number, from: number, to: number, maxPoints: number): Reading[] {
    const points = Math.min(MAX_POINTS_LIMIT, Math.max(1, Math.floor(maxPoints)));
    const range = { sensor: sensorId, from, to };
    const { n } = this.countRangeStmt.get(range)!;
    if (n === 0) return [];
    if (n <= points) return this.rangeStmt.all(range).map(toReading);
    // The range is inclusive, so it spans to - from + 1 ms; rounding up keeps
    // the bucket index of `to` at most points - 1.
    const bucketMs = Math.max(1, Math.ceil((to - from + 1) / points));
    return this.bucketStmt.all({ ...range, bucketMs }).map(toReading);
  }

  /** Raw samples with from <= ts <= to, oldest first, at most `limit` per page. */
  samples(sensorId: number, from: number, to: number, limit: number): SamplePage {
    const max = Math.min(MAX_SAMPLES_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = this.sampleRangeStmt.all({ sensor: sensorId, from, to, limit: max + 1 });
    const more = rows.length > max;
    const page = rows.slice(0, max).map(sampleToReading);
    return { readings: page, next: more ? page.at(-1)!.ts + 1 : null };
  }

  close(): void {
    this.db.close();
  }
}
