import { decodeH5075, H5075_NAME_PREFIX, isGoveeManufacturerData } from './govee/h5075.js';
import type { Logger } from './logger.js';
import type { Advertisement } from './sources/types.js';

/** A decoded reading from one sensor advertisement. */
export interface Sample {
  sensorId: string;
  ts: number;
  tempC: number;
  humidity: number;
  battery: number;
  rssi: number;
}

export interface SensorSelection {
  /** MAC address (any of `:`/`-`/no separators, any case). */
  address?: string;
  /** Exact local name, e.g. GVH5075_1A2B. */
  name?: string;
}

const normalizeAddress = (a: string) => a.toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Picks the configured H5075 out of the advertisement stream and decodes it.
 * The H5075 often sends its name (scan response) and its data (advertisement)
 * in separate packets, so names are remembered per device ID.
 */
export class SensorSelector {
  private readonly names = new Map<string, string>();
  private readonly wantAddress?: string;
  private readonly wantName?: string;
  private chosenId?: string;

  constructor(
    selection: SensorSelection,
    private readonly log: Logger,
    private readonly debugRaw = false,
  ) {
    this.wantAddress = selection.address ? normalizeAddress(selection.address) : undefined;
    this.wantName = selection.name?.toLowerCase();
    if (this.wantAddress) log.info(`Listening for sensor with address ${selection.address}`);
    else if (this.wantName) log.info(`Listening for sensor named ${selection.name}`);
    else log.info(`No SENSOR_ADDRESS/SENSOR_NAME set; will use the first ${H5075_NAME_PREFIX}_* seen`);
  }

  handle(adv: Advertisement): Sample | null {
    if (adv.localName) this.names.set(adv.id, adv.localName);
    const name = adv.localName ?? this.names.get(adv.id);

    const govee = isGoveeManufacturerData(adv.manufacturerData);
    if (this.debugRaw && (govee || name?.startsWith('GV'))) {
      this.log.debug(
        `adv ${adv.address || adv.id} name=${name ?? '?'} rssi=${adv.rssi} mfr=${adv.manufacturerData?.toString('hex') ?? '-'}` +
          ` decoded=${JSON.stringify(decodeH5075(adv.manufacturerData))}`,
      );
    }
    if (!govee || !this.matches(adv, name)) return null;

    const reading = decodeH5075(adv.manufacturerData);
    if (!reading) {
      this.log.debug(`Undecodable H5075 data from ${adv.address || adv.id}: ${adv.manufacturerData?.toString('hex')}`);
      return null;
    }
    return { sensorId: adv.address || adv.id, ts: adv.receivedAt, rssi: adv.rssi, ...reading };
  }

  private matches(adv: Advertisement, name: string | undefined): boolean {
    if (this.wantAddress) {
      return normalizeAddress(adv.address) === this.wantAddress || normalizeAddress(adv.id) === this.wantAddress;
    }
    if (this.wantName) return name?.toLowerCase() === this.wantName;
    if (this.chosenId === undefined && name?.startsWith(`${H5075_NAME_PREFIX}_`)) {
      this.chosenId = adv.id;
      this.log.info(
        `Using sensor ${name} (address ${adv.address || 'n/a'}, id ${adv.id}). ` +
          `Set SENSOR_ADDRESS=${adv.address || adv.id} to pin it.`,
      );
    }
    return adv.id === this.chosenId;
  }
}
