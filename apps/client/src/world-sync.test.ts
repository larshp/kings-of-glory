import { describe, expect, it } from 'vitest';
import type { ClientWorldState, ServerMessage } from '@kings/protocol';
import { synchronizeWorld } from './world-sync.js';

const world = (tick: number): ClientWorldState =>
  ({
    tick,
    players: {},
    buildings: {},
    threats: {},
    terrain: {},
    territory: {},
  }) as ClientWorldState;

describe('world synchronization', () => {
  it('applies only contiguous deltas and requests recovery for a reordered response', () => {
    const bootstrap: ServerMessage = {
      type: 'worldBootstrap',
      playerId: 'player-a',
      stateVersion: 4,
      state: world(4),
    };
    const connected = synchronizeWorld({ version: undefined, state: undefined }, bootstrap);
    const reordered: ServerMessage = {
      type: 'stateDelta',
      version: 6,
      baseVersion: 5,
      delta: { tick: 6 },
    };
    const missingVersion = synchronizeWorld(connected.sync, reordered);
    expect(missingVersion).toEqual({ sync: connected.sync, needsResync: true });

    const contiguous: ServerMessage = {
      type: 'stateDelta',
      version: 5,
      baseVersion: 4,
      delta: { tick: 5 },
    };
    expect(synchronizeWorld(connected.sync, contiguous)).toEqual({
      sync: { version: 5, state: world(5) },
      needsResync: false,
    });
  });

  it('ignores a delayed full snapshot after a newer state is visible', () => {
    const current = { version: 7, state: world(7) };
    const lateSnapshot: ServerMessage = {
      type: 'chunkSnapshot',
      version: 6,
      chunks: [{ x: 0, y: 0 }],
      state: world(6),
    };
    expect(synchronizeWorld(current, lateSnapshot)).toEqual({ sync: current, needsResync: false });
  });
});
