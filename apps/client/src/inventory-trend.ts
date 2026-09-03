import type { ItemKind } from '@kings/simulation';

/**
 * A rolling window of the player's own stock, so the resource bar can say whether a chain is
 * actually producing instead of only what is carried right now. It samples client-side state
 * the player already has; nothing here is authoritative and nothing is sent to the server.
 */

export interface InventorySample {
  readonly at: number;
  readonly inventory: Readonly<Record<ItemKind, number>>;
}

export const TREND_WINDOW_MS = 60_000;
/** Below this span a small change extrapolates to an absurd rate, so no rate is shown. */
const MINIMUM_SPAN_MS = 10_000;

export const withInventorySample = (
  samples: readonly InventorySample[],
  sample: InventorySample,
): readonly InventorySample[] =>
  [...samples, sample].filter((candidate) => sample.at - candidate.at <= TREND_WINDOW_MS);

/** Change per minute across the window, or nothing while the window is still too short. */
export const inventoryRatesPerMinute = (
  samples: readonly InventorySample[],
): Readonly<Partial<Record<ItemKind, number>>> => {
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  if (!oldest || !newest) return {};
  const span = newest.at - oldest.at;
  if (span < MINIMUM_SPAN_MS) return {};
  return Object.fromEntries(
    (Object.keys(newest.inventory) as ItemKind[]).map((item) => [
      item,
      Math.round(((newest.inventory[item] - oldest.inventory[item]) * 60_000) / span),
    ]),
  );
};
