import { describe, expect, it } from 'vitest';
import { decodeH5075, encodeH5075 } from '../src/govee/h5075.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

describe('decodeH5075', () => {
  it('decodes a positive temperature', () => {
    // raw = 0x03 4A 8B = 215691 -> 21.5 °C, 69.1 %
    expect(decodeH5075(hex('88ec00 034a8b 64 00'))).toEqual({ tempC: 21.5, humidity: 69.1, battery: 100 });
  });

  it('decodes a negative temperature', () => {
    // raw = 0x80 C7 10 -> bit 23 set, 0x00C710 = 50960 -> -5.0 °C, 96.0 %
    expect(decodeH5075(hex('88ec00 80c710 4b 00'))).toEqual({ tempC: -5, humidity: 96, battery: 75 });
  });

  it('decodes a small negative temperature', () => {
    // 0x800000 | 4512 -> -0.4 °C, 51.2 %
    const raw = (0x800000 | 4512).toString(16).padStart(6, '0');
    expect(decodeH5075(hex(`88ec00 ${raw} 32 00`))).toEqual({ tempC: -0.4, humidity: 51.2, battery: 50 });
  });

  it('decodes zero without producing -0', () => {
    const r = decodeH5075(hex('88ec00 800190 32 00'));
    expect(r).toEqual({ tempC: 0, humidity: 40, battery: 50 });
    expect(Object.is(r!.tempC, -0)).toBe(false);
  });

  it('rejects other company IDs, short payloads and nonsense values', () => {
    expect(decodeH5075(undefined)).toBeNull();
    expect(decodeH5075(hex('4c00 034a8b 64 00'))).toBeNull();
    expect(decodeH5075(hex('88ec00 034a8b'))).toBeNull();
    expect(decodeH5075(hex('88ec00 7fffff 64 00'))).toBeNull(); // 838.8 °C
    expect(decodeH5075(hex('88ec00 034a8b c8 00'))).toBeNull(); // battery 200 %
  });

  it('round-trips through encodeH5075', () => {
    for (const r of [
      { tempC: 23.4, humidity: 45.6, battery: 88 },
      { tempC: -12.3, humidity: 80.1, battery: 7 },
      { tempC: 0.1, humidity: 0, battery: 100 },
    ]) {
      expect(decodeH5075(encodeH5075(r))).toEqual(r);
    }
  });
});
