import { monotonicNow, STEP_TOLERANCE_MS } from './clock.js';
import type { Logger } from './logger.js';
import { MIN_VALID_TS } from './recorder.js';
import type { Store } from './store.js';

/** How often the current run's last-seen time is written; also the accuracy of "server down" periods. */
export const HEARTBEAT_MS = 60_000;
/** A heartbeat this late on the monotonic clock means the process was stalled (frozen), not just a clock step. */
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
 *
 * Times are checked against the monotonic clock. When the wall clock is stepped
 * (e.g. NTP correcting a Pi's fake-hwclock time after boot), the current run is
 * re-anchored on the corrected clock instead of being split, so it neither leaves a
 * stray run at the stale time nor hides the outage before it. A real stall (the
 * monotonic clock also jumped: the process was frozen) still ends the run.
 */
export class Uptime {
  private run: { started: number; lastSeen: number; startedMono: number; lastMono: number } | null = null;
  private readonly processStartMono: number;

  constructor(
    private readonly store: Store,
    private readonly log: Logger,
    monoNow = monotonicNow(),
  ) {
    this.processStartMono = monoNow;
  }

  /** Call at startup, every HEARTBEAT_MS, and at shutdown. */
  beat(now = Date.now(), mono = monotonicNow()): void {
    // A clock before 2024 is certainly unset; wait until it's synced.
    if (now < MIN_VALID_TS) return;
    const run = this.run;
    if (run) {
      const monoDelta = mono - run.lastMono;
      const step = now - run.lastSeen - monoDelta;
      if (monoDelta > JUMP_MS) {
        this.log.info(`No heartbeat for ${Math.round(monoDelta / 1000)}s (process stalled); starting a new uptime run`);
        this.run = null;
      } else if (Math.abs(step) > STEP_TOLERANCE_MS) {
        const started = Math.round(now - (mono - run.startedMono));
        this.log.info(`Clock stepped by ${Math.round(step / 1000)}s; re-anchoring the current uptime run`);
        this.store.moveRun(run.started, started, now);
        this.run = { started, lastSeen: now, startedMono: run.startedMono, lastMono: mono };
        return;
      }
    }
    if (!this.run) {
      // The first run started with the process, even if the clock only became valid now.
      const startedMono = run ? mono : this.processStartMono;
      const started = Math.round(now - (mono - startedMono));
      this.run = { started, lastSeen: now, startedMono, lastMono: mono };
      this.store.startRun(started);
      if (now !== started) this.store.heartbeat(started, now);
      return;
    }
    this.run.lastSeen = now;
    this.run.lastMono = mono;
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
