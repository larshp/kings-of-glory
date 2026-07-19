import {
  deserializeWorld,
  inspectWorld,
  stableHash,
  stateHash,
  type WorldState,
} from '@kings/simulation';

interface CheckpointEnvelope {
  readonly state: unknown;
  readonly completed?: unknown;
  readonly stateHash?: unknown;
  readonly tick?: unknown;
}

export interface CheckpointInspection {
  readonly errors: readonly string[];
  readonly world?: WorldState;
  readonly hash?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const envelopeFor = (raw: unknown): CheckpointEnvelope | undefined => {
  const candidate = record(raw);
  return candidate && 'state' in candidate
    ? (candidate as unknown as CheckpointEnvelope)
    : undefined;
};

/**
 * Validates an exported checkpoint before an operator attempts recovery.
 * Both bare world snapshots and database-export envelopes are accepted.
 */
export const inspectCheckpoint = (raw: unknown): CheckpointInspection => {
  const envelope = envelopeFor(raw);
  const errors: string[] = [];
  if (envelope?.completed !== undefined && envelope.completed !== true)
    errors.push('checkpoint is not marked completed');
  const serializedState = envelope?.state ?? raw;
  let world: WorldState;
  try {
    world = deserializeWorld(serializedState);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'checkpoint state could not be read');
    return { errors };
  }
  errors.push(...inspectWorld(world));
  const hash = stateHash(world);
  if (envelope?.stateHash !== undefined) {
    if (typeof envelope.stateHash !== 'string') errors.push('checkpoint state hash is invalid');
    // Hash the stored snapshot, not its migrated form. Schema migrations can
    // legitimately add fields while an old completed checkpoint remains valid.
    else if (envelope.stateHash !== stableHash(serializedState))
      errors.push('checkpoint state hash does not match its state');
  }
  if (envelope?.tick !== undefined) {
    if (typeof envelope.tick !== 'number' || !Number.isSafeInteger(envelope.tick))
      errors.push('checkpoint tick is invalid');
    else if (envelope.tick !== world.tick) errors.push('checkpoint tick does not match its state');
  }
  return { errors, world, hash };
};
