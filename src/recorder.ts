import { MINUTE_MS, MinuteAggregator } from './aggregator.js';
import { H5075_NAME_PREFIX } from './govee/h5075.js';
import type { Logger } from './logger.js';
import { canonicalAddress, type Decision, type Match, type SensorSpec } from './sensors.js';
import type { Reading, SensorRecord, Store, StoreStats } from './store.js';

/** Before NTP sync a Pi (no RTC) can boot with a clock in the past; don't record then. */
export const MIN_VALID_TS = Date.UTC(2024, 0, 1);
export const STALE_MS = 5 * MINUTE_MS;
/** How often to repeat the "sensor silent" warning for one sensor. */
const STALE_REPEAT_MS = 30 * MINUTE_MS;
export const MAX_ROOM_LENGTH = 64;

/**
 * Who decides which sensors are recorded:
 * - `api`: the database, edited through the HTTP API (i.e. from the app). Default.
 * - `config`: the SENSORS setting; the API is read-only for sensor settings.
 */
export type ManagedBy = 'api' | 'config';

export interface TrackedSensor {
  /** API id: canonical MAC address. */
  id: string;
  record: SensorRecord;
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
  position: number;
  lastAdvertisement: number | null;
  latest: Reading | null;
}

export interface SensorPatch {
  /** null or "" clears it. */
  room?: string | null;
  recording?: boolean;
  /** Move to the front of the display order, making it the primary. */
  primary?: true;
  /** Move to this index in the display order (0 = first). */
  position?: number;
}

/** A rejected sensor change, with the HTTP status to answer it with. */
export class SensorAdminError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns the per-sensor state: which sensors are recorded, their rooms and
 * order, minute aggregation, and the live latest reading. The first recording
 * sensor in display order is the "primary" one that API calls without
 * `sensor` refer to, which keeps the single-sensor API intact.
 */
export class Recorder {
  readonly managedBy: ManagedBy;
  private readonly byId = new Map<string, TrackedSensor>();
  private readonly startedAt = Date.now();
  private clockWarned = false;

  constructor(
    private readonly store: Store,
    private readonly specs: readonly SensorSpec[],
    private readonly log: Logger,
  ) {
    this.managedBy = specs.length ? 'config' : 'api';
    // Every sensor with history is queryable, recorded or not.
    for (const record of store.sensors()) if (record.address) this.track(record);
    if (this.managedBy === 'config') this.applySpecs();

    const recording = this.list().filter((s) => s.record.recording);
    if (recording.length) {
      log.info(`Recording ${recording.length} sensor(s): ${recording.map(describe).join(', ')}`);
    } else if (this.managedBy === 'api') {
      log.info(`No sensors yet; will record the first ${H5075_NAME_PREFIX}_* heard. Add more from the app.`);
    }
    if (this.managedBy === 'config') log.info('Sensors are managed by SENSORS; the API cannot change them');
  }

  /** Decides per packet whether a device is recorded (see SensorSelector). */
  readonly matcher = (key: string, name: string | undefined): Decision => {
    if (this.managedBy === 'config') {
      const spec = this.specFor(key, name);
      if (spec) return { record: true, spec };
      return this.byId.has(key) ? 'ignore' : undefined;
    }
    const tracked = this.byId.get(key);
    if (tracked) return tracked.record.recording ? { record: true } : 'ignore';
    // Zero-config start: adopt the first H5075 heard.
    if (this.byId.size === 0 && name?.startsWith(`${H5075_NAME_PREFIX}_`)) return { record: true };
    return undefined;
  };

  handle(match: Match): void {
    const { sample, spec, name } = match;
    if (sample.ts < MIN_VALID_TS) {
      if (!this.clockWarned) this.log.warn('System clock looks unset (before 2024); ignoring readings until it is synced');
      this.clockWarned = true;
      return;
    }
    this.clockWarned = false;

    let sensor = this.byId.get(sample.sensorId);
    if (!sensor) {
      const index = spec ? this.specs.indexOf(spec) : -1;
      const record = this.store.registerSensor(sample.sensorId, {
        name,
        room: spec?.room,
        recording: true,
        position: index >= 0 ? index : undefined,
        claimLegacy: index === 0 || (index === -1 && this.byId.size === 0),
        seenAt: sample.ts,
      });
      sensor = this.track(record);
      this.log.info(`Recording new sensor ${describe(sensor)}`);
    } else if (name && name !== sensor.record.name) {
      sensor.record = this.store.updateSensor(sensor.record.id, { name });
    }
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

  /** The sensor API calls default to: the first recording sensor in display order. */
  primary(): TrackedSensor | undefined {
    const all = this.list();
    return all.find((s) => s.record.recording) ?? all[0];
  }

  /** `sensor` query param → sensor; null/empty means the primary. */
  resolve(param: string | null): TrackedSensor | undefined {
    if (param === null || param.trim() === '') return this.primary();
    return this.byId.get(canonicalAddress(param) ?? param.trim().toLowerCase());
  }

  lastAdvertisement(): number | null {
    let last: number | null = null;
    for (const s of this.byId.values()) {
      if (s.lastAdvertisement !== null && (last === null || s.lastAdvertisement > last)) last = s.lastAdvertisement;
    }
    return last;
  }

  /** All sensors in display order. */
  list(): TrackedSensor[] {
    return [...this.byId.values()].sort((a, b) => a.record.position - b.record.position || a.record.id - b.record.id);
  }

  summary(sensor: TrackedSensor, primaryId = this.primary()?.id): SensorSummary {
    return {
      id: sensor.id,
      name: sensor.record.name,
      room: sensor.record.room,
      primary: sensor.id === primaryId,
      recording: sensor.record.recording,
      position: this.list().indexOf(sensor),
      lastAdvertisement: sensor.lastAdvertisement,
      latest: sensor.latest ?? this.store.newest(sensor.record.id),
      ...this.store.sensorStats(sensor.record.id),
    };
  }

  // --- runtime management (managedBy === 'api') ------------------------------

  /** Starts recording a sensor (typically one from `nearby`). Returns it and whether it was new. */
  add(idParam: unknown, room?: unknown): { sensor: TrackedSensor; created: boolean } {
    this.assertManageable();
    const id = typeof idParam === 'string' ? canonicalAddress(idParam) : undefined;
    if (!id) throw new SensorAdminError(400, 'id must be a MAC address, e.g. a4:c1:38:12:34:56');
    const cleanRoom = room === undefined ? undefined : validRoom(room);
    const existing = this.byId.get(id);
    if (existing) {
      existing.record = this.store.updateSensor(existing.record.id, { recording: true, room: cleanRoom });
      return { sensor: existing, created: false };
    }
    const record = this.store.registerSensor(id, {
      room: cleanRoom ?? undefined,
      recording: true,
      claimLegacy: this.byId.size === 0,
    });
    const sensor = this.track(record);
    this.log.info(`Added sensor ${describe(sensor)} via API`);
    return { sensor, created: true };
  }

  update(idParam: string, patch: unknown): TrackedSensor {
    this.assertManageable();
    const sensor = this.resolve(idParam);
    if (!sensor) throw new SensorAdminError(404, `unknown sensor: ${idParam}`);
    const p = validPatch(patch);

    if (p.room !== undefined || p.recording !== undefined) {
      if (p.recording === false) sensor.aggregator.flushAll(); // keep the partial minute
      sensor.record = this.store.updateSensor(sensor.record.id, { room: p.room, recording: p.recording });
    }
    const target = p.primary ? 0 : p.position;
    if (target !== undefined) {
      const order = this.list().filter((s) => s !== sensor);
      order.splice(Math.min(target, order.length), 0, sensor);
      this.store.reorderSensors(order.map((s) => s.record.id));
      for (const s of order) s.record = this.store.sensor(s.record.id)!;
    }
    const changes = Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    this.log.info(`Updated sensor ${describe(sensor)} via API: ${changes}`);
    return sensor;
  }

  /**
   * Warns about recorded sensors that have gone quiet. Returns true when none
   * of them has been heard for STALE_MS, i.e. the scanner itself may be stuck.
   */
  checkStale(now = Date.now()): boolean {
    const recording = [...this.byId.values()].filter((s) => s.record.recording);
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

  private assertManageable(): void {
    if (this.managedBy === 'config') {
      throw new SensorAdminError(409, 'sensors are set by SENSORS in the server config; unset it to manage them from the app');
    }
  }

  private specFor(key: string, name: string | undefined): SensorSpec | undefined {
    const lower = name?.toLowerCase();
    return this.specs.find((s) => (s.address ? s.address === key : lower !== undefined && s.name!.toLowerCase() === lower));
  }

  /** Config mode: make the database match SENSORS (listed sensors record, in order; the rest don't). */
  private applySpecs(): void {
    this.specs.forEach((spec, i) => {
      const existing = spec.address
        ? this.byId.get(spec.address)
        : this.list().find((s) => s.record.name?.toLowerCase() === spec.name!.toLowerCase());
      if (existing) {
        existing.record = this.store.updateSensor(existing.record.id, { room: spec.room, recording: true, position: i });
      } else if (spec.address) {
        // Registered up front so it's listed (with its room) before first contact.
        this.track(
          this.store.registerSensor(spec.address, { room: spec.room, recording: true, position: i, claimLegacy: i === 0 }),
        );
      }
    });
    for (const s of this.byId.values()) {
      const listed = this.specFor(s.id, s.record.name ?? undefined);
      if (!listed && s.record.recording) {
        s.record = this.store.updateSensor(s.record.id, { recording: false, position: this.specs.length + s.record.position });
      }
    }
  }

  private track(record: SensorRecord): TrackedSensor {
    const tracked: TrackedSensor = {
      id: record.address!,
      record,
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

function validRoom(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new SensorAdminError(400, 'room must be a string or null');
  const room = value.trim();
  if (room.length > MAX_ROOM_LENGTH) throw new SensorAdminError(400, `room must be at most ${MAX_ROOM_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(room)) throw new SensorAdminError(400, 'room must not contain control characters');
  return room === '' ? null : room;
}

function validPatch(input: unknown): SensorPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SensorAdminError(400, 'body must be a JSON object');
  const body = input as Record<string, unknown>;
  const known = ['room', 'recording', 'primary', 'position'];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length) throw new SensorAdminError(400, `unknown field(s): ${unknown.join(', ')}`);
  const patch: SensorPatch = {};
  if ('room' in body) patch.room = validRoom(body.room);
  if ('recording' in body) {
    if (typeof body.recording !== 'boolean') throw new SensorAdminError(400, 'recording must be true or false');
    patch.recording = body.recording;
  }
  if ('primary' in body) {
    if (body.primary !== true) throw new SensorAdminError(400, 'primary can only be set to true');
    patch.primary = true;
  }
  if ('position' in body) {
    if (!Number.isInteger(body.position) || (body.position as number) < 0) {
      throw new SensorAdminError(400, 'position must be a non-negative integer');
    }
    patch.position = body.position as number;
  }
  if (patch.primary && patch.position !== undefined) throw new SensorAdminError(400, 'set primary or position, not both');
  if (Object.keys(patch).length === 0) throw new SensorAdminError(400, 'nothing to change');
  return patch;
}
