import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { MinuteRow } from './aggregator.js';

/** API shape (see docs/pi-api.md). */
export interface Reading {
  ts: number;
  tempC: number;
  humidity: number;
  battery?: number;
  rssi?: number;
}

export interface StoreStats {
  readings: number;
  oldest: number | null;
  newest: number | null;
}

export const MAX_POINTS_LIMIT = 5000;

interface DbRow {
  ts: number;
  temp_c: number;
  humidity: number;
  battery: number | null;
  rssi: number | null;
}

/** Schema migrations, applied in order and tracked with PRAGMA user_version. */
const MIGRATIONS = [
  `CREATE TABLE readings (
     ts INTEGER PRIMARY KEY,   -- minute start, epoch ms
     temp_c REAL NOT NULL,
     humidity REAL NOT NULL,
     battery INTEGER,
     rssi INTEGER,
     samples INTEGER NOT NULL
   )`,
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

export class Store {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly newestStmt: Database.Statement<[], DbRow>;
  private readonly countRangeStmt: Database.Statement<{ from: number; to: number }, { n: number }>;
  private readonly rangeStmt: Database.Statement<{ from: number; to: number }, DbRow>;
  private readonly bucketStmt: Database.Statement<{ from: number; to: number; bucketMs: number }, DbRow>;
  private readonly statsStmt: Database.Statement<[], { n: number; oldest: number | null; newest: number | null }>;
  private cachedStats: StoreStats;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();

    // If a minute is written twice (e.g. a partial minute flushed at shutdown and
    // the rest after restart), merge it as a sample-weighted average.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO readings (ts, temp_c, humidity, battery, rssi, samples)
      VALUES (@ts, @tempC, @humidity, @battery, @rssi, @samples)
      ON CONFLICT(ts) DO UPDATE SET
        temp_c   = (temp_c * samples + excluded.temp_c * excluded.samples) / (samples + excluded.samples),
        humidity = (humidity * samples + excluded.humidity * excluded.samples) / (samples + excluded.samples),
        battery  = COALESCE(excluded.battery, battery),
        rssi     = COALESCE(excluded.rssi, rssi),
        samples  = samples + excluded.samples`);
    this.newestStmt = this.db.prepare('SELECT ts, temp_c, humidity, battery, rssi FROM readings ORDER BY ts DESC LIMIT 1');
    this.countRangeStmt = this.db.prepare('SELECT COUNT(*) AS n FROM readings WHERE ts BETWEEN @from AND @to');
    this.rangeStmt = this.db.prepare(
      'SELECT ts, temp_c, humidity, battery, rssi FROM readings WHERE ts BETWEEN @from AND @to ORDER BY ts',
    );
    // CAST guards against the division being done in floating point if a
    // parameter is bound as REAL; bucket indexes are never negative here.
    this.bucketStmt = this.db.prepare(`
      SELECT @from + CAST((ts - @from) / @bucketMs AS INTEGER) * @bucketMs AS ts,
             AVG(temp_c) AS temp_c, AVG(humidity) AS humidity, AVG(battery) AS battery, AVG(rssi) AS rssi
      FROM readings
      WHERE ts BETWEEN @from AND @to
      GROUP BY CAST((ts - @from) / @bucketMs AS INTEGER)
      ORDER BY ts`);
    this.statsStmt = this.db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM readings');
    this.cachedStats = this.computeStats();
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

  upsertMinute(row: MinuteRow): void {
    this.upsertStmt.run({ battery: null, rssi: null, ...row });
    this.cachedStats = this.computeStats();
  }

  upsertMany(rows: Iterable<MinuteRow>): void {
    this.db.transaction(() => {
      for (const row of rows) this.upsertStmt.run({ battery: null, rssi: null, ...row });
    })();
    this.cachedStats = this.computeStats();
  }

  /** Cached and refreshed on every write, so /api/health never scans the table. */
  stats(): StoreStats {
    return this.cachedStats;
  }

  newest(): Reading | null {
    const row = this.newestStmt.get();
    return row ? toReading(row) : null;
  }

  /**
   * Rows with from <= ts <= to, oldest first. If there are more than
   * `maxPoints`, the range is split into `maxPoints` equal buckets and one
   * averaged reading is returned per non-empty bucket (ts = bucket start).
   */
  readings(from: number, to: number, maxPoints: number): Reading[] {
    const points = Math.min(MAX_POINTS_LIMIT, Math.max(1, Math.floor(maxPoints)));
    const { n } = this.countRangeStmt.get({ from, to })!;
    if (n === 0) return [];
    if (n <= points) return this.rangeStmt.all({ from, to }).map(toReading);
    // The range is inclusive, so it spans to - from + 1 ms; rounding up keeps
    // the bucket index of `to` at most points - 1.
    const bucketMs = Math.max(1, Math.ceil((to - from + 1) / points));
    return this.bucketStmt.all({ from, to, bucketMs }).map(toReading);
  }

  close(): void {
    this.db.close();
  }

  private computeStats(): StoreStats {
    const { n, oldest, newest } = this.statsStmt.get()!;
    return { readings: n, oldest, newest };
  }
}
