import { createRequire } from 'node:module';
import type { Logger } from '../logger.js';
import type { Advertisement, AdvertisementSource, SourceStatus } from './types.js';

type Noble = typeof import('@abandonware/noble');
// require() rather than import(): a failed CommonJS load (e.g. no Bluetooth socket
// support) isn't cached, so a later start() can try again.
const require = createRequire(import.meta.url);

const RETRY_MS = 5_000;

/** Passive BLE scanning via noble. No connections are made. */
export class NobleSource implements AdvertisementSource {
  private noble?: Noble;
  private stopping = false;
  private retryTimer?: NodeJS.Timeout;
  private scanning = false;
  private error: string | null = null;

  constructor(private readonly log: Logger) {}

  status(): SourceStatus {
    return { state: this.noble ? this.noble._state : 'unavailable', scanning: this.scanning, error: this.error };
  }

  async start(onAdvertisement: (adv: Advertisement) => void): Promise<void> {
    // Loaded lazily so --simulate never touches Bluetooth.
    let noble: Noble;
    try {
      noble = require('@abandonware/noble') as Noble;
    } catch (err) {
      this.error = `Bluetooth unavailable: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
    this.noble = noble;
    this.error = null;

    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        this.log.info('Bluetooth adapter powered on');
        void this.startScanning();
      } else {
        this.log.warn(`Bluetooth adapter state: ${state}; waiting for it to power on`);
      }
    });
    noble.on('scanStart', () => {
      this.scanning = true;
      this.error = null;
      this.log.info('BLE scan started');
    });
    noble.on('scanStop', () => {
      this.scanning = false;
      if (this.stopping) return;
      this.log.warn('BLE scan stopped unexpectedly; restarting');
      this.scheduleRetry();
    });
    noble.on('warning', (msg: string) => {
      this.error = msg;
      this.log.warn(`noble: ${msg}`);
    });
    noble.on('discover', (p) => {
      onAdvertisement({
        id: p.id,
        address: (p.address ?? '').toLowerCase(),
        localName: p.advertisement?.localName || undefined,
        manufacturerData: p.advertisement?.manufacturerData ?? undefined,
        rssi: p.rssi,
        receivedAt: Date.now(),
      });
    });

    if (noble._state === 'poweredOn') await this.startScanning();
  }

  async restart(): Promise<void> {
    const noble = this.noble;
    if (!noble || this.stopping) return;
    this.log.info(`Restarting BLE scan (adapter state: ${noble._state})`);
    try {
      await noble.stopScanningAsync();
    } catch (err) {
      this.log.debug(`stopScanning failed: ${String(err)}`);
    }
    if (noble._state !== 'poweredOn') {
      // Ask the HCI binding to re-initialise the adapter; a stateChange to
      // poweredOn will then start scanning again.
      try {
        noble.reset();
      } catch (err) {
        this.log.debug(`noble.reset() failed: ${String(err)}`);
      }
      return;
    }
    await this.startScanning();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    try {
      await this.noble?.stopScanningAsync();
    } catch {
      // Shutting down anyway.
    }
  }

  private async startScanning(): Promise<void> {
    const noble = this.noble;
    if (!noble || this.stopping) return;
    try {
      // allowDuplicates: every advertisement carries a fresh reading.
      await noble.startScanningAsync([], true);
    } catch (err) {
      this.error = `Failed to start BLE scan: ${String(err)}`;
      this.log.error(this.error);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.noble?._state === 'poweredOn') void this.startScanning();
    }, RETRY_MS);
  }
}
