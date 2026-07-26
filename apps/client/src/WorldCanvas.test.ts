import { describe, expect, it } from 'vitest';
import {
  cameraOrigin,
  entityAtTile,
  initialCameraFocus,
  logisticsStatusColor,
  productionRateLabel,
  resourceIsReachable,
  tileHoverLines,
  visibleByIsometricDepth,
  visibleChunkCoordinates,
  visibleRenderChunks,
  visibleTileBounds,
} from './WorldCanvas.js';

describe('visibleByIsometricDepth', () => {
  it('places the focused tile diamond at the viewport center', () => {
    expect(cameraOrigin(640, 480)).toEqual({ x: 288, y: 224 });
    expect(
      visibleTileBounds(640, 480, { x: 4, y: 7 }, { panX: 0, panY: 0, scale: 1 }).center,
    ).toEqual({ x: 4, y: 7 });
  });

  it('focuses the initial map on the player settlement center', () => {
    const buildings = [
      { id: 'foreign-center', kind: 'settlement-center', ownerId: 'other', x: 30, y: 40 },
      { id: 'own-center', kind: 'settlement-center', ownerId: 'player', x: 4, y: 7 },
    ] as never;
    expect(initialCameraFocus(buildings, 'player', { x: 0, y: 0, size: 16 })).toEqual({
      x: 4,
      y: 7,
    });
  });

  it('falls back to the plot center until the settlement center is available', () => {
    expect(initialCameraFocus([], 'player', { x: 8, y: 12, size: 16 })).toEqual({
      x: 16,
      y: 20,
    });
  });

  it('describes hovered terrain, ownership, occupants, and buildability', () => {
    expect(
      tileHoverLines({
        tile: { x: 4, y: 7 },
        terrain: 'grass',
        minedAmount: 0,
        resourceReachable: true,
        territoryOwner: 'player',
        playerId: 'player',
        placementValid: false,
        building: {
          kind: 'settlement-center',
          constructionTicks: 0,
          health: 25,
          maxHealth: 25,
        } as never,
        threat: undefined,
      }),
    ).toEqual([
      'Tile 4, 7',
      'Grassland · Your territory',
      'settlement center · health 25/25',
      'Not buildable',
    ]);
  });

  it('shows authoritative remaining yield for finite resource tiles', () => {
    expect(
      tileHoverLines({
        tile: { x: 2, y: 3 },
        terrain: 'ore',
        minedAmount: 4,
        resourceReachable: true,
        territoryOwner: undefined,
        playerId: 'player',
        placementValid: false,
        building: undefined,
        threat: undefined,
      }),
    ).toEqual(expect.arrayContaining(['Resource remaining: 6/10', 'Reachable for gathering']));
    expect(
      tileHoverLines({
        tile: { x: 2, y: 3 },
        terrain: 'wood',
        minedAmount: 99,
        resourceReachable: false,
        territoryOwner: undefined,
        playerId: 'player',
        placementValid: false,
        building: undefined,
        threat: undefined,
      }),
    ).toEqual(expect.arrayContaining(['Resource remaining: 0/10', 'Out of gathering range']));
  });

  it('uses the authoritative plot-center gathering range', () => {
    const plot = { x: 10, y: 20, size: 8 };
    expect(resourceIsReachable({ x: 22, y: 24 }, plot)).toBe(true);
    expect(resourceIsReachable({ x: 23, y: 24 }, plot)).toBe(false);
    expect(resourceIsReachable({ x: 14, y: 24 }, undefined)).toBe(false);
  });

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
