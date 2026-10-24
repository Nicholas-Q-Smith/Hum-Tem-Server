import { MINUTE_MS, MinuteAggregator } from './aggregator.js';
import type { Logger } from './logger.js';
import { canonicalAddress, type Match, type SensorSpec } from './sensors.js';
import type { Reading, SensorRecord, Store, StoreStats } from './store.js';

/** Before NTP sync a Pi (no RTC) can boot with a clock in the past; don't record then. */
export const MIN_VALID_TS = Date.UTC(2024, 0, 1);
export const STALE_MS = 5 * MINUTE_MS;
/** How often to repeat the "sensor silent" warning for one sensor. */
const STALE_REPEAT_MS = 30 * MINUTE_MS;

export interface TrackedSensor {
  /** API id: canonical MAC address. */
  id: string;
  record: SensorRecord;
  /** Being recorded now (configured, or auto-adopted). False for sensors that only have history. */
  recording: boolean;
  /** Position in SENSORS (config order), for stable display order. */
  order: number;
  latest: Reading | null;
  lastAdvertisement: number | null;
  aggregator: MinuteAggregator;
  lastStaleWarning: number;
}

export interface SensorSummary extends StoreStats {
  id: string;
  name: string | null;
  room: string | null;
  primary: boolean;
  recording: boolean;
  lastAdvertisement: number | null;
  latest: Reading | null;
}

/**
 * Owns the per-sensor state: database registration, minute aggregation, the
 * live latest reading. The first configured sensor is the "primary" one that
 * API calls without `sensor` refer to, which keeps the single-sensor API intact.
 */
export class Recorder {
  private readonly byId = new Map<string, TrackedSensor>();
  private readonly startedAt = Date.now();
  private clockWarned = false;

  constructor(
    private readonly store: Store,
    private readonly specs: readonly SensorSpec[],
    private readonly log: Logger,
  ) {
    // Every sensor with history is queryable, recorded or not.
    for (const record of store.sensors()) {
      if (record.address) this.track(record, specs.length === 0);
    }
    // Register configured addresses up front so they're listed (with rooms) before first contact.
    specs.forEach((spec, i) => {
      if (spec.address) this.ensure(spec.address, spec, i === 0);
    });
  }

  /** Addresses already in the database (auto mode keeps recording these). */
  knownIds(): string[] {
    return [...this.byId.keys()];
  }

  handle(match: Match): void {
    const { sample, spec, name } = match;
    if (sample.ts < MIN_VALID_TS) {
      if (!this.clockWarned) this.log.warn('System clock looks unset (before 2024); ignoring readings until it is synced');
      this.clockWarned = true;
      return;
    }
    this.clockWarned = false;

    const isPrimary = spec ? spec === this.specs[0] : this.byId.size === 0 || this.primary()?.id === sample.sensorId;
    const sensor = this.ensure(sample.sensorId, spec ?? {}, isPrimary, name, sample.ts);
    sensor.lastAdvertisement = sample.ts;
    sensor.latest = {
      ts: sample.ts,
      tempC: sample.tempC,
      humidity: sample.humidity,
      battery: sample.battery,
      rssi: sample.rssi,
    };
    sensor.aggregator.add(sample);
  }

  flushBefore(ts: number): void {
    for (const s of this.byId.values()) s.aggregator.flushBefore(ts);
  }

  flushAll(): void {
    for (const s of this.byId.values()) s.aggregator.flushAll();
  }

  /** The sensor API calls default to: first in SENSORS, else the oldest recorded one. */
  primary(): TrackedSensor | undefined {
    const first = this.specs[0];
    if (first) {
      if (first.address) return this.byId.get(first.address);
      const lower = first.name!.toLowerCase();
      return [...this.byId.values()].find((s) => s.record.name?.toLowerCase() === lower);
    }
    let best: TrackedSensor | undefined;
    for (const s of this.byId.values()) if (s.recording && (!best || s.record.id < best.record.id)) best = s;
    return best;
  }

  /** `sensor` query param → sensor; null/empty means the primary. */
  resolve(param: string | null): TrackedSensor | undefined {
    if (param === null || param.trim() === '') return this.primary();
    return this.byId.get(canonicalAddress(param) ?? param.trim().toLowerCase());
  }

  lastAdvertisement(): number | null {
    let last: number | null = null;
    for (const s of this.byId.values()) if (s.lastAdvertisement !== null && (last === null || s.lastAdvertisement > last)) last = s.lastAdvertisement;
    return last;
  }

  /** All sensors in display order: configured ones in SENSORS order, then the rest by first registration. */
  list(): TrackedSensor[] {
    return [...this.byId.values()].sort((a, b) => a.order - b.order || a.record.id - b.record.id);
  }

  summary(sensor: TrackedSensor, primaryId = this.primary()?.id): SensorSummary {
    return {
      id: sensor.id,
      name: sensor.record.name,
      room: sensor.record.room,
      primary: sensor.id === primaryId,
      recording: sensor.recording,
      lastAdvertisement: sensor.lastAdvertisement,
      latest: sensor.latest ?? this.store.newest(sensor.record.id),
      ...this.store.sensorStats(sensor.record.id),
    };
  }

  /**
   * Warns about recorded sensors that have gone quiet. Returns true when none
   * of them has been heard for STALE_MS, i.e. the scanner itself may be stuck.
   */
  checkStale(now = Date.now()): boolean {
    const recording = [...this.byId.values()].filter((s) => s.recording);
    let allStale = true;
    for (const s of recording) {
      const since = now - (s.lastAdvertisement ?? this.startedAt);
      if (since < STALE_MS) {
        allStale = false;
        continue;
      }
      if (now - s.lastStaleWarning >= STALE_REPEAT_MS) {
        s.lastStaleWarning = now;
        this.log.warn(
          `No advertisement from ${describe(s)} for ${Math.round(since / MINUTE_MS)} min` +
            (s.lastAdvertisement ? '' : ' (none since startup)'),
        );
      }
    }
    return allStale && now - this.startedAt >= STALE_MS;
  }

  private ensure(id: string, spec: SensorSpec, claimLegacy: boolean, name?: string, seenAt?: number): TrackedSensor {
    const existing = this.byId.get(id);
    const wantRoom = spec.room;
    if (existing) {
      existing.recording = true;
      if (this.specs.includes(spec)) existing.order = this.specs.indexOf(spec);
      if ((name && name !== existing.record.name) || (wantRoom && wantRoom !== existing.record.room)) {
        existing.record = this.store.registerSensor(id, { name, room: wantRoom });
      }
      return existing;
    }
    const record = this.store.registerSensor(id, { name, room: wantRoom, claimLegacy, seenAt });
    const tracked = this.track(record, true);
    if (this.specs.includes(spec)) tracked.order = this.specs.indexOf(spec);
    this.log.info(`Registered ${describe(tracked)}${claimLegacy ? ' as the primary sensor' : ''}`);
    return tracked;
  }

  private track(record: SensorRecord, recording: boolean): TrackedSensor {
    const tracked: TrackedSensor = {
      id: record.address!,
      record,
      recording,
      order: Number.MAX_SAFE_INTEGER,
      latest: null,
      lastAdvertisement: null,
      lastStaleWarning: 0,
      aggregator: new MinuteAggregator((row, samples) => {
        try {
          this.store.writeMinute(tracked.record.id, row, samples);
          this.log.debug(
            `Stored ${describe(tracked)} ${new Date(row.ts).toISOString()}: ${row.tempC.toFixed(2)}°C ` +
              `${row.humidity.toFixed(1)}% (${row.samples} samples, battery ${row.battery}%, rssi ${row.rssi})`,
          );
        } catch (err) {
          this.log.error(`Failed to store minute row for ${describe(tracked)}:`, err);
        }
      }),
    };
    this.byId.set(tracked.id, tracked);
    return tracked;
  }
}

function describe(s: TrackedSensor): string {
  const label = s.record.room ?? s.record.name;
  return label ? `${label} (${s.id})` : s.id;
}
