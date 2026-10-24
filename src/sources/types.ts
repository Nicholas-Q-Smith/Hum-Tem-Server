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

/** Reported by /api/health, so clients can tell "server up but Bluetooth broken" apart. */
export interface SourceStatus {
  /** Adapter state from noble (poweredOn, poweredOff, unauthorized, ...), 'unavailable' if it couldn't be opened, or 'simulated'. */
  state: string;
  scanning: boolean;
  /** The last error opening or scanning, cleared once scanning works. */
  error: string | null;
}

export interface AdvertisementSource {
  start(onAdvertisement: (adv: Advertisement) => void): Promise<void>;
  status(): SourceStatus;
  /** Stop and start scanning again, e.g. when advertisements have dried up. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}
