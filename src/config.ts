import { isLogLevel, type LogLevel } from './logger.js';
import { canonicalAddress, parseSensorsSpec, type SensorSpec } from './sensors.js';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Sensors to record, first = primary (the default for API calls without `sensor`). Empty = auto. */
  sensors: SensorSpec[];
  logLevel: LogLevel;
  /** Log raw manufacturer-data bytes of every Govee advertisement. */
  debug: boolean;
  /** Generate fake advertisements instead of using Bluetooth. */
  simulate: boolean;
  /** In simulate mode, days of fake history to seed into an empty database. */
  simulateBackfillDays: number;
  /** In simulate mode, how many fake sensors (rooms) to generate. */
  simulateSensors: number;
  /** Delete raw samples older than this many days; 0 keeps them forever. Minute rows are always kept. */
  rawRetentionDays: number;
}

export const DEFAULT_DB_PATH = '/var/lib/pihumtemp/pihumtemp.db';
export const DEFAULT_SIMULATE_DB_PATH = './data/simulate.db';

const USAGE = `Usage: pihumtemp [--simulate] [--debug]

  --simulate   generate fake H5075 advertisements instead of using Bluetooth (also SIMULATE=1)
  --debug      log raw manufacturer data of Govee advertisements (implies LOG_LEVEL=debug)

Environment: PORT, DB_PATH, SENSORS, SENSOR_ADDRESS, SENSOR_NAME, LOG_LEVEL, RAW_RETENTION_DAYS,
             SIMULATE, SIMULATE_SENSORS, SIMULATE_BACKFILL_DAYS`;

export class ConfigError extends Error {}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  let simulate = truthy(env.SIMULATE);
  let debug = false;
  for (const arg of argv) {
    if (arg === '--simulate') simulate = true;
    else if (arg === '--debug') debug = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new ConfigError(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  const portStr = nonEmpty(env.PORT) ?? '8080';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`Invalid PORT: ${portStr}`);

  const levelStr = (nonEmpty(env.LOG_LEVEL) ?? 'info').toLowerCase();
  if (!isLogLevel(levelStr)) throw new ConfigError(`Invalid LOG_LEVEL: ${levelStr} (use debug, info, warn or error)`);

  const backfillStr = nonEmpty(env.SIMULATE_BACKFILL_DAYS) ?? '30';
  const simulateBackfillDays = Number(backfillStr);
  if (!Number.isInteger(simulateBackfillDays) || simulateBackfillDays < 0) {
    throw new ConfigError(`Invalid SIMULATE_BACKFILL_DAYS: ${backfillStr}`);
  }

  const retentionStr = nonEmpty(env.RAW_RETENTION_DAYS) ?? '0';
  const rawRetentionDays = Number(retentionStr);
  if (!Number.isFinite(rawRetentionDays) || rawRetentionDays < 0) {
    throw new ConfigError(`Invalid RAW_RETENTION_DAYS: ${retentionStr}`);
  }

  const simSensorsStr = nonEmpty(env.SIMULATE_SENSORS) ?? '3';
  const simulateSensors = Number(simSensorsStr);
  if (!Number.isInteger(simulateSensors) || simulateSensors < 1 || simulateSensors > 9) {
    throw new ConfigError(`Invalid SIMULATE_SENSORS: ${simSensorsStr} (1-9)`);
  }

  return {
    host: '0.0.0.0',
    port,
    dbPath: nonEmpty(env.DB_PATH) ?? (simulate ? DEFAULT_SIMULATE_DB_PATH : DEFAULT_DB_PATH),
    sensors: sensorsFromEnv(env),
    logLevel: debug ? 'debug' : levelStr,
    debug,
    simulate,
    simulateBackfillDays,
    simulateSensors,
    rawRetentionDays,
  };
}

/** SENSORS, or the single-sensor SENSOR_ADDRESS / SENSOR_NAME it supersedes. */
function sensorsFromEnv(env: NodeJS.ProcessEnv): SensorSpec[] {
  const list = nonEmpty(env.SENSORS);
  const address = nonEmpty(env.SENSOR_ADDRESS);
  const name = nonEmpty(env.SENSOR_NAME);
  if (list) {
    if (address || name) throw new ConfigError('Set either SENSORS or SENSOR_ADDRESS/SENSOR_NAME, not both');
    try {
      return parseSensorsSpec(list);
    } catch (err) {
      throw new ConfigError(`Invalid SENSORS: ${(err as Error).message}`);
    }
  }
  if (address && name) throw new ConfigError('Set SENSOR_ADDRESS or SENSOR_NAME, not both');
  if (address) {
    const canonical = canonicalAddress(address);
    if (!canonical) throw new ConfigError(`Invalid SENSOR_ADDRESS: ${address}`);
    return [{ address: canonical }];
  }
  return name ? [{ name }] : [];
}
