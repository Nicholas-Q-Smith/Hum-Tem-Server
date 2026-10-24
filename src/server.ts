import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from './logger.js';
import { MAX_POINTS_LIMIT, type Reading, type Store } from './store.js';

/** Live state owned by the recorder, read by the API. */
export interface LiveState {
  latest: Reading | null;
  lastAdvertisement: number | null;
}

export interface ApiDeps {
  store: Store;
  live: LiveState;
  version: string;
  log: Logger;
}

export const DEFAULT_MAX_POINTS = 1000;

export type ReadingsQuery = { from: number; to: number; maxPoints: number };

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

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}

export function createApiServer({ store, live, version, log }: ApiDeps): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return send(req, res, 405, { error: 'method not allowed' });
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
            lastAdvertisement: live.lastAdvertisement,
          });
        }
        case '/api/latest':
          return send(req, res, 200, { reading: live.latest ?? store.newest() });
        case '/api/readings': {
          const q = parseReadingsQuery(url.searchParams);
          if ('error' in q) return send(req, res, 400, { error: q.error });
          return send(req, res, 200, { readings: store.readings(q.from, q.to, q.maxPoints) });
        }
        default:
          return send(req, res, 404, { error: 'not found' });
      }
    } catch (err) {
      log.error(`${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) send(req, res, 500, { error: 'internal error' });
      else res.destroy();
    } finally {
      log.debug(`${req.method} ${req.url} -> ${res.statusCode}`);
    }
  });
}
