import { encodeH5075 } from '../govee/h5075.js';
import type { Logger } from '../logger.js';
import type { Advertisement, AdvertisementSource } from './types.js';

export const SIMULATED_ADDRESS = 'a4:c1:38:00:5e:75';
export const SIMULATED_NAME = 'GVH5075_5E75';
const INTERVAL_MS = 2_000;
const DAY_MS = 86_400_000;

/**
 * A plausible indoor climate: a daily cycle peaking mid-afternoon, a slow
 * multi-day drift, and humidity moving against temperature. Deterministic in
 * `ts` so backfilled history and live samples line up; `jitter` adds noise.
 */
export function simulatedClimate(ts: number, jitter = 0): { tempC: number; humidity: number } {
  // 1 at 15:00 UTC, -1 at 03:00 UTC.
  const daily = Math.cos(2 * Math.PI * ((ts % DAY_MS) / DAY_MS - 15 / 24));
  const drift = Math.sin((2 * Math.PI * ts) / (5.3 * DAY_MS));
  const tempC = 21 + 2.2 * daily + 1.2 * drift + jitter * (Math.random() - 0.5) * 0.3;
  const humidity = 46 - 6 * daily - 4 * drift + jitter * (Math.random() - 0.5) * 1.0;
  return { tempC, humidity: Math.min(99, Math.max(1, humidity)) };
}

/** Battery slowly drains from 100 % to ~55 % over a year, so the value is believable. */
export function simulatedBattery(ts: number): number {
  return Math.round(100 - Math.floor((ts / DAY_MS) % 365) / 8);
}

export class SimulatedSource implements AdvertisementSource {
  private timer?: NodeJS.Timeout;
  private onAdvertisement?: (adv: Advertisement) => void;

  constructor(private readonly log: Logger) {}

  async start(onAdvertisement: (adv: Advertisement) => void): Promise<void> {
    this.onAdvertisement = onAdvertisement;
    this.log.info(`Simulating ${SIMULATED_NAME} (${SIMULATED_ADDRESS}), one advertisement every ${INTERVAL_MS / 1000}s`);
    this.schedule();
    this.emit();
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
    const { tempC, humidity } = simulatedClimate(now, 1);
    this.onAdvertisement?.({
      id: SIMULATED_ADDRESS.replaceAll(':', ''),
      address: SIMULATED_ADDRESS,
      localName: SIMULATED_NAME,
      manufacturerData: encodeH5075({ tempC, humidity, battery: simulatedBattery(now) }),
      rssi: -62 + Math.round((Math.random() - 0.5) * 8),
      receivedAt: now,
    });
  }
}
