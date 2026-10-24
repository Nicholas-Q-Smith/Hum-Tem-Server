/** One BLE advertisement, independent of where it came from (noble, simulator, ...). */
export interface Advertisement {
  /** Stable per-device ID (noble's peripheral.id). */
  id: string;
  /** MAC address, lower-case with colons; may be empty on macOS. */
  address: string;
  localName?: string;
  manufacturerData?: Buffer;
  rssi: number;
  /** Epoch ms when we received it. */
  receivedAt: number;
}

export interface AdvertisementSource {
  start(onAdvertisement: (adv: Advertisement) => void): Promise<void>;
  /** Stop and start scanning again, e.g. when advertisements have dried up. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}
