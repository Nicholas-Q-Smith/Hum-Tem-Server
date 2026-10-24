import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MINUTE_MS, minuteStart, type MinuteRow } from './aggregator.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Recorder } from './recorder.js';
import { SensorSelector } from './sensors.js';
import { createApiServer } from './server.js';
import { NobleSource } from './sources/noble.js';
import {
  type SimulatedDevice,
  SimulatedSource,
  simulatedBattery,
  simulatedClimate,
  simulatedDevices,
} from './sources/simulate.js';
import type { AdvertisementSource } from './sources/types.js';
import { Store } from './store.js';
import { HEARTBEAT_MS, Uptime } from './uptime.js';

const WATCHDOG_INTERVAL_MS = 30_000;

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

let store: Store;
try {
  store = new Store(config.dbPath);
} catch (err) {
  const uid = process.getuid?.();
  log.error(
    `Cannot open database ${config.dbPath}: ${String(err)}. ` +
      `Make sure its directory exists and is writable by uid ${uid}` +
      ` (e.g. sudo install -d -o ${uid} -g ${uid} ${dirname(config.dbPath)}).`,
  );
  process.exit(1);
}
const stats = store.stats();
log.info(`Database has ${stats.readings} minute rows and ${stats.samples} raw samples`);

const recorder = new Recorder(store, config.sensors, log);

// Record when the server is up, so clients can tell "server down" from "sensor not heard".
const uptime = new Uptime(store, log);
uptime.beat();
const heartbeat = setInterval(() => uptime.beat(), HEARTBEAT_MS);

// Simulate mode: on a fresh database, register the fake sensors with their rooms
// the same way the app would, so they stay editable from the app.
const simDevices = config.simulate ? simulatedDevices(config.simulateSensors) : [];
if (recorder.managedBy === 'api' && recorder.list().length === 0) {
  for (const d of simDevices) recorder.add(d.address, d.room);
}
const selector = new SensorSelector(recorder.matcher, log, config.debug);

if (config.simulate && config.simulateBackfillDays > 0) {
  simDevices.forEach((device, i) => {
    const sensor = recorder.resolve(device.address);
    if (!sensor || store.sensorStats(sensor.record.id).readings > 0) return;
    store.upsertMany(sensor.record.id, simulatedHistory(device, config.simulateBackfillDays, 2 + i));
    log.info(`Seeded ${config.simulateBackfillDays} days of simulated history for ${device.room}`);
  });
}

const source: AdvertisementSource = config.simulate ? new SimulatedSource(simDevices, log) : new NobleSource(log);

// Close each minute shortly after it ends, even if no new sample arrives.
let minuteTimer: NodeJS.Timeout | undefined;
function scheduleMinuteFlush(): void {
  const now = Date.now();
  minuteTimer = setTimeout(() => {
    recorder.flushBefore(Date.now());
    scheduleMinuteFlush();
  }, minuteStart(now) + MINUTE_MS + 1_000 - now);
}

// Warn about silent sensors; kick the scanner if none is heard at all.
let lastScanRestart = 0;
const watchdog = setInterval(() => {
  const now = Date.now();
  if (!recorder.checkStale(now) || now - lastScanRestart < 5 * MINUTE_MS) return;
  lastScanRestart = now;
  log.warn('No advertisements from any recorded sensor for 5+ min; restarting scan');
  source.restart().catch((err) => log.error('Scan restart failed:', err));
}, WATCHDOG_INTERVAL_MS);

// Raw-sample retention (minute rows are kept forever).
const PRUNE_INTERVAL_MS = 3_600_000;
let pruneTimer: NodeJS.Timeout | undefined;
if (config.rawRetentionDays > 0) {
  const prune = () => {
    try {
      const n = store.pruneSamples(Date.now() - config.rawRetentionDays * 86_400_000);
      if (n > 0) log.info(`Pruned ${n} raw samples older than ${config.rawRetentionDays} days`);
    } catch (err) {
      log.error('Pruning raw samples failed:', err);
    }
  };
  prune();
  pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  log.info(`Keeping raw samples for ${config.rawRetentionDays} days`);
} else {
  log.info('Keeping raw samples forever (RAW_RETENTION_DAYS=0)');
}

const server = createApiServer({ store, recorder, nearby: () => selector.nearby(), uptime, version, log });
server.on('error', (err) => {
  log.error('HTTP server error:', err);
  process.exit(1);
});
server.listen(config.port, config.host, () => log.info(`HTTP API listening on http://${config.host}:${config.port}`));

scheduleMinuteFlush();
source
  .start((adv) => {
    const match = selector.handle(adv);
    if (match) recorder.handle(match);
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
  clearInterval(heartbeat);
  clearInterval(pruneTimer);
  clearTimeout(minuteTimer);
  await source.stop().catch(() => {});
  // The open minute is partial; the upsert merges it with the rest after restart.
  recorder.flushAll();
  uptime.beat();
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

/** Plausible minute rows for the last `days` days, with a 3 h gap `gapDaysAgo` days ago. */
function* simulatedHistory(device: SimulatedDevice, days: number, gapDaysAgo: number): Generator<MinuteRow> {
  const end = minuteStart(Date.now());
  const gapStart = end - gapDaysAgo * 86_400_000;
  const gapEnd = gapStart + 3 * 3_600_000;
  for (let ts = end - days * 86_400_000; ts < end; ts += MINUTE_MS) {
    if (ts >= gapStart && ts < gapEnd) continue;
    const { tempC, humidity } = simulatedClimate(ts, 0.5, device);
    yield { ts, tempC, humidity, battery: simulatedBattery(ts), rssi: device.rssi, samples: 30 };
  }
}
