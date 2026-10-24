import { describe, expect, it } from 'vitest';
import { ClockWatch } from '../src/clock.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recorder.js';
import type { Sample } from '../src/sensors.js';
import { Store } from '../src/store.js';

const log = createLogger('error');
const T0 = Date.UTC(2026, 0, 1, 12);
const MAC = 'a4:c1:38:00:00:01';

describe('ClockWatch', () => {
  it('reports steps beyond the tolerance, in either direction', () => {
    const c = new ClockWatch(T0, 0);
    expect(c.check(T0 + 2_000, 2_000)).toBe(0); // in step
    expect(c.check(T0 + 4_000, 3_000)).toBe(0); // 1 s drift is tolerated
    // wall moved 3,596,000 ms while mono moved 2,000 ms: stepped forward by 3,594,000 ms
    expect(c.check(T0 + 3_600_000, 5_000)).toBe(3_594_000);
    expect(c.check(T0, 7_000)).toBeLessThan(0); // stepped back
  });
});

describe('Recorder clock steps', () => {
  it('drops readings buffered on a stale boot clock and keeps those after NTP', () => {
    const store = new Store(':memory:');
    let mono = 0;
    const recorder = new Recorder(store, [], log, () => mono);
    const stale = T0; // fake-hwclock: last shutdown time
    const real = T0 + 2 * 3_600_000; // the actual time
    const feed = (ts: number, tempC: number) => {
      const sample: Sample = { sensorId: MAC, ts, tempC, humidity: 50, battery: 90, rssi: -60 };
      recorder.handle({ sample, name: 'GVH5075_0001' });
    };
    // 10 s of readings on the stale clock...
    for (let i = 0; i < 5; i++) ((mono = i * 2_000), feed(stale + i * 2_000, 99));
    // ...then NTP steps the clock forward.
    for (let i = 5; i < 35; i++) ((mono = i * 2_000), feed(real + (i - 5) * 2_000, 21));
    recorder.flushAll();

    const id = recorder.resolve(MAC)!.record.id;
    expect(store.readings(id, stale - 60_000, stale + 60_000, 100)).toEqual([]);
    const after = store.readings(id, real - 60_000, real + 120_000, 100);
    expect(after.every((r) => r.tempC === 21)).toBe(true);
    expect(store.sensorStats(id).samples).toBe(30);
    store.close();
  });
});
