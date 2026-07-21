/**
 * Platform-independent, serializable pseudo-random generator for simulation
 * decisions. The generator deliberately has one numeric state, which makes it
 * safe to include in snapshots and deterministic replays.
 */
export type RandomState = number & { readonly __brand: 'RandomState' };

const ZERO_STATE_FALLBACK = 0x6d2b79f5;
const UINT32_RANGE = 0x1_0000_0000;

export const createRandomState = (seed: number): RandomState => {
  const mixed = (seed ^ 0x9e3779b9) >>> 0;
  return (mixed === 0 ? ZERO_STATE_FALLBACK : mixed) as RandomState;
};

/** Returns the next generator state and a uniform value in [0, 1). */
export const nextRandom = (state: RandomState): readonly [RandomState, number] => {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  if (next === 0) next = ZERO_STATE_FALLBACK;
  return [next as RandomState, next / UINT32_RANGE];
};

/** Advances the state once and selects one stable index from a non-empty list. */
export const takeRandomIndex = (
  state: RandomState,
  count: number,
): readonly [RandomState, number] => {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('Random selection count must be a positive safe integer.');
  const [next, value] = nextRandom(state);
  return [next, Math.floor(value * count)];
};
