import { describe, expect, it } from 'vitest';
import { createWorld, snapshot, stableHash, stateHash } from '@kings/simulation';
import { inspectCheckpoint } from '../src/checkpoint-inspection.js';

describe('checkpoint inspection', () => {
  it('accepts a consistent completed checkpoint envelope', () => {
    const state = snapshot(createWorld(41));
    const inspection = inspectCheckpoint({
      checkpointId: 'checkpoint-1',
      completed: true,
      tick: state.tick,
      stateHash: stateHash(state),
      state,
    });
    expect(inspection.errors).toEqual([]);
    expect(inspection.world?.seed).toBe(41);
  });

  it('rejects incomplete, tampered, and incorrectly labelled checkpoint envelopes', () => {
    const state = snapshot(createWorld());
    const inspection = inspectCheckpoint({
      completed: false,
      tick: state.tick + 1,
      stateHash: 'not-the-state-hash',
      state,
    });
    expect(inspection.errors).toEqual([
      'checkpoint is not marked completed',
      'checkpoint state hash does not match its state',
      'checkpoint tick does not match its state',
    ]);
  });

  it('accepts a bare world snapshot for development recovery checks', () => {
    expect(inspectCheckpoint(snapshot(createWorld())).errors).toEqual([]);
  });

  it('accepts a correctly hashed schema-14 checkpoint after migration', () => {
    const legacy = snapshot(createWorld(41)) as unknown as {
      schemaVersion: 14;
      randomState?: number;
    };
    legacy.schemaVersion = 14;
    delete legacy.randomState;
    const inspection = inspectCheckpoint({
      completed: true,
      tick: legacy.tick,
      stateHash: stableHash(legacy),
      state: legacy,
    });
    expect(inspection.errors).toEqual([]);
    expect(inspection.world?.schemaVersion).toBe(26);
  });
});
