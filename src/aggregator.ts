import type { Sample } from './sensors.js';

export const MINUTE_MS = 60_000;

/** One stored row: the aggregate of all samples within a minute. */
export interface MinuteRow {
  /** Minute start, epoch ms. */
  ts: number;
  tempC: number;
  humidity: number;
  battery?: number;
  rssi?: number;
  samples: number;
}

interface Accumulator {
  samples: Sample[];
  tempSum: number;
  humiditySum: number;
  count: number;
  battery: number;
  rssi: number;
}

export const minuteStart = (ts: number) => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

/**
 * Buckets samples by minute and hands each minute to `sink` once it closes:
 * mean temperature/humidity, last battery/RSSI, and the sample count, along
 * with the raw samples so both can be written in one transaction.
 */
export class MinuteAggregator {
  private readonly buckets = new Map<number, Accumulator>();

  constructor(private readonly sink: (row: MinuteRow, samples: Sample[]) => void) {}

  add(sample: Sample): void {
    const key = minuteStart(sample.ts);
    // A sample in a new minute proves every earlier minute has closed.
    this.flushBefore(key);
    const acc = this.buckets.get(key);
    if (acc) {
      acc.samples.push(sample);
      acc.tempSum += sample.tempC;
      acc.humiditySum += sample.humidity;
      acc.count += 1;
      acc.battery = sample.battery;
      acc.rssi = sample.rssi;
    } else {
      this.buckets.set(key, {
        samples: [sample],
        tempSum: sample.tempC,
        humiditySum: sample.humidity,
        count: 1,
        battery: sample.battery,
        rssi: sample.rssi,
      });
    }
  }

  /** Flush every minute that started before `ts` (call on a timer with Date.now()). */
  flushBefore(ts: number): number {
    const cutoff = minuteStart(ts);
    let flushed = 0;
    for (const key of [...this.buckets.keys()].sort((a, b) => a - b)) {
      if (key >= cutoff) continue;
      this.emit(key);
      flushed++;
    }
    return flushed;
  }

  /** Flush everything, including the still-open minute (on shutdown). */
  flushAll(): number {
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const key of keys) this.emit(key);
    return keys.length;
  }

  private emit(key: number): void {
    const acc = this.buckets.get(key)!;
    this.buckets.delete(key);
    this.sink(
      {
        ts: key,
        tempC: acc.tempSum / acc.count,
        humidity: acc.humiditySum / acc.count,
        battery: acc.battery,
        rssi: acc.rssi,
        samples: acc.count,
      },
      acc.samples,
    );
  }
}
