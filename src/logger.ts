export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  isDebug(): boolean;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Minimal leveled logger. Under systemd, journald adds its own timestamps, so we
 * omit them when stdout is not a TTY to keep `journalctl` output tidy.
 */
export function createLogger(level: LogLevel, withTimestamps = Boolean(process.stdout.isTTY)): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const write = (lvl: LogLevel, msg: string, args: unknown[]) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const prefix = `${withTimestamps ? new Date().toISOString() + ' ' : ''}${lvl.toUpperCase().padEnd(5)}`;
    const out = lvl === 'warn' || lvl === 'error' ? console.error : console.log;
    out(prefix, msg, ...args);
  };
  return {
    debug: (msg, ...args) => write('debug', msg, args),
    info: (msg, ...args) => write('info', msg, args),
    warn: (msg, ...args) => write('warn', msg, args),
    error: (msg, ...args) => write('error', msg, args),
    isDebug: () => threshold === 0,
  };
}
