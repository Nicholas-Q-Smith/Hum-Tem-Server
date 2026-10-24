import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { encodeH5075 } from '../src/govee/h5075.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recorder.js';
import { canonicalAddress, parseSensorsSpec, SensorSelector, type SensorSpec } from '../src/sensors.js';
import { createApiServer } from '../src/server.js';
import type { Advertisement } from '../src/sources/types.js';
import { Store } from '../src/store.js';

const log = createLogger('error');
const T0 = Date.UTC(2026, 0, 1, 12);
const LIVING = 'a4:c1:38:00:00:01';
const BED = 'a4:c1:38:00:00:02';
const NEIGHBOUR = 'a4:c1:38:99:99:99';

const adv = (address: string, name: string, receivedAt: number, tempC: number): Advertisement => ({
  id: address.replaceAll(':', ''),
  address,
  localName: name,
  manufacturerData: encodeH5075({ tempC, humidity: 50, battery: 90 }),
  rssi: -60,
  receivedAt,
});

describe('sensor config', () => {
  it('canonicalises MAC addresses', () => {
    expect(canonicalAddress('A4-C1-38-12-34-56')).toBe('a4:c1:38:12:34:56');
    expect(canonicalAddress('a4c138123456')).toBe('a4:c1:38:12:34:56');
    expect(canonicalAddress('GVH5075_3456')).toBeUndefined();
  });

  it('parses SENSORS with rooms, names and mixed separators', () => {
    expect(parseSensorsSpec(' A4:C1:38:12:34:56=Living room ; GVH5075_ABCD=Bedroom,a4c138000003\n')).toEqual([
      { address: 'a4:c1:38:12:34:56', room: 'Living room' },
      { name: 'GVH5075_ABCD', room: 'Bedroom' },
      { address: 'a4:c1:38:00:00:03', room: undefined },
    ]);
    expect(() => parseSensorsSpec('a4c138000003=A;A4:C1:38:00:00:03=B')).toThrow(/twice/);
  });

  it('keeps SENSOR_ADDRESS / SENSOR_NAME working and rejects mixing them with SENSORS', () => {
    expect(loadConfig([], { SENSOR_ADDRESS: 'A4:C1:38:12:34:56' }).sensors).toEqual([{ address: 'a4:c1:38:12:34:56' }]);
    expect(loadConfig([], { SENSOR_NAME: 'GVH5075_3456' }).sensors).toEqual([{ name: 'GVH5075_3456' }]);
    expect(loadConfig([], {}).sensors).toEqual([]);
    expect(() => loadConfig([], { SENSORS: `${LIVING}=X`, SENSOR_ADDRESS: BED })).toThrow(/not both/);
  });
});

/** A recorder + selector + HTTP server over one database. */
async function setup(specs: SensorSpec[], dbPath = ':memory:') {
  const store = new Store(dbPath);
  const recorder = new Recorder(store, specs, log);
  const selector = new SensorSelector(recorder.matcher, log);
  const server: Server = createApiServer({ store, recorder, nearby: () => selector.nearby(T0), version: 't', log });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const feed = (a: Advertisement) => {
    const m = selector.handle(a);
    if (m) recorder.handle(m);
    return m !== null;
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  return { base, store, recorder, selector, feed, call, get: (path: string) => call('GET', path), close };
}

let env: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('sensors managed by SENSORS (config)', () => {
  it('records only configured sensors (by address or name), lists the rest as nearby, refuses edits', async () => {
    env = await setup(parseSensorsSpec(`${LIVING}=Living room;GVH5075_0002=Bedroom`));
    expect(env.feed(adv(LIVING, 'GVH5075_0001', T0, 21))).toBe(true);
    expect(env.feed(adv(BED, 'GVH5075_0002', T0, 19))).toBe(true);
    expect(env.feed(adv(NEIGHBOUR, 'GVH5075_9999', T0, 25))).toBe(false);

    const { body } = await env.get('/api/sensors');
    expect(body.managedBy).toBe('config');
    expect(body.sensors.map((s: any) => [s.id, s.room, s.primary, s.recording])).toEqual([
      [LIVING, 'Living room', true, true],
      [BED, 'Bedroom', false, true],
    ]);
    expect(body.nearby.map((d: any) => d.id)).toEqual([NEIGHBOUR]);

    expect((await env.call('PATCH', `/api/sensors/${BED}`, { room: 'Office' })).status).toBe(409);
    expect((await env.call('POST', '/api/sensors', { id: NEIGHBOUR })).status).toBe(409);
  });

  it('keeps per-sensor data apart, defaults to the primary, and 404s unknown sensors', async () => {
    env = await setup(parseSensorsSpec(`${LIVING}=Living room;${BED}=Bedroom`));
    for (let i = 0; i < 30; i++) {
      env.feed(adv(LIVING, 'GVH5075_0001', T0 + i * 2_000, 21));
      env.feed(adv(BED, 'GVH5075_0002', T0 + i * 2_000 + 1, 18));
    }
    env.recorder.flushBefore(T0 + 120_000);

    const range = `from=${T0}&to=${T0 + 60_000}&maxPoints=300`;
    expect((await env.get(`/api/readings?${range}`)).body.readings).toEqual([
      { ts: T0, tempC: 21, humidity: 50, battery: 90, rssi: -60 },
    ]);
    expect((await env.get(`/api/readings?${range}&sensor=${BED.toUpperCase()}`)).body.readings[0].tempC).toBe(18);
    expect((await env.get(`/api/latest?sensor=${BED.replaceAll(':', '')}`)).body.reading.tempC).toBe(18);
    expect((await env.get('/api/latest')).body.reading.tempC).toBe(21);
    expect((await env.get(`/api/samples?from=${T0}&to=${T0 + 60_000}&sensor=${BED}&limit=5`)).body.readings).toHaveLength(5);
    expect((await env.get(`/api/latest?sensor=${NEIGHBOUR}`)).status).toBe(404);
    expect((await env.get(`/api/readings?${range}&sensor=nope`)).status).toBe(404);
    expect((await env.get('/api/health')).body).toMatchObject({ ok: true, readings: 2, samples: 60, sensors: 2 });
  });
});

describe('sensors managed from the app (api)', () => {
  it('adopts the first H5075 heard when there are none, and lists others as nearby', async () => {
    env = await setup([]);
    expect(env.feed(adv(LIVING, 'GVH5075_0001', T0, 21))).toBe(true);
    expect(env.feed(adv(BED, 'GVH5075_0002', T0, 19))).toBe(false);
    const { body } = await env.get('/api/sensors');
    expect(body.managedBy).toBe('api');
    expect(body.sensors.map((s: any) => [s.id, s.name, s.primary])).toEqual([[LIVING, 'GVH5075_0001', true]]);
    expect(body.nearby.map((d: any) => d.id)).toEqual([BED]);
  });

  it('adds, renames, stops, reorders and validates', async () => {
    env = await setup([]);
    env.feed(adv(LIVING, 'GVH5075_0001', T0, 21));
    env.feed(adv(BED, 'GVH5075_0002', T0, 19));

    // Add the nearby sensor with a room: it's recorded from the next packet and leaves `nearby`.
    const added = await env.call('POST', '/api/sensors', { id: BED.toUpperCase(), room: '  Bedroom ' });
    expect(added.status).toBe(201);
    expect(added.body.sensor).toMatchObject({ id: BED, room: 'Bedroom', recording: true, primary: false, position: 1 });
    expect((await env.get('/api/sensors')).body.nearby).toEqual([]);
    expect(env.feed(adv(BED, 'GVH5075_0002', T0 + 2_000, 19))).toBe(true);
    expect((await env.call('POST', '/api/sensors', { id: BED })).status).toBe(200); // already there

    // Rename and clear rooms.
    expect((await env.call('PATCH', `/api/sensors/${LIVING}`, { room: 'Living room' })).body.sensor.room).toBe('Living room');
    expect((await env.call('PATCH', `/api/sensors/${encodeURIComponent(BED)}`, { room: '' })).body.sensor.room).toBeNull();

    // Make Bedroom the primary; default API calls follow it.
    const primary = await env.call('PATCH', `/api/sensors/${BED}`, { primary: true });
    expect(primary.body.sensor).toMatchObject({ primary: true, position: 0 });
    expect((await env.get('/api/latest')).body.reading.tempC).toBe(19);
    expect((await env.call('PATCH', `/api/sensors/${BED}`, { position: 5 })).body.sensor.position).toBe(1);

    // Stop recording: packets are ignored (not nearby), history and listing stay; primary moves on.
    const stopped = await env.call('PATCH', `/api/sensors/${LIVING}`, { recording: false });
    expect(stopped.body.sensor).toMatchObject({ recording: false, primary: false });
    expect(env.feed(adv(LIVING, 'GVH5075_0001', T0 + 4_000, 21))).toBe(false);
    const listed = (await env.get('/api/sensors')).body;
    expect(listed.sensors.map((s: any) => [s.id, s.recording, s.primary])).toEqual([
      [LIVING, false, false],
      [BED, true, true],
    ]);
    expect(listed.nearby).toEqual([]);
    expect((await env.call('PATCH', `/api/sensors/${LIVING}`, { recording: true })).body.sensor.recording).toBe(true);

    // Validation.
    for (const [method, path, body] of [
      ['POST', '/api/sensors', { id: 'GVH5075_0002' }],
      ['POST', '/api/sensors', { id: BED, room: 7 }],
      ['PATCH', `/api/sensors/${BED}`, {}],
      ['PATCH', `/api/sensors/${BED}`, { colour: 'red' }],
      ['PATCH', `/api/sensors/${BED}`, { recording: 'yes' }],
      ['PATCH', `/api/sensors/${BED}`, { room: 'x'.repeat(65) }],
      ['PATCH', `/api/sensors/${BED}`, { position: -1 }],
      ['PATCH', `/api/sensors/${BED}`, { primary: false }],
    ] as const) {
      expect((await env.call(method, path, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await env.call('PATCH', `/api/sensors/${NEIGHBOUR}`, { room: 'x' })).status).toBe(404);
    expect((await env.call('DELETE', `/api/sensors/${BED}`)).status).toBe(405);
  });

  it('rejects bodies that are not JSON', async () => {
    env = await setup([]);
    env.feed(adv(LIVING, 'GVH5075_0001', T0, 21));
    const send = (contentType: string, body: string) =>
      fetch(`${env!.base}/api/sensors/${LIVING}`, { method: 'PATCH', headers: { 'content-type': contentType }, body });
    expect((await send('text/plain', '{"room":"x"}')).status).toBe(400);
    expect((await send('application/json', '{room:')).status).toBe(400);
    expect((await send('application/json', '[1]')).status).toBe(400);
    expect((await send('application/json', JSON.stringify({ room: 'x'.repeat(20_000) }))).status).toBe(400);
  });

  it('persists rooms, order and recording across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pihumtemp-'));
    try {
      const path = join(dir, 'db.sqlite');
      env = await setup([], path);
      env.feed(adv(LIVING, 'GVH5075_0001', T0, 21));
      await env.call('POST', '/api/sensors', { id: BED, room: 'Bedroom' });
      await env.call('PATCH', `/api/sensors/${BED}`, { primary: true });
      await env.call('PATCH', `/api/sensors/${LIVING}`, { room: 'Living room', recording: false });
      await env.close();

      env = await setup([], path);
      const { body } = await env.get('/api/sensors');
      expect(body.sensors.map((s: any) => [s.id, s.room, s.recording, s.primary])).toEqual([
        [BED, 'Bedroom', true, true],
        [LIVING, 'Living room', false, false],
      ]);
      expect(env.feed(adv(LIVING, 'GVH5075_0001', T0, 21))).toBe(false);
      expect(env.feed(adv(BED, 'GVH5075_0002', T0, 19))).toBe(true);
    } finally {
      await env?.close();
      env = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('switching to SENSORS makes the config authoritative over what the app set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pihumtemp-'));
    try {
      const path = join(dir, 'db.sqlite');
      env = await setup([], path);
      env.feed(adv(LIVING, 'GVH5075_0001', T0, 21));
      await env.call('POST', '/api/sensors', { id: BED, room: 'Bedroom' });
      await env.close();

      env = await setup(parseSensorsSpec(`${BED}=Main bedroom`), path);
      const { body } = await env.get('/api/sensors');
      expect(body.sensors.map((s: any) => [s.id, s.room, s.recording, s.primary])).toEqual([
        [BED, 'Main bedroom', true, true],
        [LIVING, null, false, false],
      ]);
    } finally {
      await env?.close();
      env = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
