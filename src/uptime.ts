import type { Logger } from './logger.js';
import { MIN_VALID_TS } from './recorder.js';
import type { Store } from './store.js';

/** How often the current run's last-seen time is written; also the accuracy of "server down" periods. */
export const HEARTBEAT_MS = 60_000;
/** A heartbeat this late (or a clock going backwards) means the process stalled or the clock jumped. */
const JUMP_MS = 3 * HEARTBEAT_MS;

export interface UptimeRun {
  start: number;
  end: number;
}

export interface UptimeResponse {
  heartbeatMs: number;
  /** Uptime is unknown before this (the database predates uptime tracking); null if nothing recorded yet. */
  since: number | null;
  runs: UptimeRun[];
}

/**
 * Records when the server is running, as runs of [started, lastSeen] kept fresh by a
 * heartbeat. Gaps between runs are periods the server was down.
 */
export class Uptime {
  private run: { started: number; lastSeen: number } | null = null;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
  ) {}

  /** Call at startup, every HEARTBEAT_MS, and at shutdown. */
  beat(now = Date.now()): void {
    // A Pi without a real-time clock can boot with a bogus time; wait until it's synced.
    if (now < MIN_VALID_TS) return;
    if (this.run && (now - this.run.lastSeen > JUMP_MS || now < this.run.lastSeen)) {
      this.log.info('Clock jumped or the process stalled; starting a new uptime run');
      this.run = null;
    }
    if (!this.run) {
      this.run = { started: now, lastSeen: now };
      this.store.startRun(now);
      return;
    }
    this.run.lastSeen = now;
    this.store.heartbeat(this.run.started, now);
  }

  /** Runs overlapping [from, to]. The current run extends to `now`: we're answering, so we're up. */
  query(from: number, to: number, now = Date.now()): UptimeResponse {
    const runs = this.store.runs(from, to).map((r) => ({
      start: r.started,
      end: this.run && r.started === this.run.started ? Math.max(r.lastSeen, now) : r.lastSeen,
    }));
    return { heartbeatMs: HEARTBEAT_MS, since: this.store.firstRun(), runs };
  }
}
