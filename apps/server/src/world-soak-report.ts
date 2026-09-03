import type { BotActionKind } from '@kings/simulation';

/**
 * Soak thresholds. Tick and event-loop budgets come from the Phase 0 budgets; the
 * memory-growth budget is a regression gate, not a design target: a permanent world
 * must reach a steady state instead of trending upwards for the whole run.
 */
export const soakBudgets = {
  /** The 10 Hz simulation tick from GAME_DESIGN.md. */
  tickP99Ms: 100,
  /**
   * Timers must still fire inside one 10 Hz tick period. Absolute delay is
   * platform-sensitive, so the hard stall gate is the maximum, not the percentile.
   */
  eventLoopP99Ms: 100,
  eventLoopMaxMs: 1_000,
  /** Sustained heap growth allowed across the measured window. */
  heapGrowthBytesPerHour: 16 * 1_024 * 1_024,
  /** Ticks the host may drop before catch-up counts as unrecoverable drift. */
  droppedTickFraction: 0.01,
  /**
   * Growth analysis needs a long enough post-warmup window to separate a leak from
   * allocator noise. Shorter runs report growth as unmeasured instead of failing.
   */
  growthWindowMs: 120_000,
  growthWindowSamples: 5,
} as const;

export interface MemorySample {
  readonly elapsedMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface SoakInput {
  readonly players: number;
  readonly buildingsPerPlayer: number;
  readonly tickHz: number;
  readonly durationMs: number;
  readonly ticks: number;
  readonly droppedTicks: number;
  readonly commandCount: number;
  readonly botActions: Readonly<Record<BotActionKind, number>>;
  readonly entities: number;
  readonly stateHash: string;
  readonly processedCommands: number;
  readonly largestSnapshotBytes: number;
  readonly tickDurationsMs: readonly number[];
  readonly verificationDurationsMs: readonly number[];
  readonly memorySamples: readonly MemorySample[];
  readonly hashFailures: readonly string[];
  readonly invariantFailures: readonly string[];
  readonly eventLoopDelayMs: { readonly mean: number; readonly p99: number; readonly max: number };
  readonly garbageCollectionForced: boolean;
}

export const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1);
  return ordered[Math.max(0, index)]!;
};

/**
 * Least-squares slope of a memory series, in bytes per hour, or null when the run is
 * too short to distinguish a leak from allocator noise. Samples from the first warmup
 * fraction are ignored so lazily allocated caches are not reported as growth.
 */
export const memoryGrowthBytesPerHour = (
  samples: readonly MemorySample[],
  select: (sample: MemorySample) => number,
  warmupFraction = 0.25,
): number | null => {
  const lastElapsedMs = samples.at(-1)?.elapsedMs ?? 0;
  const warmupUntilMs = lastElapsedMs * warmupFraction;
  const measured = samples.filter((sample) => sample.elapsedMs >= warmupUntilMs);
  if (
    measured.length < soakBudgets.growthWindowSamples ||
    lastElapsedMs - warmupUntilMs < soakBudgets.growthWindowMs
  )
    return null;
  const meanElapsedMs =
    measured.reduce((total, sample) => total + sample.elapsedMs, 0) / measured.length;
  const meanValue = measured.reduce((total, sample) => total + select(sample), 0) / measured.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of measured) {
    const elapsedOffset = sample.elapsedMs - meanElapsedMs;
    covariance += elapsedOffset * (select(sample) - meanValue);
    variance += elapsedOffset * elapsedOffset;
  }
  if (variance === 0) return 0;
  return (covariance / variance) * 3_600_000;
};

export interface SoakReport extends Omit<SoakInput, 'tickDurationsMs' | 'verificationDurationsMs'> {
  readonly ticksPerSecond: number;
  readonly tickDurationMs: { readonly mean: number; readonly p99: number; readonly max: number };
  readonly verificationDurationMs: { readonly mean: number; readonly max: number };
  readonly verifications: number;
  /** Null when the run was too short for a trustworthy growth measurement. */
  readonly heapGrowthBytesPerHour: number | null;
  readonly rssGrowthBytesPerHour: number | null;
  readonly budgets: typeof soakBudgets;
  readonly failures: readonly string[];
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/** Turns raw soak samples into a report plus the explicit reasons a run failed. */
export const analyzeSoak = (input: SoakInput): SoakReport => {
  const { tickDurationsMs, verificationDurationsMs, ...rest } = input;
  const tickP99 = percentile(tickDurationsMs, 0.99);
  const heapGrowth = memoryGrowthBytesPerHour(
    input.memorySamples,
    (sample) => sample.heapUsedBytes,
  );
  const rssGrowth = memoryGrowthBytesPerHour(input.memorySamples, (sample) => sample.rssBytes);
  const failures: string[] = [];
  if (input.ticks < 1) failures.push('the soak advanced no simulation ticks');
  failures.push(...input.hashFailures, ...input.invariantFailures);
  if (tickP99 > soakBudgets.tickP99Ms)
    failures.push(
      `tick p99 ${tickP99.toFixed(2)} ms exceeds the ${soakBudgets.tickP99Ms} ms budget`,
    );
  if (input.eventLoopDelayMs.p99 > soakBudgets.eventLoopP99Ms)
    failures.push(
      `event-loop delay p99 ${input.eventLoopDelayMs.p99.toFixed(2)} ms exceeds the ${soakBudgets.eventLoopP99Ms} ms budget`,
    );
  if (input.eventLoopDelayMs.max > soakBudgets.eventLoopMaxMs)
    failures.push(
      `event-loop stalled for ${input.eventLoopDelayMs.max.toFixed(2)} ms, which exceeds the ${soakBudgets.eventLoopMaxMs} ms limit`,
    );
  if (input.droppedTicks > Math.ceil(input.ticks * soakBudgets.droppedTickFraction))
    failures.push(
      `dropped ${input.droppedTicks} of ${input.ticks + input.droppedTicks} scheduled ticks, which exceeds ${soakBudgets.droppedTickFraction * 100}%`,
    );
  if (heapGrowth !== null && heapGrowth > soakBudgets.heapGrowthBytesPerHour)
    failures.push(
      `heap grew ${Math.round(heapGrowth / 1_048_576)} MiB/hour, which exceeds ${soakBudgets.heapGrowthBytesPerHour / 1_048_576} MiB/hour`,
    );
  return {
    ...rest,
    ticksPerSecond: input.durationMs > 0 ? input.ticks / (input.durationMs / 1_000) : 0,
    tickDurationMs: {
      mean: mean(tickDurationsMs),
      p99: tickP99,
      max: tickDurationsMs.length === 0 ? 0 : Math.max(...tickDurationsMs),
    },
    verificationDurationMs: {
      mean: mean(verificationDurationsMs),
      max: verificationDurationsMs.length === 0 ? 0 : Math.max(...verificationDurationsMs),
    },
    verifications: verificationDurationsMs.length,
    heapGrowthBytesPerHour: heapGrowth === null ? null : Math.round(heapGrowth),
    rssGrowthBytesPerHour: rssGrowth === null ? null : Math.round(rssGrowth),
    budgets: soakBudgets,
    failures,
  };
};
