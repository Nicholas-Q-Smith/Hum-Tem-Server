import { encodeH5075 } from '../govee/h5075.js';
import type { Logger } from '../logger.js';
import type { Advertisement, AdvertisementSource } from './types.js';

const INTERVAL_MS = 2_000;
const DAY_MS = 86_400_000;

export interface SimulatedDevice {
  address: string;
  name: string;
  room: string;
  /** Climate profile: offsets from the base indoor climate. */
  tempOffset: number;
  humidityOffset: number;
  rssi: number;
}

const ROOMS: [room: string, tempOffset: number, humidityOffset: number][] = [
  ['Living room', 0, 0],
  ['Bedroom', -1.5, 3],
  ['Office', 0.8, -4],
  ['Kitchen', 1.2, 5],
  ['Bathroom', 1.8, 15],
  ['Hallway', -0.5, 0],
  ['Garage', -6, 10],
  ['Loft', 1.5, -6],
  ['Cellar', -4, 12],
];

/** The `count` fake sensors simulate mode records, one per room. */
export function simulatedDevices(count: number): SimulatedDevice[] {
  return ROOMS.slice(0, count).map(([room, tempOffset, humidityOffset], i) => ({
    address: `a4:c1:38:00:5e:7${i}`,
    name: `GVH5075_5E7${i}`,
    room,
    tempOffset,
    humidityOffset,
    rssi: -58 - i * 6,
  }));
}

/** A neighbour's sensor: heard, but not configured, so it shows up under `nearby`. */
const NEIGHBOUR: SimulatedDevice = {
  address: 'a4:c1:38:9f:01:23',
  name: 'GVH5075_0123',
  room: '',
  tempOffset: 2,
  humidityOffset: -10,
  rssi: -89,
};

/**
 * A plausible indoor climate: a daily cycle peaking mid-afternoon, a slow
 * multi-day drift, and humidity moving against temperature. Deterministic in
 * `ts` so backfilled history and live samples line up; `jitter` adds noise.
 */
export function simulatedClimate(
  ts: number,
  jitter = 0,
  device?: Pick<SimulatedDevice, 'tempOffset' | 'humidityOffset'>,
): { tempC: number; humidity: number } {
  // 1 at 15:00 UTC, -1 at 03:00 UTC.
  const daily = Math.cos(2 * Math.PI * ((ts % DAY_MS) / DAY_MS - 15 / 24));
  const drift = Math.sin((2 * Math.PI * ts) / (5.3 * DAY_MS));
  const tempC = 21 + (device?.tempOffset ?? 0) + 2.2 * daily + 1.2 * drift + jitter * (Math.random() - 0.5) * 0.3;
  const humidity = 46 + (device?.humidityOffset ?? 0) - 6 * daily - 4 * drift + jitter * (Math.random() - 0.5) * 1.0;
  return { tempC, humidity: Math.min(99, Math.max(1, humidity)) };
}

/** Battery slowly drains from 100 % to ~55 % over a year, so the value is believable. */
export function simulatedBattery(ts: number): number {
  return Math.round(100 - Math.floor((ts / DAY_MS) % 365) / 8);
}

export class SimulatedSource implements AdvertisementSource {
  private timer?: NodeJS.Timeout;
  private onAdvertisement?: (adv: Advertisement) => void;

  private readonly devices: SimulatedDevice[];

  constructor(
    devices: SimulatedDevice[],
    private readonly log: Logger,
  ) {
    this.devices = [...devices, NEIGHBOUR];
  }

  async start(onAdvertisement: (adv: Advertisement) => void): Promise<void> {
    this.onAdvertisement = onAdvertisement;
    this.log.info(
      `Simulating ${this.devices.length} H5075s (${this.devices.map((d) => d.name).join(', ')}), ` +
        `one advertisement each every ${INTERVAL_MS / 1000}s`,
    );
    this.schedule();
    this.emit();
  }

  status() {
    return { state: 'simulated', scanning: this.timer !== undefined, error: null };
  }

  async restart(): Promise<void> {
    clearInterval(this.timer);
    this.schedule();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.timer = setInterval(() => this.emit(), INTERVAL_MS);
  }

  private emit(): void {
    const now = Date.now();
    for (const d of this.devices) {
      const { tempC, humidity } = simulatedClimate(now, 1, d);
      this.onAdvertisement?.({
        id: d.address.replaceAll(':', ''),
        address: d.address,
        localName: d.name,
        manufacturerData: encodeH5075({ tempC, humidity, battery: simulatedBattery(now) }),
        rssi: d.rssi + Math.round((Math.random() - 0.5) * 8),
        receivedAt: now,
      });
    }
  }
}
