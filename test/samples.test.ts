import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MinuteAggregator, type MinuteRow } from '../src/aggregator.js';
import { encodeH5075 } from '../src/govee/h5075.js';
import { createLogger } from '../src/logger.js';
import { SensorSelector, type Sample } from '../src/sensors.js';
import { parseSamplesQuery, withPending } from '../src/server.js';
import { Store } from '../src/store.js';

const T0 = Date.UTC(2026, 0, 1);
const sample = (ts: number, tempC = 21.3, humidity = 45.6, battery = 90, rssi = -60): Sample => ({
  sensorId: 'x',
  ts,
  tempC,
  humidity,
  battery,
  rssi,
});
const minuteOf = (samples: Sample[]): MinuteRow => ({
  ts: T0,
  tempC: 21,
  humidity: 45,
  battery: 90,
  rssi: -60,
  samples: samples.length,
});

describe('raw samples', () => {
  let store: Store;
  let S: number;
  beforeEach(() => {
    store = new Store(':memory:');
    S = store.registerSensor('a4:c1:38:00:00:01').id;
  });
  afterEach(() => store.close());

  it('stores every sample with its exact timestamp, losslessly at 0.1 resolution', () => {
    const samples = [sample(T0 + 1_234, 21.3, 45.6), sample(T0 + 3_301, -4.7, 99.9, 89, -71)];
    store.writeMinute(S, minuteOf(samples), samples);
    expect(store.samples(S, T0, T0 + 60_000, 100)).toEqual({
      readings: [
        { ts: T0 + 1_234, tempC: 21.3, humidity: 45.6, battery: 90, rssi: -60 },
        { ts: T0 + 3_301, tempC: -4.7, humidity: 99.9, battery: 89, rssi: -71 },
      ],
      next: null,
    });
    expect(store.stats().samples).toBe(2);
    expect(store.readings(S, T0, T0 + 60_000, 10)).toHaveLength(1);
  });

  it('ignores a second sample at the same millisecond', () => {
    store.writeMinute(S, minuteOf([]), [sample(T0, 20), sample(T0, 25)]);
    expect(store.samples(S, T0, T0, 10).readings).toEqual([{ ts: T0, tempC: 20, humidity: 45.6, battery: 90, rssi: -60 }]);
    expect(store.stats().samples).toBe(1);
  });

  it('pages with an inclusive range and a `next` cursor', () => {
    const samples = Array.from({ length: 25 }, (_, i) => sample(T0 + i * 2_000));
    store.writeMinute(S, minuteOf(samples), samples);
    const seen: number[] = [];
    let from: number | null = T0;
    let pages = 0;
    while (from !== null) {
      const page = store.samples(S, from, T0 + 48_000, 10);
      seen.push(...page.readings.map((r) => r.ts));
      from = page.next;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(samples.map((s) => s.ts));
  });

  it('prunes samples older than a cutoff and keeps minute rows', () => {
    const samples = Array.from({ length: 25_000 }, (_, i) => sample(T0 + i * 100));
    store.writeMinute(S, minuteOf(samples), samples);
    const cutoff = T0 + 20_000 * 100;
    expect(store.pruneSamples(cutoff)).toBe(20_000);
    expect(store.stats().samples).toBe(5_000);
    expect(store.samples(S, T0, cutoff, 10).readings[0]!.ts).toBe(cutoff);
    expect(store.stats().readings).toBe(1);
  });

  it('migrates an existing single-sensor v1 database without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pihumtemp-'));
    try {
      const path = join(dir, 'v1.db');
      const v1 = new Database(path);
      v1.exec(`CREATE TABLE readings (ts INTEGER PRIMARY KEY, temp_c REAL NOT NULL, humidity REAL NOT NULL,
               battery INTEGER, rssi INTEGER, samples INTEGER NOT NULL);
               INSERT INTO readings VALUES (${T0}, 20, 50, 90, -60, 30);
               PRAGMA user_version = 1;`);
      v1.close();
      const migrated = new Store(path);
      expect(migrated.stats()).toEqual({ readings: 1, oldest: T0, newest: T0, samples: 0 });
      // The old rows belong to an unclaimed sensor until the primary claims them.
      const sensor = migrated.registerSensor('a4:c1:38:12:34:56', { room: 'Office', claimLegacy: true });
      expect(sensor).toMatchObject({ id: 1, address: 'a4:c1:38:12:34:56', room: 'Office' });
      expect(migrated.readings(sensor.id, T0, T0, 10)).toEqual([{ ts: T0, tempC: 20, humidity: 50, battery: 90, rssi: -60 }]);
      migrated.writeMinute(sensor.id, { ...minuteOf([]), ts: T0 + 60_000 }, [sample(T0 + 60_000)]);
      expect(migrated.sensorStats(sensor.id)).toEqual({ readings: 2, oldest: T0, newest: T0 + 60_000, samples: 1 });
      // A second sensor starts empty and doesn't see the first one's data.
      const other = migrated.registerSensor('a4:c1:38:ab:cd:ef', { room: 'Bedroom', claimLegacy: true });
      expect(other.id).toBe(2);
      expect(migrated.readings(other.id, T0, T0 + 60_000, 10)).toEqual([]);
      migrated.close();

      // Counts are persisted, not recounted, and survive a restart.
      const reopened = new Store(path);
      expect(reopened.sensorStats(1)).toEqual({ readings: 2, oldest: T0, newest: T0 + 60_000, samples: 1 });
      expect(reopened.stats()).toEqual({ readings: 2, oldest: T0, newest: T0 + 60_000, samples: 1 });
      expect(reopened.pruneSamples(T0 + 120_000)).toBe(1);
      reopened.close();
      const again = new Store(path);
      expect(again.sensorStats(1).samples).toBe(0);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MinuteAggregator raw samples', () => {
  it('hands each minute its own samples', () => {
    const out: [MinuteRow, Sample[]][] = [];
    const agg = new MinuteAggregator((row, samples) => out.push([row, samples]));
    const a = sample(T0 + 1_000);
    const b = sample(T0 + 59_999);
    const c = sample(T0 + 60_000);
    agg.add(a);
    agg.add(b);
    agg.add(c);
    agg.flushAll();
    expect(out.map(([row, s]) => [row.ts, row.samples, s])).toEqual([
      [T0, 2, [a, b]],
      [T0 + 60_000, 1, [c]],
    ]);
  });
});

describe('pending (unflushed) samples', () => {
  it('holds the open minute until it is flushed', () => {
    const agg = new MinuteAggregator(() => {});
    const a = sample(T0 + 1_000);
    const b = sample(T0 + 3_000);
    agg.add(a);
    agg.add(b);
    expect(agg.pending()).toEqual([a, b]);
    agg.add(sample(T0 + 61_000)); // closes the first minute
    expect(agg.pending().map((s) => s.ts)).toEqual([T0 + 61_000]);
  });

  const stored = (...ts: number[]) => ts.map((t) => ({ ts: t, tempC: 21, humidity: 45 }));
  const q = { from: T0, to: T0 + 120_000, limit: 10 };

  it('appends unflushed samples after the stored ones', () => {
    const page = withPending({ readings: stored(T0 + 1_000, T0 + 3_000), next: null }, [sample(T0 + 61_000), sample(T0 + 63_000)], q);
    expect(page.readings.map((r) => r.ts)).toEqual([T0 + 1_000, T0 + 3_000, T0 + 61_000, T0 + 63_000]);
    expect(page.next).toBeNull();
  });

  it('leaves a page that is not the last one alone', () => {
    const page = { readings: stored(T0 + 1_000), next: T0 + 1_001 };
    expect(withPending(page, [sample(T0 + 61_000)], q)).toBe(page);
  });

  it('respects the range and never repeats a stored sample', () => {
    const page = withPending(
      { readings: stored(T0 + 61_000), next: null },
      [sample(T0 + 61_000), sample(T0 + 62_000), sample(T0 + 130_000)],
      q,
    );
    expect(page.readings.map((r) => r.ts)).toEqual([T0 + 61_000, T0 + 62_000]);
  });

  it('pages past the limit', () => {
    const pending = Array.from({ length: 5 }, (_, i) => sample(T0 + 60_000 + i * 2_000));
    const page = withPending({ readings: [], next: null }, pending, { ...q, limit: 3 });
    expect(page.readings).toHaveLength(3);
    expect(page.next).toBe(T0 + 64_001);
    const rest = withPending({ readings: [], next: null }, pending, { ...q, from: page.next!, limit: 3 });
    expect(rest.readings.map((r) => r.ts)).toEqual([T0 + 66_000, T0 + 68_000]);
  });
});

describe('SensorSelector echo suppression', () => {
  const log = createLogger('error');
  const adv = (receivedAt: number, tempC: number, rssi = -60) => ({
    id: 'a4c138123456',
    address: 'a4:c1:38:12:34:56',
    localName: 'GVH5075_3456',
    manufacturerData: encodeH5075({ tempC, humidity: 50, battery: 90 }),
    rssi,
    receivedAt,
  });

  it('drops the scan-response echo but keeps the next real advertisement', () => {
    const sel = new SensorSelector(() => ({ record: true }), log);
    expect(sel.handle(adv(T0, 21))).not.toBeNull();
    expect(sel.handle(adv(T0 + 5, 21, -62))).toBeNull(); // echo
    expect(sel.handle(adv(T0 + 2_000, 21))).not.toBeNull(); // same value, next broadcast
    expect(sel.handle(adv(T0 + 2_010, 21.1))).not.toBeNull(); // changed value
  });
});

describe('parseSamplesQuery', () => {
  const q = (s: string) => parseSamplesQuery(new URLSearchParams(s));
  it('defaults and clamps limit, rejects bad params', () => {
    expect(q('from=1&to=2')).toEqual({ from: 1, to: 2, limit: 10_000 });
    expect(q('from=1&to=2&limit=0')).toEqual({ from: 1, to: 2, limit: 1 });
    expect(q('from=1&to=2&limit=999999')).toEqual({ from: 1, to: 2, limit: 50_000 });
    for (const s of ['', 'from=1', 'from=2&to=1', 'from=1&to=2&limit=x']) expect(q(s)).toHaveProperty('error');
  });
});
