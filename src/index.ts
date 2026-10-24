import { readFileSync } from 'node:fs';
import { MINUTE_MS, MinuteAggregator, minuteStart, type MinuteRow } from './aggregator.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SensorSelector, type Sample } from './sensor.js';
import { createApiServer, type LiveState } from './server.js';
import { NobleSource } from './sources/noble.js';
import { SimulatedSource, simulatedBattery, simulatedClimate } from './sources/simulate.js';
import type { AdvertisementSource } from './sources/types.js';
import { Store } from './store.js';

const STALE_MS = 5 * MINUTE_MS;
const WATCHDOG_INTERVAL_MS = 30_000;
/** Before NTP sync a Pi (no RTC) can boot with a clock in the past; don't record then. */
const MIN_VALID_TS = Date.UTC(2024, 0, 1);

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}

const log = createLogger(config.logLevel);
log.info(`pihumtemp ${version} starting (${config.simulate ? 'SIMULATE' : 'BLE'} mode, db ${config.dbPath})`);

const store = new Store(config.dbPath);
const stats = store.stats();
log.info(`Database has ${stats.readings} minute rows`);

if (config.simulate && stats.readings === 0 && config.simulateBackfillDays > 0) {
  store.upsertMany(simulatedHistory(config.simulateBackfillDays));
  log.info(`Seeded ${store.stats().readings} simulated minute rows (${config.simulateBackfillDays} days, with a gap)`);
}

const live: LiveState = { latest: null, lastAdvertisement: null };

const aggregator = new MinuteAggregator((row) => {
  try {
    store.upsertMinute(row);
    log.debug(
      `Stored ${new Date(row.ts).toISOString()}: ${row.tempC.toFixed(2)}°C ${row.humidity.toFixed(1)}% ` +
        `(${row.samples} samples, battery ${row.battery}%, rssi ${row.rssi})`,
    );
  } catch (err) {
    log.error('Failed to store minute row:', err);
  }
});

const selector = new SensorSelector(
  { address: config.sensorAddress, name: config.sensorName },
  log,
  config.debug,
);

let clockWarned = false;
function onSample(sample: Sample): void {
  if (sample.ts < MIN_VALID_TS) {
    if (!clockWarned) log.warn('System clock looks unset (before 2024); ignoring readings until it is synced');
    clockWarned = true;
    return;
  }
  clockWarned = false;
  live.lastAdvertisement = sample.ts;
  live.latest = {
    ts: sample.ts,
    tempC: sample.tempC,
    humidity: sample.humidity,
    battery: sample.battery,
    rssi: sample.rssi,
  };
  aggregator.add(sample);
}

const source: AdvertisementSource = config.simulate ? new SimulatedSource(log) : new NobleSource(log);

// Close each minute shortly after it ends, even if no new sample arrives.
let minuteTimer: NodeJS.Timeout | undefined;
function scheduleMinuteFlush(): void {
  const now = Date.now();
  minuteTimer = setTimeout(() => {
    aggregator.flushBefore(Date.now());
    scheduleMinuteFlush();
  }, minuteStart(now) + MINUTE_MS + 1_000 - now);
}

// Warn (and kick the scanner) if the sensor goes quiet.
const startedAt = Date.now();
let lastStaleWarning = 0;
const watchdog = setInterval(() => {
  const now = Date.now();
  const since = now - (live.lastAdvertisement ?? startedAt);
  if (since < STALE_MS || now - lastStaleWarning < STALE_MS) return;
  lastStaleWarning = now;
  log.warn(
    `No advertisement from the sensor for ${Math.round(since / MINUTE_MS)} min` +
      (live.lastAdvertisement ? '' : ' (none since startup)') +
      '; restarting scan',
  );
  source.restart().catch((err) => log.error('Scan restart failed:', err));
}, WATCHDOG_INTERVAL_MS);

const server = createApiServer({ store, live, version, log });
server.on('error', (err) => {
  log.error('HTTP server error:', err);
  process.exit(1);
});
server.listen(config.port, config.host, () => log.info(`HTTP API listening on http://${config.host}:${config.port}`));

scheduleMinuteFlush();
source
  .start((adv) => {
    const sample = selector.handle(adv);
    if (sample) onSample(sample);
  })
  .catch((err) => {
    log.error('Failed to start advertisement source:', err);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  clearInterval(watchdog);
  clearTimeout(minuteTimer);
  await source.stop().catch(() => {});
  // The open minute is partial; the upsert merges it with the rest after restart.
  aggregator.flushAll();
  server.close();
  server.closeAllConnections();
  store.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  void shutdown('uncaughtException', 1);
});

/** Plausible minute rows for the last `days` days, with a 3 h gap two days ago. */
function* simulatedHistory(days: number): Generator<MinuteRow> {
  const end = minuteStart(Date.now());
  const gapStart = end - 2 * 86_400_000;
  const gapEnd = gapStart + 3 * 3_600_000;
  for (let ts = end - days * 86_400_000; ts < end; ts += MINUTE_MS) {
    if (ts >= gapStart && ts < gapEnd) continue;
    const { tempC, humidity } = simulatedClimate(ts, 0.5);
    yield { ts, tempC, humidity, battery: simulatedBattery(ts), rssi: -62, samples: 30 };
  }
}
