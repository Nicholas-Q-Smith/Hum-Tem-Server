import { isLogLevel, type LogLevel } from './logger.js';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  sensorAddress?: string;
  sensorName?: string;
  logLevel: LogLevel;
  /** Log raw manufacturer-data bytes of every Govee advertisement. */
  debug: boolean;
  /** Generate fake advertisements instead of using Bluetooth. */
  simulate: boolean;
  /** In simulate mode, days of fake history to seed into an empty database. */
  simulateBackfillDays: number;
}

export const DEFAULT_DB_PATH = '/var/lib/pihumtemp/pihumtemp.db';
export const DEFAULT_SIMULATE_DB_PATH = './data/simulate.db';

const USAGE = `Usage: pihumtemp [--simulate] [--debug]

  --simulate   generate fake H5075 advertisements instead of using Bluetooth (also SIMULATE=1)
  --debug      log raw manufacturer data of Govee advertisements (implies LOG_LEVEL=debug)

Environment: PORT, DB_PATH, SENSOR_ADDRESS, SENSOR_NAME, LOG_LEVEL, SIMULATE, SIMULATE_BACKFILL_DAYS`;

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

  return {
    host: '0.0.0.0',
    port,
    dbPath: nonEmpty(env.DB_PATH) ?? (simulate ? DEFAULT_SIMULATE_DB_PATH : DEFAULT_DB_PATH),
    sensorAddress: nonEmpty(env.SENSOR_ADDRESS),
    sensorName: nonEmpty(env.SENSOR_NAME),
    logLevel: debug ? 'debug' : levelStr,
    debug,
    simulate,
    simulateBackfillDays,
  };
}
