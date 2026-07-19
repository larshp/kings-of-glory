/**
 * A clock-free fixed-timestep accumulator. Hosts decide how to obtain elapsed
 * time; simulation code only receives whole deterministic steps.
 */
export class FixedStepRunner {
  #remainingMs = 0;

  constructor(
    readonly stepMs = 100,
    readonly maxCatchUpSteps = 5,
  ) {
    if (!Number.isSafeInteger(stepMs) || stepMs < 1)
      throw new Error('Fixed simulation step must be a positive safe integer in milliseconds.');
    if (!Number.isSafeInteger(maxCatchUpSteps) || maxCatchUpSteps < 1)
      throw new Error('Maximum fixed-step catch-up must be a positive safe integer.');
  }

  get remainingMs(): number {
    return this.#remainingMs;
  }

  /** Advances a callback once per complete simulation step and returns that count. */
  advance(elapsedMs: number, step: () => void): number {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
      throw new Error('Elapsed simulation time must be a non-negative finite number.');
    this.#remainingMs += elapsedMs;
    const availableSteps = Math.floor(this.#remainingMs / this.stepMs);
    const steps = Math.min(availableSteps, this.maxCatchUpSteps);
    for (let index = 0; index < steps; index += 1) step();
    // When a host has fallen far behind, keep only the fractional residual.
    // This prevents an unbounded catch-up while preserving future step alignment.
    this.#remainingMs =
      availableSteps > this.maxCatchUpSteps
        ? this.#remainingMs % this.stepMs
        : this.#remainingMs - steps * this.stepMs;
    return steps;
  }
}
