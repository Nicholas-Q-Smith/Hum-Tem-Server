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

function fresh() {
  const store = new Store(':memory:');
  return { store, uptime: new Uptime(store, log) };
}

describe('Uptime', () => {
  it('extends one run with each heartbeat', () => {
    const { store, uptime } = fresh();
    uptime.beat(T0);
    uptime.beat(T0 + HEARTBEAT_MS);
    uptime.beat(T0 + 2 * HEARTBEAT_MS);
    expect(store.runs(0, Infinity)).toEqual([{ started: T0, lastSeen: T0 + 2 * HEARTBEAT_MS }]);
  });

  it('starts a new run after a restart, leaving the downtime between them', () => {
    const store = new Store(':memory:');
    new Uptime(store, log).beat(T0);
    new Uptime(store, log).beat(T0 + 30 * MIN); // restarted half an hour later
    expect(store.runs(0, Infinity)).toEqual([
      { started: T0, lastSeen: T0 },
      { started: T0 + 30 * MIN, lastSeen: T0 + 30 * MIN },
    ]);
  });

  it('splits the run when the clock jumps or the process stalls', () => {
    const { store, uptime } = fresh();
    uptime.beat(T0);
    uptime.beat(T0 + HEARTBEAT_MS);
    uptime.beat(T0 + 2 * 3_600_000); // e.g. NTP corrected a stale boot clock
    uptime.beat(T0 - 5 * MIN); // clock went backwards
    expect(store.runs(-Infinity, Infinity).map((r) => r.started)).toEqual([T0 - 5 * MIN, T0, T0 + 2 * 3_600_000]);
  });

  it('records nothing while the clock is unset', () => {
    const { store, uptime } = fresh();
    uptime.beat(Date.UTC(1970, 0, 2));
    expect(store.runs(-Infinity, Infinity)).toEqual([]);
    expect(uptime.query(0, Infinity).since).toBeNull();
  });

  it('reports the current run as lasting until now, and earlier runs as recorded', () => {
    const store = new Store(':memory:');
    new Uptime(store, log).beat(T0);
    const uptime = new Uptime(store, log);
    uptime.beat(T0 + 10 * MIN);
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
    new Uptime(store, log).beat(T0);
    new Uptime(store, log).beat(T0 + 60 * MIN);
    const uptime = new Uptime(store, log);
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
