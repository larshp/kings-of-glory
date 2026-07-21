import { describe, expect, it } from 'vitest';
import {
  screenToTile,
  screenToWorld,
  TILE_HEIGHT,
  TILE_WIDTH,
  worldToScreen,
} from './projection.js';
describe('isometric projection', () => {
  it('round trips world positions', () => {
    const source = { x: 7, y: -3 };
    const restored = screenToWorld(worldToScreen(source));
    expect(restored.x).toBeCloseTo(source.x);
    expect(restored.y).toBeCloseTo(source.y);
  });

  it('picks the tile whose rendered diamond contains its center', () => {
    for (const tile of [
      { x: 0, y: 0 },
      { x: 4, y: -3 },
      { x: -2, y: 5 },
    ]) {
      const origin = worldToScreen(tile);
      expect(screenToTile({ x: origin.x + TILE_WIDTH / 2, y: origin.y + TILE_HEIGHT / 2 })).toEqual(
        tile,
      );
    }
  });
});
