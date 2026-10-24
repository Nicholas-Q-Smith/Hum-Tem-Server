import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { encodeH5075 } from '../src/govee/h5075.js';
import { createLogger } from '../src/logger.js';
import { Recorder } from '../src/recorder.js';
import { canonicalAddress, parseSensorsSpec, SensorSelector } from '../src/sensors.js';
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

describe('SensorSelector', () => {
  it('records only configured sensors and lists the rest as nearby', () => {
    const specs = parseSensorsSpec(`${LIVING}=Living room;GVH5075_0002=Bedroom`);
    const sel = new SensorSelector(specs, [], log);
    expect(sel.handle(adv(LIVING, 'GVH5075_0001', T0, 21))?.spec).toBe(specs[0]);
    expect(sel.handle(adv(BED, 'GVH5075_0002', T0, 19))?.spec).toBe(specs[1]); // matched by name
    expect(sel.handle(adv(NEIGHBOUR, 'GVH5075_9999', T0, 25))).toBeNull();
    expect(sel.nearby(T0).map((d) => d.id)).toEqual([NEIGHBOUR]);
  });

  it('in auto mode keeps recording sensors already in the database and adopts nothing new', () => {
    const sel = new SensorSelector([], [BED], log);
    expect(sel.handle(adv(LIVING, 'GVH5075_0001', T0, 21))).toBeNull();
    expect(sel.handle(adv(BED, 'GVH5075_0002', T0, 19))?.sample.sensorId).toBe(BED);
  });

  it('in auto mode with an empty database adopts the first H5075 heard', () => {
    const sel = new SensorSelector([], [], log);
    expect(sel.handle(adv(LIVING, 'GVH5075_0001', T0, 21))?.sample.sensorId).toBe(LIVING);
    expect(sel.handle(adv(BED, 'GVH5075_0002', T0, 19))).toBeNull();
  });
});

describe('Recorder + API', () => {
  let store: Store;
  let recorder: Recorder;
  let selector: SensorSelector;
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    store = new Store(':memory:');
    const specs = parseSensorsSpec(`${LIVING}=Living room;${BED}=Bedroom`);
    recorder = new Recorder(store, specs, log);
    selector = new SensorSelector(specs, recorder.knownIds(), log);
    const server = createApiServer({ store, recorder, nearby: () => selector.nearby(T0), version: 't', log });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    store.close();
  });

  const feed = (a: Advertisement) => {
    const m = selector.handle(a);
    if (m) recorder.handle(m);
  };
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as any };
  };

  it('lists configured sensors with rooms before they are heard', async () => {
    const { body } = await get('/api/sensors');
    expect(body.sensors.map((s: any) => [s.id, s.room, s.primary, s.recording, s.latest])).toEqual([
      [LIVING, 'Living room', true, true, null],
      [BED, 'Bedroom', false, true, null],
    ]);
  });

  it('keeps per-sensor data apart, defaults to the primary, and 404s unknown sensors', async () => {
    for (let i = 0; i < 30; i++) {
      feed(adv(LIVING, 'GVH5075_0001', T0 + i * 2_000, 21));
      feed(adv(BED, 'GVH5075_0002', T0 + i * 2_000 + 1, 18));
    }
    feed(adv(NEIGHBOUR, 'GVH5075_9999', T0, 30));
    recorder.flushBefore(T0 + 120_000);

    const range = `from=${T0}&to=${T0 + 60_000}&maxPoints=300`;
    expect((await get(`/api/readings?${range}`)).body.readings).toEqual([
      { ts: T0, tempC: 21, humidity: 50, battery: 90, rssi: -60 },
    ]);
    expect((await get(`/api/readings?${range}&sensor=${BED.toUpperCase()}`)).body.readings[0].tempC).toBe(18);
    expect((await get(`/api/latest?sensor=${BED.replaceAll(':', '')}`)).body.reading.tempC).toBe(18);
    expect((await get('/api/latest')).body.reading.tempC).toBe(21);
    expect((await get(`/api/samples?from=${T0}&to=${T0 + 60_000}&sensor=${BED}&limit=5`)).body.readings).toHaveLength(5);
    expect((await get(`/api/latest?sensor=${NEIGHBOUR}`)).status).toBe(404);
    expect((await get(`/api/readings?${range}&sensor=nope`)).status).toBe(404);

    const health = (await get('/api/health')).body;
    expect(health).toMatchObject({ ok: true, readings: 2, samples: 60, sensors: 2, lastAdvertisement: T0 + 58_001 });

    const sensors = (await get('/api/sensors')).body;
    expect(sensors.sensors.map((s: any) => [s.room, s.readings, s.samples])).toEqual([
      ['Living room', 1, 30],
      ['Bedroom', 1, 30],
    ]);
    expect(sensors.nearby).toMatchObject([{ id: NEIGHBOUR, name: 'GVH5075_9999', reading: { tempC: 30 } }]);
  });
});
