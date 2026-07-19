import { describe, expect, it } from 'vitest';
import {
  entityAtTile,
  logisticsStatusColor,
  productionRateLabel,
  visibleByIsometricDepth,
  visibleChunkCoordinates,
  visibleRenderChunks,
  visibleTileBounds,
} from './WorldCanvas.js';

describe('visibleByIsometricDepth', () => {
  it('uses distinct logistics overlay colors for flow and actionable blockage', () => {
    expect(logisticsStatusColor('transferred')).toBe('#68d7f5');
    expect(logisticsStatusColor('target-full')).toBe('#f4b860');
    expect(logisticsStatusColor('target-reconfigured')).toBe('#de7780');
  });

  it('labels the configured producer rate from shared recipe content', () => {
    expect(productionRateLabel({ recipeId: 'smelt-ore' })).toBe('1 ingot/3t');
    expect(productionRateLabel({ recipeId: null })).toBe('no recipe');
  });

  it('culls off-map entities before applying a stable isometric depth order', () => {
    const entities = [
      { id: 'far-away', x: 20, y: 20 },
      { id: 'south-east', x: 2, y: 1 },
      { id: 'north-west', x: 0, y: 0 },
      { id: 'same-depth-later-y', x: 0, y: 2 },
      { id: 'same-depth-earlier-y', x: 1, y: 1 },
    ];
    expect(visibleByIsometricDepth(entities, { x: 0, y: 0 }, 3).map((entity) => entity.id)).toEqual(
      ['north-west', 'same-depth-earlier-y', 'same-depth-later-y', 'south-east'],
    );
  });

  it('moves tile coverage with the camera while retaining the full viewport', () => {
    const centered = visibleTileBounds(640, 480, { x: 0, y: 0 }, { panX: 0, panY: 0, scale: 1 });
    const panned = visibleTileBounds(640, 480, { x: 0, y: 0 }, { panX: -320, panY: 0, scale: 1 });
    expect(centered.minX).toBeLessThanOrEqual(centered.center.x);
    expect(centered.maxX).toBeGreaterThanOrEqual(centered.center.x);
    expect(panned.center.x).toBeGreaterThan(centered.center.x);
  });

  it('derives stable visible chunk subscriptions from viewport bounds', () => {
    expect(
      visibleChunkCoordinates({ minX: -1, maxX: 16, minY: -16, maxY: 0, center: { x: 0, y: 0 } }),
    ).toEqual([
      { x: -1, y: -1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 1, y: 0 },
    ]);
  });

  it('keeps tile draw work within the intersecting visible chunk containers', () => {
    expect(
      visibleRenderChunks({ minX: -1, maxX: 17, minY: 14, maxY: 17, center: { x: 0, y: 0 } }),
    ).toEqual([
      { x: -1, y: 0, minX: -1, maxX: -1, minY: 14, maxY: 15 },
      { x: -1, y: 1, minX: -1, maxX: -1, minY: 16, maxY: 17 },
      { x: 0, y: 0, minX: 0, maxX: 15, minY: 14, maxY: 15 },
      { x: 0, y: 1, minX: 0, maxX: 15, minY: 16, maxY: 17 },
      { x: 1, y: 0, minX: 16, maxX: 17, minY: 14, maxY: 15 },
      { x: 1, y: 1, minX: 16, maxX: 17, minY: 16, maxY: 17 },
    ]);
  });

  it('picks a visible threat before a building on the same tile', () => {
    expect(
      entityAtTile(
        { x: 2, y: 3 },
        [{ id: 'smelter', x: 2, y: 3 } as never],
        [{ id: 'raider', x: 2, y: 3 } as never],
      ),
    ).toEqual({ type: 'threat', id: 'raider' });
    expect(entityAtTile({ x: 2, y: 3 }, [{ id: 'smelter', x: 2, y: 3 } as never], [])).toEqual({
      type: 'building',
      id: 'smelter',
    });
  });
});
