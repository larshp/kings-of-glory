import { describe, expect, it } from 'vitest';
import { chunkFor, findPath } from '../src/index.js';

describe('bounded deterministic pathfinding', () => {
  it('chooses a stable shortest path around obstacles', () => {
    const run = () =>
      findPath({
        start: { x: 0, y: 0 },
        goal: { x: 2, y: 0 },
        maxVisited: 50,
        bounds: { minX: -2, maxX: 3, minY: -2, maxY: 2 },
        isPassable: (tile) => !(tile.x === 1 && tile.y === 0),
      });
    expect(run()).toEqual(run());
    expect(run()).toMatchObject({
      status: 'found',
      path: [
        { x: 0, y: 0 },
        { x: 0, y: -1 },
        { x: 1, y: -1 },
        { x: 2, y: -1 },
        { x: 2, y: 0 },
      ],
    });
  });

  it('reports unreachable and budget-exhausted searches explicitly', () => {
    expect(
      findPath({
        start: { x: 0, y: 0 },
        goal: { x: 2, y: 0 },
        maxVisited: 20,
        isPassable: (tile) => tile.x === 0 && tile.y === 0,
      }).status,
    ).toBe('unreachable');
    expect(
      findPath({
        start: { x: 0, y: 0 },
        goal: { x: 10, y: 0 },
        maxVisited: 2,
        isPassable: () => true,
      }).status,
    ).toBe('budget-exhausted');
  });

  it('maps negative tiles to their containing chunk', () => {
    expect(chunkFor({ x: -1, y: -16 })).toEqual({ x: -1, y: -1 });
  });
});
