import { describe, expect, it } from 'vitest';
import {
  borderSides,
  cameraOrigin,
  entityAtTile,
  initialCameraFocus,
  logisticsStatusColor,
  productionRateLabel,
  resourceDecorationSprite,
  resourceIsReachable,
  tileHoverLines,
  tileLayers,
  tileNoise,
  tileShade,
  visibleByIsometricDepth,
  visibleChunkCoordinates,
  visibleRenderChunks,
  visibleTileBounds,
} from './WorldCanvas.js';
import { spriteFrames } from './render-assets.js';

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

  it('varies terrain shading deterministically inside each terrain palette', () => {
    expect(tileNoise(3, -4)).toBe(tileNoise(3, -4));
    expect(tileNoise(3, -4)).not.toBe(tileNoise(-4, 3));
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [7, -3],
      [-12, 40],
    ] as const) {
      expect(tileShade('grass', x, y)).toBe(tileShade('grass', x, y));
      expect(tileShade('grass', x, y)).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Neighbouring tiles must not repeat one alternating pair, which reads as a checkerboard.
    const row = Array.from({ length: 24 }, (_, index) => tileShade('grass', index, 0));
    expect(new Set(row).size).toBeGreaterThan(2);
    // Terrains stay visually distinct even before their clutter is drawn.
    expect(tileShade('water', 2, 2)).not.toBe(tileShade('grass', 2, 2));
    expect(tileShade(undefined, 2, 2)).not.toBe(tileShade('grass', 2, 2));
  });

  it('insets ponds and outcrops so they are surfaces on the ground, not swapped tiles', () => {
    const grass = tileLayers('grass', 4, 4);
    expect(grass.patch).toBeUndefined();
    expect(grass.base).toBe(tileShade('grass', 4, 4));

    const water = tileLayers('water', 4, 4);
    // A ring of bank stays visible around the pond, and the pond has a lighter centre.
    expect(water.base).not.toBe(water.patch?.fill);
    expect(water.patch?.fill).toBe(tileShade('water', 4, 4));
    expect(water.patch?.inset).toBeGreaterThan(0);
    expect(water.patch?.sheen).toBeDefined();

    for (const terrain of ['ore', 'wood'] as const) {
      const deposit = tileLayers(terrain, 4, 4);
      expect(deposit.base).toBe(tileShade('grass', 4, 4));
      expect(deposit.patch?.fill).toBe(tileShade(terrain, 4, 4));
      expect(deposit.patch?.sheen).toBeUndefined();
    }
    expect(tileLayers(undefined, 4, 4)).toEqual({ base: tileShade(undefined, 4, 4) });
  });

  it('shows remaining deposit yield through the drawn clutter', () => {
    expect(resourceDecorationSprite('ore', 0)).toBe('ore-node');
    expect(resourceDecorationSprite('ore', 4)).toBe('ore-node');
    expect(resourceDecorationSprite('ore', 5)).toBe('ore-node-low');
    expect(resourceDecorationSprite('ore', 9)).toBe('ore-node-low');
    expect(resourceDecorationSprite('ore', 10)).toBe('ore-node-spent');
    expect(resourceDecorationSprite('ore', 99)).toBe('ore-node-spent');
    expect(resourceDecorationSprite('wood', 0)).toBe('timber-node');
    expect(resourceDecorationSprite('wood', 6)).toBe('timber-node-low');
    expect(resourceDecorationSprite('wood', 10)).toBe('timber-node-spent');
    expect(resourceDecorationSprite('grass', 0)).toBeUndefined();
    expect(resourceDecorationSprite(undefined, 0)).toBeUndefined();
    for (const sprite of [
      'ore-node',
      'ore-node-low',
      'ore-node-spent',
      'timber-node',
      'timber-node-low',
      'timber-node-spent',
    ] as const)
      expect(spriteFrames[sprite]).toBeDefined();
  });

  it('outlines only the sides where a region meets a different owner', () => {
    const owners: Record<string, string> = { '0:0': 'player', '1:0': 'player', '0:1': 'rival' };
    const ownerAt = (x: number, y: number) => owners[`${x}:${y}`];
    // The eastern neighbour shares an owner, so that side stays open.
    expect(borderSides(0, 0, ownerAt)).toEqual(['south-west', 'north-west', 'north-east']);
    expect(borderSides(1, 0, ownerAt)).toEqual(['south-east', 'south-west', 'north-east']);
    expect(borderSides(0, 1, ownerAt)).toEqual([
      'south-east',
      'south-west',
      'north-west',
      'north-east',
    ]);
    // Unowned tiles contribute no border at all.
    expect(borderSides(5, 5, ownerAt)).toEqual([]);
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
