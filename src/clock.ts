/**
 * Wall-clock step detection. A Pi has no real-time clock: Raspberry Pi OS's
 * fake-hwclock boots with the last saved time (plausible, so a "before 2024"
 * check doesn't catch it), then NTP steps it forward. Comparing the wall clock
 * against the monotonic clock catches steps of any size.
 */
export const STEP_TOLERANCE_MS = 5_000;

export const monotonicNow = (): number => performance.now();

export class ClockWatch {
  private wall: number;
  private mono: number;

  constructor(wallNow = Date.now(), monoNow = monotonicNow()) {
    this.wall = wallNow;
    this.mono = monoNow;
  }

  /**
   * How far the wall clock was stepped since the last call (positive =
   * forward), or 0 if it kept pace with the monotonic clock.
   */
  check(wallNow = Date.now(), monoNow = monotonicNow()): number {
    const step = wallNow - this.wall - (monoNow - this.mono);
    this.wall = wallNow;
    this.mono = monoNow;
    return Math.abs(step) > STEP_TOLERANCE_MS ? step : 0;
  }
}
