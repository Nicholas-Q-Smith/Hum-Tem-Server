import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recorder.js';
import { createApiServer, parseRangeQuery } from '../src/server.js';
import { Store } from '../src/store.js';
import { HEARTBEAT_MS, Uptime } from '../src/uptime.js';

const log = createLogger('error');
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

/**
 * An Uptime whose monotonic clock is under test control. `beat(wall)` assumes the
 * clocks advance together (mono = wall - T0); pass `mono` to simulate a clock step.
 */
function tracker(store = new Store(':memory:'), startWall = T0) {
  const uptime = new Uptime(store, log, startWall - T0);
  return { store, uptime, beat: (wall: number, mono = wall - T0) => uptime.beat(wall, mono) };
}

describe('Uptime', () => {
  it('extends one run with each heartbeat', () => {
    const { store, beat } = tracker();
    beat(T0);
    beat(T0 + HEARTBEAT_MS);
    beat(T0 + 2 * HEARTBEAT_MS);
    expect(store.runs(0, Infinity)).toEqual([{ started: T0, lastSeen: T0 + 2 * HEARTBEAT_MS }]);
  });

  it('starts a new run after a restart, leaving the downtime between them', () => {
    const store = new Store(':memory:');
    tracker(store).beat(T0);
    tracker(store, T0 + 30 * MIN).beat(T0 + 30 * MIN); // restarted half an hour later
    expect(store.runs(0, Infinity)).toEqual([
      { started: T0, lastSeen: T0 },
      { started: T0 + 30 * MIN, lastSeen: T0 + 30 * MIN },
    ]);
  });

  it('re-anchors the run when the clock is stepped, so a stale boot clock leaves no stray run', () => {
    // Previous run until T0; the Pi reboots and fake-hwclock restores T0 + 5s,
    // although it is really T0 + 2h. NTP fixes the clock 20s after start.
    const store = new Store(':memory:');
    tracker(store).beat(T0);
    const stale = T0 + 5_000;
    const real = T0 + 2 * 3_600_000;
    const uptime = new Uptime(store, log, 0);
    uptime.beat(stale, 0); // startup, stale clock
    uptime.beat(real + 60_000, 60_000); // first heartbeat after NTP
    uptime.beat(real + 120_000, 120_000);
    expect(store.runs(-Infinity, Infinity)).toEqual([
      { started: T0, lastSeen: T0 },
      { started: real, lastSeen: real + 120_000 }, // up since the real boot time; the 2 h outage remains
    ]);
  });

  it('catches small steps too (a short outage is not hidden)', () => {
    const store = new Store(':memory:');
    tracker(store).beat(T0);
    const uptime = new Uptime(store, log, 0);
    uptime.beat(T0 + 1_000, 0); // stale: looks like we came straight back
    uptime.beat(T0 + 150_000 + 60_000, 60_000); // really back after 2.5 min
    expect(store.runs(-Infinity, Infinity).map((r) => r.started)).toEqual([T0, T0 + 150_000]);
  });

  it('a backwards step is corrected the same way', () => {
    const { store, beat } = tracker();
    beat(T0);
    beat(T0 - 10 * MIN + HEARTBEAT_MS, HEARTBEAT_MS); // clock set back 10 min
    expect(store.runs(-Infinity, Infinity)).toEqual([{ started: T0 - 10 * MIN, lastSeen: T0 - 10 * MIN + HEARTBEAT_MS }]);
  });

  it('splits the run when the process stalls', () => {
    const { store, beat } = tracker();
    beat(T0);
    beat(T0 + HEARTBEAT_MS);
    beat(T0 + 30 * MIN); // both clocks moved 29 min: frozen, not a clock step
    expect(store.runs(-Infinity, Infinity).map((r) => r.started)).toEqual([T0, T0 + 30 * MIN]);
  });

  it('records nothing while the clock is unset, then dates the run from process start', () => {
    const { store, uptime } = tracker(new Store(':memory:'), T0);
    uptime.beat(Date.UTC(1970, 0, 2), 0);
    expect(store.runs(-Infinity, Infinity)).toEqual([]);
    expect(uptime.query(0, Infinity).since).toBeNull();
    uptime.beat(T0 + 90_000, 90_000); // clock set 90 s after start
    expect(store.runs(-Infinity, Infinity)).toEqual([{ started: T0, lastSeen: T0 + 90_000 }]);
  });

  it('reports the current run as lasting until now, and earlier runs as recorded', () => {
    const store = new Store(':memory:');
    tracker(store).beat(T0);
    const { uptime, beat } = tracker(store, T0 + 10 * MIN);
    beat(T0 + 10 * MIN);
    expect(uptime.query(T0 - MIN, T0 + 20 * MIN, T0 + 12 * MIN)).toEqual({
      heartbeatMs: HEARTBEAT_MS,
      since: T0,
      runs: [
        { start: T0, end: T0 },
        { start: T0 + 10 * MIN, end: T0 + 12 * MIN },
      ],
    });
  });

  it('only returns runs overlapping the range', () => {
    const store = new Store(':memory:');
    tracker(store).beat(T0);
    tracker(store, T0 + 60 * MIN).beat(T0 + 60 * MIN);
    const { uptime } = tracker(store);
    expect(uptime.query(T0 + 30 * MIN, T0 + 40 * MIN, T0 + 90 * MIN).runs).toEqual([]);
    expect(uptime.query(T0 + 30 * MIN, T0 + 70 * MIN, T0 + 90 * MIN).runs).toEqual([{ start: T0 + 60 * MIN, end: T0 + 60 * MIN }]);
  });
});

describe('GET /api/uptime', () => {
  it('validates params and answers with runs', async () => {
    const store = new Store(':memory:');
    const uptime = new Uptime(store, log);
    uptime.beat();
    const server: Server = createApiServer({ store, recorder: new Recorder(store, [], log), nearby: () => [], uptime, version: 't', log });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/uptime`)).status).toBe(400);
      const now = Date.now();
      const body = (await (await fetch(`${base}/api/uptime?from=${now - 3_600_000}&to=${now}`)).json()) as any;
      expect(body.heartbeatMs).toBe(HEARTBEAT_MS);
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].end).toBeGreaterThanOrEqual(now);
    } finally {
      server.close();
    }
  });

  it('parseRangeQuery requires an ordered range', () => {
    expect(parseRangeQuery(new URLSearchParams('from=5&to=1'))).toEqual({ error: 'from must be <= to' });
    expect(parseRangeQuery(new URLSearchParams('from=1&to=5'))).toEqual({ from: 1, to: 5 });
  });
});
