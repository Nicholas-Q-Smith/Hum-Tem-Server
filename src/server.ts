import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.js';
import { type Recorder, SensorAdminError, type TrackedSensor } from './recorder.js';
import type { NearbyDevice, Sample } from './sensors.js';
import { MAX_POINTS_LIMIT, MAX_SAMPLES_LIMIT, type SamplePage, type Store } from './store.js';
import type { SourceStatus } from './sources/types.js';
import type { Uptime } from './uptime.js';

export interface ApiDeps {
  store: Store;
  recorder: Recorder;
  /** H5075s heard but not recorded. */
  nearby: () => NearbyDevice[];
  uptime: Uptime;
  /** Bluetooth/source state for /api/health. */
  bluetooth?: () => SourceStatus;
  version: string;
  log: Logger;
}

export const DEFAULT_MAX_POINTS = 1000;
export const DEFAULT_SAMPLES_LIMIT = 10_000;

export type ReadingsQuery = { from: number; to: number; maxPoints: number };
export type SamplesQuery = { from: number; to: number; limit: number };

function parseInteger(params: URLSearchParams, name: string): number | undefined | Error {
  const value = params.get(name);
  if (value === null) return undefined;
  if (!/^-?\d+$/.test(value.trim())) return new Error(`${name} must be an integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return new Error(`${name} is out of range`);
  return n;
}

/** Validates /api/readings params; returns an error message for a 400. */
export function parseReadingsQuery(params: URLSearchParams): ReadingsQuery | { error: string } {
  const from = parseInteger(params, 'from');
  if (from instanceof Error) return { error: from.message };
  const to = parseInteger(params, 'to');
  if (to instanceof Error) return { error: to.message };
  const maxPoints = parseInteger(params, 'maxPoints');
  if (maxPoints instanceof Error) return { error: maxPoints.message };
  if (from === undefined || to === undefined) return { error: 'from and to are required (epoch ms)' };
  if (from > to) return { error: 'from must be <= to' };
  return { from, to, maxPoints: Math.min(MAX_POINTS_LIMIT, Math.max(1, maxPoints ?? DEFAULT_MAX_POINTS)) };
}

/** Validates /api/uptime params; returns an error message for a 400. */
export function parseRangeQuery(params: URLSearchParams): { from: number; to: number } | { error: string } {
  const from = parseInteger(params, 'from');
  if (from instanceof Error) return { error: from.message };
  const to = parseInteger(params, 'to');
  if (to instanceof Error) return { error: to.message };
  if (from === undefined || to === undefined) return { error: 'from and to are required (epoch ms)' };
  if (from > to) return { error: 'from must be <= to' };
  return { from, to };
}

/** Validates /api/samples params; returns an error message for a 400. */
export function parseSamplesQuery(params: URLSearchParams): SamplesQuery | { error: string } {
  const from = parseInteger(params, 'from');
  if (from instanceof Error) return { error: from.message };
  const to = parseInteger(params, 'to');
  if (to instanceof Error) return { error: to.message };
  const limit = parseInteger(params, 'limit');
  if (limit instanceof Error) return { error: limit.message };
  if (from === undefined || to === undefined) return { error: 'from and to are required (epoch ms)' };
  if (from > to) return { error: 'from must be <= to' };
  return { from, to, limit: Math.min(MAX_SAMPLES_LIMIT, Math.max(1, limit ?? DEFAULT_SAMPLES_LIMIT)) };
}

const MAX_BODY_BYTES = 16 * 1024;

class BadRequest extends Error {}

/** Reads a small JSON request body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new BadRequest('Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('request body is not valid JSON');
  }
}

/**
 * Raw samples are stored when their minute closes, so the stored page ends up to a
 * minute behind. Once the page has reached the end of what's stored, add the
 * in-memory samples of the still-open minute so clients see readings within seconds.
 */
export function withPending(page: SamplePage, pending: readonly Sample[], { from, to, limit }: SamplesQuery): SamplePage {
  if (page.next !== null) return page;
  const after = page.readings.at(-1)?.ts ?? from - 1;
  const extra = pending
    .filter((s) => s.ts >= from && s.ts <= to && s.ts > after)
    .map((s) => ({ ts: s.ts, tempC: s.tempC, humidity: s.humidity, battery: s.battery, rssi: s.rssi }));
  if (extra.length === 0) return page;
  const readings = [...page.readings, ...extra];
  if (readings.length <= limit) return { readings, next: null };
  const kept = readings.slice(0, limit);
  return { readings: kept, next: kept.at(-1)!.ts + 1 };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}

export function createApiServer({ store, recorder, nearby, uptime, bluetooth, version, log }: ApiDeps): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    /**
     * Resolves `?sensor=` (a MAC address; default: the primary sensor). Sends a
     * 404 for an unknown sensor; returns null when none is known yet.
     */
    const sensorParam = (): TrackedSensor | null | false => {
      const param = url.searchParams.get('sensor');
      const sensor = recorder.resolve(param);
      if (sensor) return sensor;
      if (param !== null && param.trim() !== '') {
        send(req, res, 404, { error: `unknown sensor: ${param}` });
        return false;
      }
      return null;
    };
    const listSensors = () => {
      const primaryId = recorder.primary()?.id;
      return {
        managedBy: recorder.managedBy,
        sensors: recorder.list().map((s) => recorder.summary(s, primaryId)),
        nearby: nearby().filter((d) => !recorder.resolve(d.id)),
      };
    };
    const allow = (methods: string) => {
      res.setHeader('Allow', methods);
      send(req, res, 405, { error: 'method not allowed' });
    };
    try {
      // Sensor management: POST /api/sensors adds one, PATCH /api/sensors/<mac> changes one.
      if (url.pathname === '/api/sensors' && req.method === 'POST') {
        const body = (await readJson(req)) as { id?: unknown; room?: unknown } | null;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('body must be a JSON object');
        const { sensor, created } = recorder.add(body.id, body.room);
        return send(req, res, created ? 201 : 200, { sensor: recorder.summary(sensor) });
      }
      const sensorPath = /^\/api\/sensors\/([^/]+)$/.exec(url.pathname);
      if (sensorPath) {
        const id = decodeURIComponent(sensorPath[1]!);
        if (req.method === 'PATCH') {
          const sensor = recorder.update(id, await readJson(req));
          return send(req, res, 200, { sensor: recorder.summary(sensor) });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return allow('GET, HEAD, PATCH');
        const sensor = recorder.resolve(id);
        if (!sensor) return send(req, res, 404, { error: `unknown sensor: ${id}` });
        return send(req, res, 200, { sensor: recorder.summary(sensor) });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return allow(url.pathname === '/api/sensors' ? 'GET, HEAD, POST' : 'GET, HEAD');
      }
      switch (url.pathname) {
        case '/api/health': {
          const stats = store.stats();
          return send(req, res, 200, {
            ok: true,
            version,
            readings: stats.readings,
            oldest: stats.oldest,
            newest: stats.newest,
            samples: stats.samples,
            sensors: recorder.list().length,
            lastAdvertisement: recorder.lastAdvertisement(),
            bluetooth: bluetooth?.() ?? null,
          });
        }
        case '/api/sensors':
          return send(req, res, 200, listSensors());
        case '/api/latest': {
          const sensor = sensorParam();
          if (sensor === false) return;
          return send(req, res, 200, { reading: sensor ? (sensor.latest ?? store.newest(sensor.record.id)) : null });
        }
        case '/api/readings': {
          const q = parseReadingsQuery(url.searchParams);
          if ('error' in q) return send(req, res, 400, { error: q.error });
          const sensor = sensorParam();
          if (sensor === false) return;
          return send(req, res, 200, {
            readings: sensor ? store.readings(sensor.record.id, q.from, q.to, q.maxPoints) : [],
          });
        }
        case '/api/uptime': {
          const q = parseRangeQuery(url.searchParams);
          if ('error' in q) return send(req, res, 400, { error: q.error });
          return send(req, res, 200, uptime.query(q.from, q.to));
        }
        case '/api/samples': {
          const q = parseSamplesQuery(url.searchParams);
          if ('error' in q) return send(req, res, 400, { error: q.error });
          const sensor = sensorParam();
          if (sensor === false) return;
          if (!sensor) return send(req, res, 200, { readings: [], next: null });
          const page = store.samples(sensor.record.id, q.from, q.to, q.limit);
          return send(req, res, 200, withPending(page, sensor.aggregator.pending(), q));
        }
        default:
          return send(req, res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err instanceof SensorAdminError) return send(req, res, err.status, { error: err.message });
      if (err instanceof BadRequest) return send(req, res, 400, { error: err.message });
      log.error(`${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) send(req, res, 500, { error: 'internal error' });
      else res.destroy();
    } finally {
      log.debug(`${req.method} ${req.url} -> ${res.statusCode}`);
    }
  });
}
