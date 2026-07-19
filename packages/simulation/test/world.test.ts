import { describe, expect, it } from 'vitest';
import { applyCommand, advanceTick, createWorld, joinPlayer, stateHash } from '../src/index.js';

describe('world simulation', () => {
  it('replays identical commands to an identical hash', () => {
    const run = () => {
      const world = createWorld(99); joinPlayer(world, 'player-a');
      applyCommand(world, { id: 'gather-1', playerId: 'player-a' as never, sequence: 1, type: 'gather', x: 12, y: 0 });
      applyCommand(world, { id: 'build-1', playerId: 'player-a' as never, sequence: 2, type: 'placeSmelter', x: 12, y: 0 });
      for (let index = 0; index < 10; index += 1) advanceTick(world);
      return stateHash(world);
    };
    expect(run()).toBe(run());
  });

  it('rejects duplicate commands without mutation', () => {
    const world = createWorld(); joinPlayer(world, 'player-a');
    const command = { id: 'gather-1', playerId: 'player-a' as never, sequence: 1, type: 'gather' as const, x: 12, y: 0 };
    expect(applyCommand(world, command).result.accepted).toBe(true);
    const hash = stateHash(world);
    expect(applyCommand(world, command).result).toMatchObject({ accepted: false, code: 'duplicate-command' });
    expect(stateHash(world)).toBe(hash);
  });
});
