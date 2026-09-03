import { describe, expect, it } from 'vitest';
import {
  analyzeSoak,
  memoryGrowthBytesPerHour,
  percentile,
  soakBudgets,
  type MemorySample,
  type SoakInput,
} from '../src/world-soak-report.js';

const samplesEvery10s = (heapBytes: (index: number) => number, count: number): MemorySample[] =>
  Array.from({ length: count }, (_, index) => ({
    elapsedMs: index * 10_000,
    rssBytes: heapBytes(index) * 4,
    heapUsedBytes: heapBytes(index),
  }));

const healthyInput = (overrides: Partial<SoakInput> = {}): SoakInput => ({
  players: 20,
  buildingsPerPlayer: 50,
  tickHz: 10,
  durationMs: 600_000,
  ticks: 6_000,
  droppedTicks: 0,
  commandCount: 12_000,
  botActions: {
    gather: 1,
    build: 1,
    research: 1,
    trade: 1,
    expand: 1,
    reconnect: 1,
    defend: 1,
  },
  entities: 1_000,
  stateHash: 'abcd1234',
  processedCommands: 1_024,
  largestSnapshotBytes: 400_000,
  tickDurationsMs: Array.from({ length: 6_000 }, () => 5),
  verificationDurationsMs: [12, 13],
  memorySamples: samplesEvery10s(() => 40_000_000, 60),
  hashFailures: [],
  invariantFailures: [],
  eventLoopDelayMs: { mean: 4, p99: 20, max: 90 },
  garbageCollectionForced: true,
  ...overrides,
});

describe('soak analysis', () => {
  it('reports a passing run without failures', () => {
    const report = analyzeSoak(healthyInput());
    expect(report.failures).toEqual([]);
    expect(report.ticksPerSecond).toBeCloseTo(10, 5);
    expect(report.tickDurationMs).toEqual({ mean: 5, p99: 5, max: 5 });
    expect(report.verifications).toBe(2);
    expect(report.heapGrowthBytesPerHour).toBe(0);
  });

  it('takes the nearest-rank percentile of tick durations', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.99)).toBe(100);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.9)).toBe(9);
    expect(percentile([], 0.99)).toBe(0);
  });

  it('leaves memory growth unmeasured for runs shorter than the growth window', () => {
    expect(
      memoryGrowthBytesPerHour(
        samplesEvery10s((index) => index * 1_000_000, 4),
        (sample) => sample.heapUsedBytes,
      ),
    ).toBeNull();
    const report = analyzeSoak(
      healthyInput({
        durationMs: 30_000,
        memorySamples: samplesEvery10s((index) => index * 20_000_000, 4),
      }),
    );
    expect(report.heapGrowthBytesPerHour).toBeNull();
    expect(report.failures).toEqual([]);
  });

  it('ignores warmup allocation when measuring growth', () => {
    // 200 MiB is allocated during the first quarter of the run, then the heap is flat.
    const growth = memoryGrowthBytesPerHour(
      samplesEvery10s((index) => (index < 15 ? index * 14_000_000 : 210_000_000), 60),
      (sample) => sample.heapUsedBytes,
    );
    expect(growth).toBe(0);
  });

  it('fails a run whose heap keeps growing after warmup', () => {
    const report = analyzeSoak(
      healthyInput({
        memorySamples: samplesEvery10s((index) => 40_000_000 + index * 1_000_000, 60),
      }),
    );
    expect(report.heapGrowthBytesPerHour).toBeGreaterThan(soakBudgets.heapGrowthBytesPerHour);
    expect(report.failures).toEqual(['heap grew 343 MiB/hour, which exceeds 16 MiB/hour']);
  });

  it('fails on tick overruns, event-loop stalls, dropped ticks, and hash drift', () => {
    const report = analyzeSoak(
      healthyInput({
        tickDurationsMs: [
          ...Array.from({ length: 90 }, () => 5),
          ...Array.from({ length: 10 }, () => 250),
        ],
        eventLoopDelayMs: { mean: 30, p99: 180, max: 4_000 },
        ticks: 100,
        droppedTicks: 40,
        hashFailures: ['tick 600: snapshot restored to aaaa, expected bbbb'],
        invariantFailures: ['tick 600: duplicate transfer transfer-1'],
      }),
    );
    expect(report.failures).toEqual([
      'tick 600: snapshot restored to aaaa, expected bbbb',
      'tick 600: duplicate transfer transfer-1',
      'tick p99 250.00 ms exceeds the 100 ms budget',
      'event-loop delay p99 180.00 ms exceeds the 100 ms budget',
      'event-loop stalled for 4000.00 ms, which exceeds the 1000 ms limit',
      'dropped 40 of 140 scheduled ticks, which exceeds 1%',
    ]);
  });

  it('fails a run that never advanced a tick', () => {
    const report = analyzeSoak(healthyInput({ ticks: 0, tickDurationsMs: [], durationMs: 0 }));
    expect(report.failures).toContain('the soak advanced no simulation ticks');
    expect(report.ticksPerSecond).toBe(0);
  });
});
