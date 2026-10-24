import { decodeH5075, H5075_NAME_PREFIX, isGoveeManufacturerData, type H5075Reading } from './govee/h5075.js';
import type { Logger } from './logger.js';
import type { Advertisement } from './sources/types.js';

/** A decoded reading from one sensor advertisement. */
export interface Sample {
  /** Device key: canonical MAC address (or noble's id where no MAC is exposed, e.g. macOS). */
  sensorId: string;
  ts: number;
  tempC: number;
  humidity: number;
  battery: number;
  rssi: number;
}

/** One configured sensor (from SENSORS, or the legacy SENSOR_ADDRESS / SENSOR_NAME). */
export interface SensorSpec {
  /** Canonical MAC address. */
  address?: string;
  /** BLE local name, e.g. GVH5075_3456 (used when the address isn't known). */
  name?: string;
  room?: string;
}

/** A Govee H5075 that was heard but isn't being recorded. */
export interface NearbyDevice {
  id: string;
  name?: string;
  rssi: number;
  lastSeen: number;
  reading: H5075Reading | null;
}

export interface Match {
  sample: Sample;
  spec?: SensorSpec;
  name?: string;
}

/**
 * noble reports a device again when its scan response arrives, carrying the
 * same manufacturer data as the advertisement a few ms earlier. Identical
 * values this close together are that echo, not a new reading.
 */
export const ECHO_WINDOW_MS = 500;
/** Forget nearby devices not heard for this long. */
const NEARBY_TTL_MS = 10 * 60_000;

const MAC_RE = /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

/** `A4-C1-38-12-34-56`, `a4c138123456`, ... → `a4:c1:38:12:34:56`; undefined if not a MAC. */
export function canonicalAddress(value: string): string | undefined {
  const m = MAC_RE.exec(value.trim());
  return m ? m.slice(1).join(':').toLowerCase() : undefined;
}

/** The key a device is stored under. */
export function deviceKey(adv: Pick<Advertisement, 'address' | 'id'>): string {
  return canonicalAddress(adv.address) ?? canonicalAddress(adv.id) ?? adv.id.toLowerCase();
}

/**
 * Parses SENSORS: entries separated by `;`, `,` or newlines, each
 * `<mac-or-name>[=<room>]`, e.g.
 *   A4:C1:38:12:34:56=Living room; GVH5075_ABCD=Bedroom
 */
export function parseSensorsSpec(spec: string): SensorSpec[] {
  const out: SensorSpec[] = [];
  for (const raw of spec.split(/[;,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const target = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const room = eq === -1 ? undefined : entry.slice(eq + 1).trim() || undefined;
    if (!target) throw new Error(`Empty sensor in SENSORS entry "${entry}"`);
    const address = canonicalAddress(target);
    out.push(address ? { address, room } : { name: target, room });
  }
  const seen = new Set<string>();
  for (const s of out) {
    const k = s.address ?? `name:${s.name!.toLowerCase()}`;
    if (seen.has(k)) throw new Error(`Sensor listed twice in SENSORS: ${s.address ?? s.name}`);
    seen.add(k);
  }
  return out;
}

/**
 * Picks the sensors to record out of the advertisement stream and decodes them.
 *
 * - With specs: records exactly those (matched by address, or by local name).
 * - Without specs ("auto"): records the sensors in `known` (already in the
 *   database); if there are none, adopts the first GVH5075_* heard.
 *
 * The H5075 often sends its name (scan response) and its data (advertisement)
 * in separate packets, so names are remembered per device.
 */
export class SensorSelector {
  private readonly names = new Map<string, string>();
  private readonly last = new Map<string, Sample>();
  private readonly nearbyDevices = new Map<string, NearbyDevice>();
  private readonly known: Set<string>;

  constructor(
    private readonly specs: readonly SensorSpec[],
    known: Iterable<string>,
    private readonly log: Logger,
    private readonly debugRaw = false,
  ) {
    this.known = new Set(known);
    if (specs.length) {
      log.info(`Recording ${specs.length} sensor(s): ${specs.map(describeSpec).join(', ')}`);
    } else if (this.known.size) {
      log.info(`No SENSORS configured; recording the sensor(s) already in the database: ${[...this.known].join(', ')}`);
    } else {
      log.info(`No SENSORS configured; will record the first ${H5075_NAME_PREFIX}_* heard`);
    }
  }

  handle(adv: Advertisement): Match | null {
    const key = deviceKey(adv);
    if (adv.localName) this.names.set(key, adv.localName);
    const name = adv.localName ?? this.names.get(key);

    const govee = isGoveeManufacturerData(adv.manufacturerData);
    if (this.debugRaw && (govee || name?.startsWith('GV'))) {
      this.log.debug(
        `adv ${key} name=${name ?? '?'} rssi=${adv.rssi} mfr=${adv.manufacturerData?.toString('hex') ?? '-'}` +
          ` decoded=${JSON.stringify(decodeH5075(adv.manufacturerData))}`,
      );
    }
    if (!govee) return null;

    const matched = this.match(key, name);
    if (!matched) {
      if (name?.startsWith(`${H5075_NAME_PREFIX}_`)) {
        this.nearbyDevices.set(key, {
          id: key,
          name,
          rssi: adv.rssi,
          lastSeen: adv.receivedAt,
          reading: decodeH5075(adv.manufacturerData),
        });
      }
      return null;
    }

    const reading = decodeH5075(adv.manufacturerData);
    if (!reading) {
      this.log.debug(`Undecodable H5075 data from ${key}: ${adv.manufacturerData?.toString('hex')}`);
      return null;
    }
    const sample: Sample = { sensorId: key, ts: adv.receivedAt, rssi: adv.rssi, ...reading };
    const prev = this.last.get(key);
    if (
      prev &&
      sample.ts - prev.ts >= 0 &&
      sample.ts - prev.ts < ECHO_WINDOW_MS &&
      prev.tempC === sample.tempC &&
      prev.humidity === sample.humidity &&
      prev.battery === sample.battery
    ) {
      return null;
    }
    this.last.set(key, sample);
    return { sample, spec: matched === true ? undefined : matched, name };
  }

  /** H5075s heard recently that aren't being recorded, strongest first (to help fill in SENSORS). */
  nearby(now = Date.now()): NearbyDevice[] {
    for (const [k, d] of this.nearbyDevices) if (now - d.lastSeen > NEARBY_TTL_MS) this.nearbyDevices.delete(k);
    return [...this.nearbyDevices.values()].sort((a, b) => b.rssi - a.rssi);
  }

  /** The spec it matches, `true` for an auto-mode sensor, or undefined. */
  private match(key: string, name: string | undefined): SensorSpec | true | undefined {
    if (this.specs.length) {
      const lower = name?.toLowerCase();
      return this.specs.find((s) => (s.address ? s.address === key : lower !== undefined && s.name!.toLowerCase() === lower));
    }
    if (this.known.has(key)) return true;
    if (this.known.size === 0 && name?.startsWith(`${H5075_NAME_PREFIX}_`)) {
      this.known.add(key);
      this.nearbyDevices.delete(key);
      this.log.info(`Recording sensor ${name} (${key}). Add it to SENSORS (e.g. SENSORS=${key}=Living room) to name its room.`);
      return true;
    }
    return undefined;
  }
}

function describeSpec(s: SensorSpec): string {
  return `${s.address ?? s.name}${s.room ? ` (${s.room})` : ''}`;
}
