/**
 * Govee H5075 advertisement decoding.
 *
 * Manufacturer data (as delivered by noble, company ID little-endian first):
 *   88 EC 00 b1 b2 b3 batt 00
 * where raw = b1<<16 | b2<<8 | b3 packs temperature and humidity in decimal:
 * raw = tempTenths * 1000 + humidityTenths, with bit 23 flagging a negative temperature.
 */

export const GOVEE_COMPANY_ID = 0xec88;
export const H5075_NAME_PREFIX = 'GVH5075';

export interface H5075Reading {
  tempC: number;
  humidity: number;
  /** Percent. */
  battery: number;
}

export function isGoveeManufacturerData(data: Buffer | undefined): data is Buffer {
  return data !== undefined && data.length >= 2 && data.readUInt16LE(0) === GOVEE_COMPANY_ID;
}

export function decodeH5075(data: Buffer | undefined): H5075Reading | null {
  if (!isGoveeManufacturerData(data) || data.length < 7) return null;

  let raw = data.readUIntBE(3, 3);
  const negative = (raw & 0x800000) !== 0;
  if (negative) raw &= 0x7fffff;

  const magnitude = Math.floor(raw / 1000) / 10;
  const tempC = negative ? -magnitude : magnitude;
  const humidity = (raw % 1000) / 10;
  const battery = data[6]!;

  // The sensor is rated -20..60 °C; anything far outside means we misparsed a
  // packet (e.g. a different Govee model sharing the company ID).
  if (tempC < -40 || tempC > 85 || humidity > 100 || battery > 100) return null;

  return { tempC: tempC === 0 ? 0 : tempC, humidity, battery };
}

/** Inverse of {@link decodeH5075}; used by the simulator and tests. */
export function encodeH5075({ tempC, humidity, battery }: H5075Reading): Buffer {
  let raw = Math.round(Math.abs(tempC) * 10) * 1000 + Math.min(999, Math.max(0, Math.round(humidity * 10)));
  if (tempC < 0) raw |= 0x800000;
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(GOVEE_COMPANY_ID, 0);
  buf[2] = 0x00;
  buf.writeUIntBE(raw, 3, 3);
  buf[6] = Math.min(100, Math.max(0, Math.round(battery)));
  buf[7] = 0x00;
  return buf;
}
