import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinuteRow } from '../src/aggregator.js';
import { MinuteAggregator } from '../src/aggregator.js';
import { parseReadingsQuery } from '../src/server.js';
import { Store } from '../src/store.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

const row = (i: number, tempC: number, humidity = 50, extra: Partial<MinuteRow> = {}): MinuteRow => ({
  ts: T0 + i * MIN,
  tempC,
  humidity,
  battery: 90,
  rssi: -60,
  samples: 30,
  ...extra,
});

describe('Store.readings', () => {
  let store: Store;
  let S: number;
  beforeEach(() => {
    store = new Store(':memory:');
    S = store.registerSensor('a4:c1:38:00:00:01').id;
  });
  afterEach(() => store.close());

  it('returns rows as-is, oldest first, with inclusive bounds, when within maxPoints', () => {
    store.upsertMany(S, [row(2, 22), row(0, 20), row(1, 21), row(3, 23)]);
    expect(store.readings(S, T0, T0 + 2 * MIN, 10)).toEqual([
      { ts: T0, tempC: 20, humidity: 50, battery: 90, rssi: -60 },
      { ts: T0 + MIN, tempC: 21, humidity: 50, battery: 90, rssi: -60 },
      { ts: T0 + 2 * MIN, tempC: 22, humidity: 50, battery: 90, rssi: -60 },
    ]);
  });

  it('returns rows unbucketed when the count equals maxPoints', () => {
    store.upsertMany(S, [row(0, 20), row(1, 21), row(2, 22)]);
    expect(store.readings(S, T0, T0 + 10 * MIN, 3).map((r) => r.ts)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
  });

  it('averages into equal time buckets keyed by bucket start, omitting empty buckets', () => {
    // Range of 12 minutes [T0, T0 + 12min - 1ms], 4 buckets of 3 minutes each.
    // Bucket 0: minutes 0,1,2; bucket 1: empty (gap); bucket 2: minute 6; bucket 3: minutes 9,11.
    store.upsertMany(S, [
      row(0, 20, 40),
      row(1, 21, 50),
      row(2, 22, 60),
      row(6, 30, 70, { battery: 80, rssi: -70 }),
      row(9, 10, 30),
      row(11, 12, 34),
    ]);
    const from = T0;
    const to = T0 + 12 * MIN - 1;
    expect(store.readings(S, from, to, 4)).toEqual([
      { ts: T0, tempC: 21, humidity: 50, battery: 90, rssi: -60 },
      { ts: T0 + 6 * MIN, tempC: 30, humidity: 70, battery: 80, rssi: -70 },
      { ts: T0 + 9 * MIN, tempC: 11, humidity: 32, battery: 90, rssi: -60 },
    ]);
  });

  it('never produces more than maxPoints buckets and includes a row at exactly `to`', () => {
    store.upsertMany(S, Array.from({ length: 1000 }, (_, i) => row(i, 20 + (i % 7))));
    const from = T0;
    const to = T0 + 999 * MIN;
    const result = store.readings(S, from, to, 300);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.length).toBeGreaterThan(290);
    expect(result[0]!.ts).toBe(from);
    expect(result.at(-1)!.ts).toBeLessThanOrEqual(to);
    for (let i = 1; i < result.length; i++) expect(result[i]!.ts).toBeGreaterThan(result[i - 1]!.ts);
    // Bucket starts are aligned to `from`, not to the data.
    const bucketMs = Math.ceil((to - from + 1) / 300);
    for (const r of result) expect((r.ts - from) % bucketMs).toBe(0);
  });

  it('aligns buckets to `from` when it is not a minute boundary', () => {
    store.upsertMany(S, [row(0, 10), row(1, 20), row(2, 30), row(3, 40)]);
    const from = T0 + 30_000;
    const result = store.readings(S, from, T0 + 4 * MIN, 2);
    // Rows in range: minutes 1..3 (3 rows > 2). bucketMs = ceil((210000 + 1) / 2) = 105001.
    expect(result).toEqual([
      { ts: from, tempC: 25, humidity: 50, battery: 90, rssi: -60 }, // minutes 1, 2 (offsets 30s, 90s)
      { ts: from + 105_001, tempC: 40, humidity: 50, battery: 90, rssi: -60 }, // minute 3 (offset 150s)
    ]);
  });

  it('returns an empty list for an empty range', () => {
    store.upsertMany(S, [row(0, 20)]);
    expect(store.readings(S, T0 + MIN, T0 + 100 * MIN, 300)).toEqual([]);
  });

  it('merges a re-written minute as a sample-weighted average', () => {
    store.writeMinute(S, row(0, 20, 40, { samples: 10 }), []);
    store.writeMinute(S, row(0, 24, 60, { samples: 30, battery: 89 }), []);
    expect(store.readings(S, T0, T0, 10)).toEqual([{ ts: T0, tempC: 23, humidity: 55, battery: 89, rssi: -60 }]);
    expect(store.stats()).toEqual({ readings: 1, oldest: T0, newest: T0, samples: 0 });
  });

  it('reports newest row and stats', () => {
    expect(store.newest(S)).toBeNull();
    expect(store.stats()).toEqual({ readings: 0, oldest: null, newest: null, samples: 0 });
    store.upsertMany(S, [row(5, 25), row(1, 21)]);
    expect(store.newest(S)).toEqual({ ts: T0 + 5 * MIN, tempC: 25, humidity: 50, battery: 90, rssi: -60 });
    expect(store.stats()).toEqual({ readings: 2, oldest: T0 + MIN, newest: T0 + 5 * MIN, samples: 0 });
  });
});

describe('parseReadingsQuery', () => {
  const q = (s: string) => parseReadingsQuery(new URLSearchParams(s));

  it('parses and clamps maxPoints', () => {
    expect(q('from=1&to=2&maxPoints=300')).toEqual({ from: 1, to: 2, maxPoints: 300 });
    expect(q('from=1&to=2&maxPoints=0')).toEqual({ from: 1, to: 2, maxPoints: 1 });
    expect(q('from=1&to=2&maxPoints=99999')).toEqual({ from: 1, to: 2, maxPoints: 5000 });
    expect(q('from=1&to=2')).toEqual({ from: 1, to: 2, maxPoints: 1000 });
  });

  it('rejects bad params', () => {
    for (const s of ['', 'from=1', 'to=1', 'from=a&to=2', 'from=1&to=2.5', 'from=3&to=2', 'from=1&to=2&maxPoints=x']) {
      expect(q(s)).toHaveProperty('error');
    }
  });
});

describe('MinuteAggregator', () => {
  const sample = (ts: number, tempC: number, battery = 90) => ({
    sensorId: 'x',
    ts,
    tempC,
    humidity: 50,
    battery,
    rssi: -60,
  });

  it('emits one averaged row per closed minute', () => {
    const rows: MinuteRow[] = [];
    const agg = new MinuteAggregator((r) => rows.push(r));
    agg.add(sample(T0 + 1_000, 20));
    agg.add(sample(T0 + 30_000, 21, 89));
    expect(rows).toEqual([]);
    agg.add(sample(T0 + MIN + 5, 25));
    expect(rows).toEqual([{ ts: T0, tempC: 20.5, humidity: 50, battery: 89, rssi: -60, samples: 2 }]);
    agg.flushBefore(T0 + MIN + 59_999);
    expect(rows).toHaveLength(1);
    agg.flushBefore(T0 + 2 * MIN);
    expect(rows[1]).toMatchObject({ ts: T0 + MIN, tempC: 25, samples: 1 });
  });
});
