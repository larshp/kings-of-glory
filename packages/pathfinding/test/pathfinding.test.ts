import { describe, expect, it } from 'vitest';
import { chunkFor, findHierarchicalPath, findPath } from '../src/index.js';

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

  it('keeps repeated obstacle-heavy searches deterministic and within their work budgets', () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const search = () =>
        findPath({
          start: { x: -12, y: -12 },
          goal: { x: 12, y: 12 },
          maxVisited: 96,
          bounds: { minX: -16, maxX: 16, minY: -16, maxY: 16 },
          isPassable: (tile) =>
            (tile.x === -12 && tile.y === -12) ||
            (tile.x === 12 && tile.y === 12) ||
            Math.abs((tile.x * 17 + tile.y * 31 + seed * 13) % 11) > 1,
        });
      const first = search();
      expect(search()).toEqual(first);
      expect(first.visited).toBeLessThanOrEqual(96);
    }
  });

  it('combines a chunk route with local tile paths under one deterministic budget', () => {
    const run = () =>
      findHierarchicalPath({
        start: { x: 1, y: 1 },
        goal: { x: 35, y: 1 },
        maxVisited: 160,
        maxChunkVisited: 32,
        chunkSize: 16,
        bounds: { minX: 0, maxX: 47, minY: -16, maxY: 15 },
        isChunkPassable: (chunk) => !(chunk.x === 1 && chunk.y === 0),
        isPassable: () => true,
      });
    const result = run();
    expect(run()).toEqual(result);
    expect(result.status).toBe('found');
    expect(result.visited).toBeLessThanOrEqual(160);
    expect(result.chunkPath).not.toContainEqual({ x: 1, y: 0 });
    expect(result.localPaths.length).toBeGreaterThan(1);
    expect(result.path.at(0)).toEqual({ x: 1, y: 1 });
    expect(result.path.at(-1)).toEqual({ x: 35, y: 1 });
  });

  it('makes coarse-route exhaustion explicit before any local search can overrun the budget', () => {
    const result = findHierarchicalPath({
      start: { x: 0, y: 0 },
      goal: { x: 160, y: 0 },
      maxVisited: 3,
      maxChunkVisited: 3,
      isPassable: () => true,
    });
    expect(result).toMatchObject({ status: 'budget-exhausted', visited: 3, localPaths: [] });
  });
});
