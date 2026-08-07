import { describe, expect, it } from 'vitest';
import {
  buildings as buildingDefinitions,
  buildingUpgrades,
  CONTENT_VERSION,
  extractors,
  recipes,
  renewers,
  resources,
  terrainRules,
  worldRetention,
} from '@kings/content';
import { findPath } from '@kings/pathfinding';
import {
  applyCommand,
  advanceTick,
  chunkCoordinate,
  chunkCoordinateFor,
  buildingId as toBuildingId,
  createWorld as createWorldWithSeed,
  deserializeWorld,
  FixedStepRunner,
  diffWorld,
  elevationAt,
  extractableTile,
  indexEntitiesByChunk,
  inspectWorld,
  isOpenTile,
  joinPlayer,
  landmarkAtChunk,
  MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER,
  nearestOreTile,
  nearestResourceTile,
  neighboringChunks,
  nextRandom,
  playerId as toPlayerId,
  recipeTicksFor,
  runBotScenario,
  runInfrastructureStressScenario,
  profileInfrastructureStressScenario,
  stateHash,
  terrainAt,
  TICK_PIPELINE,
  tick,
  tileCoordinate,
  worldId,
} from '../src/index.js';

/**
 * These fixtures address tiles by absolute coordinate and expect player-a to take the
 * first radial plot candidate, the 8x8 at (12, 0), then walk outward along +x for the
 * exploration and territory cases. Terrain decides which candidates are settleable, so
 * the suite pins a seed whose first candidate is clear ground. Re-deriving every
 * coordinate from wherever a plot lands would also mean recomputing the chunk keys the
 * assertions name, which would obscure what each case is actually checking.
 */
const TEST_SEED = 117;
const createWorld = (seed = TEST_SEED, peaceful = true) => createWorldWithSeed(seed, peaceful);

/** Written out rather than imported so a fixture states every stack it expects to exist. */
const emptyInventoryFixture = () => ({
  ore: 0,
  wood: 0,
  stone: 0,
  ingot: 0,
  brick: 0,
  tool: 0,
});

const oreTileFor = (world: ReturnType<typeof createWorld>, playerId = 'player-a') => {
  const player = world.players[playerId]!;
  const tile = nearestOreTile(
    world.seed,
    player.plot.x + Math.floor(player.plot.size / 2),
    player.plot.y + Math.floor(player.plot.size / 2),
    8,
  );
  if (!tile) throw new Error(`Expected a nearby ore deposit for ${playerId}`);
  return tile;
};

/** Places an extractor on the first accepted plot tile outside `reserved`, and returns it. */
const placeExtractor = (
  world: ReturnType<typeof createWorld>,
  type: 'placeMine' | 'placeLumberCamp',
  sequence: number,
  reserved: readonly { x: number; y: number }[] = [],
  playerId = 'player-a',
) => {
  const plot = world.players[playerId]!.plot;
  for (let x = plot.x; x < plot.x + plot.size; x += 1)
    for (let y = plot.y; y < plot.y + plot.size; y += 1) {
      if (reserved.some((tile) => tile.x === x && tile.y === y)) continue;
      const outcome = applyCommand(world, {
        id: `${type}-${x}-${y}`,
        playerId: toPlayerId(playerId),
        sequence,
        type,
        x,
        y,
      });
      if (outcome.result.accepted)
        return { building: Object.values(world.buildings).at(-1)!, x, y, outcome };
    }
  throw new Error(`No accepted ${type} site inside the plot of ${playerId}`);
};

describe('world simulation', () => {
  it('raises only mountains and keeps every other tile at ground level', () => {
    for (const seed of [1, 47, 20260719]) {
      let mountains = 0;
      let open = 0;
      const levels = new Set<number>();
      for (let x = -40; x < 40; x += 1)
        for (let y = -40; y < 40; y += 1) {
          const terrain = terrainAt(seed, x, y);
          const level = elevationAt(seed, x, y);
          // Elevation and mountain terrain are one fact expressed two ways.
          expect(level > 0).toBe(terrain === 'mountain');
          expect(level).toBeLessThanOrEqual(terrainRules.mountain.maxLevel);
          expect(Number.isInteger(level)).toBe(true);
          expect(isOpenTile(seed, x, y)).toBe(terrain !== 'water' && terrain !== 'mountain');
          if (terrain === 'mountain') {
            mountains += 1;
            levels.add(level);
          } else open += 1;
          // Deposits are never buried, so a sector always keeps its ore and timber.
          if (terrain === 'ore' || terrain === 'wood') expect(level).toBe(0);
        }
      // Ranges are a real feature of the landscape without walling the world off.
      const share = mountains / (mountains + open);
      expect(share).toBeGreaterThan(0.05);
      expect(share).toBeLessThan(0.3);
      expect(levels.size).toBeGreaterThan(1);
    }
  });

  it('gives every starter plot enough open ground and a grassland center', () => {
    for (const seed of [1, 47, 99, 117, 20260719]) {
      const world = createWorld(seed);
      for (let index = 0; index < 8; index += 1) {
        joinPlayer(world, `player-${index}`);
        const plot = world.players[`player-${index}`]!.plot;
        let open = 0;
        for (let x = plot.x; x < plot.x + plot.size; x += 1)
          for (let y = plot.y; y < plot.y + plot.size; y += 1)
            if (isOpenTile(world.seed, x, y)) open += 1;
        expect(open).toBeGreaterThanOrEqual(plot.size ** 2 * 0.875);
        const center = world.buildings[`center-player-${index}`]!;
        expect(terrainAt(world.seed, center.x, center.y)).toBe('grass');
      }
      expect(inspectWorld(world)).toEqual([]);
    }
  });

  it('refuses construction and scout movement on mountains', () => {
    const world = createWorld(47);
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 40;
    // A protected plot is nearly clear ground, so claim the sector holding a nearby range.
    const mountain = (() => {
      for (let x = player.plot.x - 16; x < player.plot.x + player.plot.size + 16; x += 1)
        for (let y = player.plot.y - 16; y < player.plot.y + player.plot.size + 16; y += 1)
          if (terrainAt(world.seed, x, y) === 'mountain') return { x, y };
      return undefined;
    })();
    if (!mountain) throw new Error('Expected a mountain range near the seeded starter plot');
    player.territoryCells[`${Math.floor(mountain.x / 8)}:${Math.floor(mountain.y / 8)}`] = true;

    expect(
      applyCommand(world, {
        id: 'build-on-mountain',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeStorage',
        ...mountain,
      }).result,
    ).toMatchObject({ accepted: false, code: 'tile-not-buildable' });
    expect(player.inventory.wood).toBe(40);

    const scout = Object.values(world.scouts ?? {}).find((entry) => entry.ownerId === 'player-a')!;
    expect(
      applyCommand(world, {
        id: 'scout-mountain',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'moveScout',
        scoutId: scout.id,
        ...mountain,
      }).result,
    ).toMatchObject({ code: 'tile-not-buildable' });
    expect(inspectWorld(world)).toEqual([]);
  });

  it('publishes the deterministic tick pipeline order', () => {
    expect(TICK_PIPELINE).toEqual([
      'advance-clock',
      'research-and-population',
      'construction-and-production',
      'environmental-events',
      'logistics',
      'threat-spawning',
      'threat-navigation-and-combat',
      'emit-events-and-mark-changes',
    ]);
  });

  it('reclaims an abandoned solo starter reservation and makes its plot reusable', () => {
    const world = createWorld(99);
    joinPlayer(world, 'player-a');
    const originalPlot = structuredClone(world.players['player-a']!.plot);
    const expiry = world.onboardingReservations['player-a']!.expiresTick;
    world.tick = expiry - 1;

    expect(advanceTick(world)).toContainEqual({
      type: 'onboardingReservationReclaimed',
      playerId: 'player-a',
    });
    expect(world.players['player-a']).toBeUndefined();
    expect(world.settlements['settlement-player-a']).toBeUndefined();
    expect(Object.values(world.buildings).some(({ ownerId }) => ownerId === 'player-a')).toBe(
      false,
    );
    expect(world.deletedPlayers['player-a']).toMatchObject({
      id: 'player-a',
      deletedTick: expiry,
      reason: 'abandoned-onboarding',
    });

    joinPlayer(world, 'player-b');
    expect(world.players['player-b']?.plot).toEqual(originalPlot);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('extends an active starter lease and permanently secures it with a completed smelter', () => {
    const world = createWorld(99);
    joinPlayer(world, 'player-a');
    const initialExpiry = world.onboardingReservations['player-a']!.expiresTick;
    world.tick = initialExpiry - 1;
    const gathered = applyCommand(world, {
      id: 'active-onboarding',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'gather',
      ...oreTileFor(world),
    });
    expect(gathered.result.accepted).toBe(true);
    expect(world.onboardingReservations['player-a']!.expiresTick).toBeGreaterThan(initialExpiry);

    const center = world.buildings['center-player-a']!;
    world.buildings['smelter-player-a-test'] = {
      ...structuredClone(center),
      id: toBuildingId('smelter-player-a-test'),
      kind: 'smelter',
      x: center.x - 1,
      recipeId: 'smelt-ore',
    };
    advanceTick(world);
    const reservation = world.onboardingReservations['player-a']!;
    expect(reservation.securedTick).toBe(world.tick);
    world.tick = reservation.expiresTick;
    advanceTick(world);
    expect(world.players['player-a']).toBeDefined();
    expect(inspectWorld(world)).toEqual([]);
  });

  it('secures rather than reclaims starter reservations that became cooperative', () => {
    const world = createWorld(99);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    world.settlements['settlement-player-a']!.members['player-b'] = 'member';
    world.tick = world.onboardingReservations['player-a']!.expiresTick - 1;

    advanceTick(world);

    expect(world.players['player-a']).toBeDefined();
    expect(world.onboardingReservations['player-a']?.securedTick).toBe(world.tick);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('reports changed entities and both chunks when an entity moves or is removed', () => {
    const before = createWorld();
    joinPlayer(before, 'player-a');
    const centerId = 'center-player-a';
    const moved = structuredClone(before);
    moved.buildings[centerId]!.x = 0;
    const movedChanges = diffWorld(before, moved);
    expect(movedChanges.buildings).toEqual([centerId]);
    expect(movedChanges.chunks).toEqual(['0:0', '1:0']);

    const removed = structuredClone(moved);
    delete removed.buildings[centerId];
    const removedChanges = diffWorld(moved, removed);
    expect(removedChanges.buildings).toEqual([centerId]);
    expect(removedChanges.chunks).toEqual(['0:0']);
  });

  it('reports player and mined-resource changes in their affected chunks', () => {
    const before = createWorld();
    joinPlayer(before, 'player-a');
    const after = structuredClone(before);
    const ore = oreTileFor(after);
    expect(
      applyCommand(after, {
        id: 'gather-dirty',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...ore,
      }).result.accepted,
    ).toBe(true);
    const changes = diffWorld(before, after);
    expect(changes.players).toEqual(['player-a']);
    expect(changes.minedTiles).toEqual([`${ore.x}:${ore.y}`]);
    expect(changes.chunks).toContain(`${Math.floor(ore.x / 16)}:${Math.floor(ore.y / 16)}`);
    expect(changes.world).toBe(true);
  });

  it('reports road changes in their affected persistence chunk', () => {
    const before = createWorld();
    joinPlayer(before, 'player-a');
    const after = structuredClone(before);
    after.roads['14:0'] = toPlayerId('player-a');
    const changes = diffWorld(before, after);
    expect(changes.roads).toEqual(['14:0']);
    expect(changes.chunks).toContain('0:0');
  });

  it('allocates buildable, non-overlapping settlement plots in the shared world', () => {
    const world = createWorld(99);
    for (let index = 0; index < 64; index += 1) joinPlayer(world, `player-${index}`);
    const plots = Object.values(world.players).map((player) => player.plot);
    for (const [index, plot] of plots.entries()) {
      const center = world.buildings[`center-player-${index}`]!;
      expect(terrainAt(world.seed, center.x, center.y)).toBe('grass');
      expect(plot.x).toBeLessThanOrEqual(center.x);
      expect(plot.y).toBeLessThanOrEqual(center.y);
      for (const other of plots.slice(index + 1))
        expect(
          plot.x < other.x + other.size &&
            plot.x + plot.size > other.x &&
            plot.y < other.y + other.size &&
            plot.y + plot.size > other.y,
        ).toBe(false);
    }
  });

  it('creates branded world, tick, chunk, and tile identifiers from validated values', () => {
    expect(worldId('global-world')).toBe('global-world');
    expect(tick(42)).toBe(42);
    expect(chunkCoordinate(-2, 3)).toEqual([-2, 3]);
    expect(tileCoordinate(12, -5)).toEqual([12, -5]);
    expect(() => tileCoordinate(0.5, 0)).toThrow('Tile coordinates must be safe integers.');
  });

  it('indexes entities and cardinal neighbors by deterministic chunk address', () => {
    expect(chunkCoordinateFor(-1, 16)).toEqual([-1, 1]);
    expect(neighboringChunks(chunkCoordinate(0, 0))).toEqual([
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
    expect(
      indexEntitiesByChunk([
        { id: 'threat-b', x: 17, y: 0 },
        { id: 'building-a', x: 0, y: 0 },
        { id: 'threat-a', x: 18, y: 2 },
      ]),
    ).toEqual({ '0:0': ['building-a'], '1:0': ['threat-a', 'threat-b'] });
  });

  it('replays identical commands to an identical hash', () => {
    const run = () => {
      const world = createWorld(99);
      joinPlayer(world, 'player-a');
      applyCommand(world, {
        id: 'gather-1',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...oreTileFor(world),
      });
      applyCommand(world, {
        id: 'build-1',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      });
      for (let index = 0; index < 10; index += 1) advanceTick(world);
      return stateHash(world);
    };
    expect(run()).toBe(run());
  });

  it('keeps production results and replay hashes independent of building registry insertion order', () => {
    const first = createWorld(99);
    joinPlayer(first, 'player-a');
    applyCommand(first, {
      id: 'storage',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeStorage',
      x: 12,
      y: 0,
    });
    applyCommand(first, {
      id: 'housing',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'placeHousing',
      x: 13,
      y: 0,
    });
    const reordered = structuredClone(first);
    reordered.buildings = Object.fromEntries(Object.entries(reordered.buildings).reverse());
    expect(stateHash(reordered)).toBe(stateHash(first));
    for (let index = 0; index < 5; index += 1) {
      expect(advanceTick(reordered)).toEqual(advanceTick(first));
      expect(stateHash(reordered)).toBe(stateHash(first));
    }
  });

  it('advances simulation only in fixed whole steps and bounds catch-up work', () => {
    const world = createWorld();
    const runner = new FixedStepRunner(100, 2);
    expect(runner.advance(250, () => advanceTick(world))).toBe(2);
    expect(world.tick).toBe(2);
    expect(runner.remainingMs).toBe(50);
    expect(runner.advance(50, () => advanceTick(world))).toBe(1);
    expect(world.tick).toBe(3);
    expect(runner.advance(1_000, () => advanceTick(world))).toBe(2);
    expect(world.tick).toBe(5);
    expect(runner.remainingMs).toBe(0);
  });

  it('serializes and restores the deterministic random generator state', () => {
    const world = createWorld(99);
    const [nextState, first] = nextRandom(world.randomState);
    world.randomState = nextState;
    const restored = deserializeWorld(JSON.parse(JSON.stringify(world)));
    const [, resumed] = nextRandom(restored.randomState);
    expect(resumed).toBeCloseTo(nextRandom(nextState)[1]);
    expect(first).not.toBe(resumed);
  });

  it('rejects duplicate commands without mutation', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const command = {
      id: 'gather-1',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'gather' as const,
      ...oreTileFor(world),
    };
    expect(applyCommand(world, command).result.accepted).toBe(true);
    const hash = stateHash(world);
    expect(applyCommand(world, command).result).toMatchObject({
      accepted: false,
      code: 'duplicate-command',
    });
    expect(stateHash(world)).toBe(hash);
  });

  it('rejects non-integer simulation inputs without mutating deterministic state', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const before = stateHash(world);
    expect(
      applyCommand(world, {
        id: 'fractional-gather',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        x: 0.5,
        y: 0,
      }).result,
    ).toMatchObject({ accepted: false, code: 'invalid-coordinate' });
    expect(
      applyCommand(world, {
        id: 'fractional-sequence',
        playerId: toPlayerId('player-a'),
        sequence: 1.5,
        type: 'gather',
        ...oreTileFor(world),
      }).result,
    ).toMatchObject({ accepted: false, code: 'out-of-order-command' });
    expect(stateHash(world)).toBe(before);
  });

  it('enforces construction before a smelter can produce', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'build',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    expect(smelter.productionState).toBe('constructing');
    expect(
      applyCommand(world, {
        id: 'smelt-early',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'smelt',
        buildingId: smelter.id,
      }).result,
    ).toMatchObject({ code: 'construction-incomplete' });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    advanceTick(world);
    expect(smelter.productionState).toBe('blocked-input');
    applyCommand(world, {
      id: 'gather',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'gather',
      ...oreTileFor(world),
    });
    expect(
      applyCommand(world, {
        id: 'load-ore',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'transfer',
        buildingId: smelter.id,
        item: 'ore',
        amount: 1,
        direction: 'toBuilding',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'smelt',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'smelt',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(smelter.productionState).toBe('working');
    for (let index = 0; index < 3; index += 1) advanceTick(world);
    expect(world.buildings[smelter.id]?.inventory.ingot).toBe(1);
  });

  it('reserves construction costs, then needs an assigned worker to deliver them', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'build-delivered-smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    expect(world.players['player-a']?.inventory.wood).toBe(2);
    expect(smelter.constructionMaterials).toEqual({
      ore: 0,
      wood: 3,
      stone: 0,
      ingot: 0,
      brick: 0,
      tool: 0,
    });
    world.players['player-a']!.population.total = 0;
    advanceTick(world);
    expect(smelter).toMatchObject({ constructionTicks: 10, constructionMaterials: { wood: 3 } });
    world.players['player-a']!.population.total = 1;
    advanceTick(world);
    expect(smelter).toMatchObject({ constructionTicks: 9, constructionMaterials: { wood: 2 } });
    expect(world.players['player-a']?.population).toMatchObject({ employed: 1, unemployed: 0 });
  });

  it('bounds active construction commands per player before allocating more entities', () => {
    const world = createWorld(99);
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    for (let index = 0; index < MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER; index += 1)
      world.buildings[`queued-${index}`] = {
        ...structuredClone(center),
        id: toBuildingId(`queued-${index}`),
        x: 1_000 + index,
        constructionTicks: 1,
        productionState: 'constructing',
      };

    expect(
      applyCommand(world, {
        id: 'construction-over-limit',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeStorage',
        x: 12,
        y: 0,
      }).result,
    ).toMatchObject({ accepted: false, code: 'construction-limit-reached' });
    expect(Object.keys(world.buildings)).toHaveLength(MAX_ACTIVE_CONSTRUCTIONS_PER_PLAYER + 1);
  });

  it('generates deterministic terrain', () => {
    expect(terrainAt(9, 24, -4)).toBe(terrainAt(9, 24, -4));
  });

  it('allows gathering only from deterministic ore deposits', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    const grass = Array.from({ length: 17 }, (_, index) => index - 8)
      .flatMap((offsetX) =>
        Array.from({ length: 17 }, (_, index) => index - 8).map((offsetY) => ({
          x: player.plot.x + Math.floor(player.plot.size / 2) + offsetX,
          y: player.plot.y + Math.floor(player.plot.size / 2) + offsetY,
          distance: Math.abs(offsetX) + Math.abs(offsetY),
        })),
      )
      .find((tile) => tile.distance <= 8 && terrainAt(world.seed, tile.x, tile.y) === 'grass')!;
    const grassTile = { x: grass.x, y: grass.y };
    expect(
      applyCommand(world, {
        id: 'gather-grass',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...grassTile,
      }).result,
    ).toMatchObject({ code: 'resource-depleted' });
    expect(
      applyCommand(world, {
        id: 'gather-ore',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...oreTileFor(world),
      }).result.accepted,
    ).toBe(true);
    const woodTile = nearestResourceTile(
      world.seed,
      player.plot.x + Math.floor(player.plot.size / 2),
      player.plot.y + Math.floor(player.plot.size / 2),
      8,
      'wood',
    )!;
    expect(
      applyCommand(world, {
        id: 'gather-wood',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'gather',
        ...woodTile,
      }).result.accepted,
    ).toBe(true);
    expect(world.players['player-a']?.inventory).toMatchObject({ ore: 1, wood: 6 });
  });

  it('moves items between player and building inventories without duplication', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'build',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    applyCommand(world, {
      id: 'gather',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'gather',
      ...oreTileFor(world),
    });
    applyCommand(world, {
      id: 'load',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'transfer',
      buildingId: smelter.id,
      item: 'ore',
      amount: 1,
      direction: 'toBuilding',
    });
    expect(world.players['player-a']?.inventory.ore).toBe(0);
    expect(smelter.inventory.ore).toBe(1);
    for (let index = 0; index < 4; index += 1) advanceTick(world);
    expect(smelter.inventory.ingot).toBe(1);
    applyCommand(world, {
      id: 'unload',
      playerId: toPlayerId('player-a'),
      sequence: 4,
      type: 'transfer',
      buildingId: smelter.id,
      item: 'ingot',
      amount: 1,
      direction: 'toPlayer',
    });
    expect(world.players['player-a']?.inventory.ingot).toBe(1);
    expect(smelter.inventory.ingot).toBe(0);
  });

  it('queues bounded gathering work without duplicating deposit yield', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    const ore = oreTileFor(world);
    expect(
      applyCommand(world, {
        id: 'gather-five',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...ore,
        amount: 5,
      }).result.accepted,
    ).toBe(true);
    expect(player.inventory.ore).toBe(1);
    expect(player.gatherOrder).toMatchObject({ item: 'ore', remaining: 4 });
    for (let index = 0; index < 6; index += 1) advanceTick(world);
    expect(player.inventory.ore).toBe(3);
    expect(world.minedTiles[`${ore.x}:${ore.y}`]).toBe(3);
    expect(player.population.employed).toBe(1);
    expect(
      applyCommand(world, {
        id: 'cancel-gathering',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'cancelGatherOrder',
      }).result.accepted,
    ).toBe(true);
    expect(player.gatherOrder).toBeUndefined();
    expect(inspectWorld(world)).toEqual([]);
  });

  it('upgrades version 2 snapshots with empty building inventories', () => {
    const legacy = createWorld() as unknown as {
      schemaVersion: 2;
      buildings: Record<string, Record<string, unknown>>;
    };
    legacy.schemaVersion = 2;
    legacy.buildings.center = {
      id: 'center',
      kind: 'settlement-center',
      ownerId: 'player-a',
      x: 0,
      y: 0,
      health: 1,
      maxHealth: 1,
      progress: 0,
      constructionTicks: 0,
    };
    expect(deserializeWorld(legacy).buildings.center?.inventory).toEqual(emptyInventoryFixture());
  });

  it('upgrades version 11 inventories with an empty tool stack', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const legacy = structuredClone(world) as unknown as {
      schemaVersion: 11;
      players: Record<
        string,
        { inventory: { ore: number; wood: number; ingot: number; tool?: number } }
      >;
      buildings: Record<
        string,
        { inventory: { ore: number; wood: number; ingot: number; tool?: number } }
      >;
    };
    legacy.schemaVersion = 11;
    for (const player of Object.values(legacy.players)) delete player.inventory.tool;
    for (const building of Object.values(legacy.buildings)) delete building.inventory.tool;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.players['player-a']?.inventory.tool).toBe(0);
    expect(migrated.buildings['center-player-a']?.inventory.tool).toBe(0);
  });

  it('upgrades version 14 snapshots with a deterministic random state', () => {
    const legacy = createWorld(27) as unknown as { schemaVersion: 14; randomState?: number };
    legacy.schemaVersion = 14;
    delete legacy.randomState;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.randomState).toBeGreaterThan(0);
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('upgrades version 15 logistics links with normal transfer priority', () => {
    const world = createWorld(27);
    joinPlayer(world, 'player-a');
    const legacy = structuredClone(world) as unknown as {
      schemaVersion: 15;
      logisticsLinks: Record<
        string,
        {
          id: string;
          ownerId: string;
          sourceBuildingId: string;
          targetBuildingId: string;
          item: 'ore';
        }
      >;
    };
    legacy.schemaVersion = 15;
    legacy.logisticsLinks = {
      legacy: {
        id: 'legacy',
        ownerId: 'player-a',
        sourceBuildingId: 'center-player-a',
        targetBuildingId: 'center-player-a',
        item: 'ore',
      },
    };
    expect(deserializeWorld(legacy).logisticsLinks.legacy?.priority).toBe(1);
  });

  it('upgrades version 16 producer snapshots with their configured default recipes', () => {
    const world = createWorld(27);
    joinPlayer(world, 'player-a');
    world.buildings['legacy-workshop'] = {
      ...world.buildings['center-player-a']!,
      id: toBuildingId('legacy-workshop'),
      kind: 'workshop',
      x: world.buildings['center-player-a']!.x + 1,
      recipeId: 'forge-tool',
    };
    const legacy = structuredClone(world) as unknown as {
      schemaVersion: 16;
      buildings: Record<string, { recipeId?: string }>;
    };
    legacy.schemaVersion = 16;
    for (const building of Object.values(legacy.buildings)) delete building.recipeId;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.buildings['center-player-a']?.recipeId).toBeNull();
    expect(
      Object.values(migrated.buildings).find((building) => building.kind === 'workshop')?.recipeId,
    ).toBe('forge-tool');
  });

  it('upgrades version 17 snapshots with machine and logistics flow states', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const legacy = structuredClone(world) as unknown as {
      schemaVersion: 17;
      buildings: Record<string, { productionState?: string }>;
      logisticsLinks: Record<
        string,
        {
          id: string;
          ownerId: string;
          sourceBuildingId: string;
          targetBuildingId: string;
          item: 'ore';
          priority: 1;
          capacityPerTrip?: number;
          status?: string;
        }
      >;
    };
    legacy.schemaVersion = 17;
    for (const building of Object.values(legacy.buildings)) delete building.productionState;
    legacy.logisticsLinks.legacy = {
      id: 'legacy',
      ownerId: 'player-a',
      sourceBuildingId: 'center-player-a',
      targetBuildingId: 'center-player-a',
      item: 'ore',
      priority: 1,
    };
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.buildings['center-player-a']?.productionState).toBe('idle');
    expect(migrated.logisticsLinks.legacy).toMatchObject({
      capacityPerTrip: 4,
      status: 'idle',
    });
  });

  it('upgrades version 18 snapshots with empty construction delivery state', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const legacy = structuredClone(world) as {
      schemaVersion: number;
      buildings: Record<string, { constructionMaterials?: unknown }>;
    };
    legacy.schemaVersion = 18;
    for (const building of Object.values(legacy.buildings)) delete building.constructionMaterials;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.buildings['center-player-a']?.constructionMaterials).toEqual(
      emptyInventoryFixture(),
    );
  });

  it('migrates version 12 mined-tile depletion onto deterministic ore deposits', () => {
    const world = createWorld();
    const legacy = structuredClone(world) as unknown as {
      schemaVersion: 12;
      seed: number;
      minedTiles: Record<string, number>;
    };
    legacy.schemaVersion = 12;
    legacy.minedTiles = { '12:0': 3 };
    const node = nearestOreTile(legacy.seed, 12, 0, 16)!;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.minedTiles[`${node.x}:${node.y}`]).toBe(3);
  });

  it('migrates version 20 worlds with a fresh cooperative objective ledger', () => {
    const current = createWorld(19);
    const { cooperativeObjectives: _objectives, playerActivity: _activity, ...legacy } = current;
    void _objectives;
    void _activity;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 20 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.cooperativeObjectives['frontier-beacon']).toMatchObject({
      totalContributed: 0,
      completedTick: null,
      contributionsByPlayer: {},
      rewardClaims: {},
    });
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 21 worlds with deterministic new-player threat protection', () => {
    const current = createWorld(23);
    joinPlayer(current, 'player-a');
    current.tick = 41;
    const { playerActivity: _activity, sharedConstructionProjects: _projects, ...legacy } = current;
    void _activity;
    void _projects;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 21 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.playerActivity['player-a']).toEqual({
      lastActiveTick: 41,
      raidEligibleTick: 341,
    });
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 22 worlds with an empty shared-construction ledger', () => {
    const current = createWorld(29);
    joinPlayer(current, 'player-a');
    const { sharedConstructionProjects: _projects, ...legacy } = current;
    void _projects;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 22 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.sharedConstructionProjects).toEqual({});
    expect(migrated.playerActivity).toEqual(current.playerActivity);
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 23 worlds with unique default names and empty moderation state', () => {
    const current = createWorld(31);
    joinPlayer(current, 'player-b');
    joinPlayer(current, 'player-a');
    const { social: _social, ...legacy } = current;
    void _social;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 23 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.social).toMatchObject({
      playerNames: { 'player-a': 'Settler 1', 'player-b': 'Settler 2' },
      settlementNames: {
        'settlement-player-a': 'Settlement 1',
        'settlement-player-b': 'Settlement 2',
      },
      messages: [],
      reports: [],
      lastChatTick: {},
    });
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 24 worlds with an empty deleted-player tombstone ledger', () => {
    const current = createWorld(37);
    joinPlayer(current, 'player-a');
    const {
      deletedPlayers: _deletedPlayers,
      onboardingReservations: _onboardingReservations,
      ...legacy
    } = current;
    void _deletedPlayers;
    void _onboardingReservations;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 24 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.deletedPlayers).toEqual({});
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 25 worlds with a fresh bounded starter reservation', () => {
    const current = createWorld(41);
    joinPlayer(current, 'player-a');
    const { onboardingReservations: _onboardingReservations, ...legacy } = current;
    void _onboardingReservations;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 25 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.onboardingReservations['player-a']).toEqual({
      createdTick: 0,
      expiresTick: 36_000,
      securedTick: null,
    });
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('migrates version 26 worlds onto the explicit content version', () => {
    const current = createWorld(43);
    const { contentVersion: _contentVersion, ...legacy } = current;
    void _contentVersion;
    const migrated = deserializeWorld({ ...legacy, schemaVersion: 26 });
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.contentVersion).toBe(CONTENT_VERSION);
  });

  it('migrates version 28 worlds with empty gameplay state for the new systems', () => {
    const current = createWorld(52);
    joinPlayer(current, 'player-a');
    const {
      roads: _roads,
      players: _players,
      schemaVersion: _schemaVersion,
      contentVersion: _contentVersion,
      ...legacyState
    } = current;
    void _roads;
    void _players;
    void _schemaVersion;
    void _contentVersion;
    const legacyPlayers = Object.fromEntries(
      Object.entries(current.players).map(([id, player]) => {
        const { discoveries: _discoveries, research, ...legacyPlayer } = player;
        const {
          engineering: _engineering,
          stewardship: _stewardship,
          ...legacyUnlocked
        } = research.unlocked;
        void _discoveries;
        void _engineering;
        void _stewardship;
        return [id, { ...legacyPlayer, research: { ...research, unlocked: legacyUnlocked } }];
      }),
    );
    const migrated = deserializeWorld({
      ...legacyState,
      schemaVersion: 28,
      contentVersion: 3,
      players: legacyPlayers,
    });
    expect(migrated).toMatchObject({
      schemaVersion: 31,
      contentVersion: CONTENT_VERSION,
      roads: {},
    });
    expect(migrated.players['player-a']).toMatchObject({
      discoveries: {},
      research: { unlocked: { engineering: false, stewardship: false } },
    });
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('rejects a current-schema snapshot written for incompatible content', () => {
    expect(() =>
      deserializeWorld({ ...createWorld(47), contentVersion: CONTENT_VERSION + 1 }),
    ).toThrow(
      `Unsupported world content version: ${CONTENT_VERSION + 1}; expected ${CONTENT_VERSION}`,
    );
  });

  it('rejects a version 27 snapshot written for incompatible content', () => {
    // Each schema pins the content version it was written for, so a version 27 snapshot is
    // measured against content 3 rather than against whatever the world runs now.
    expect(() =>
      deserializeWorld({
        ...createWorld(48),
        schemaVersion: 27,
        contentVersion: CONTENT_VERSION + 1,
      }),
    ).toThrow(`Unsupported world content version: ${CONTENT_VERSION + 1}; expected 3`);
  });

  it('migrates version 29 worlds onto masonry stacks, building tiers, and walking carriers', () => {
    const current = createWorld(53);
    joinPlayer(current, 'player-a');
    const center = current.buildings['center-player-a']!;
    const source = {
      ...center,
      id: toBuildingId('legacy-storage'),
      kind: 'storage' as const,
      x: center.x + 1,
      inventoryCapacity: 200,
      recipeId: null,
    };
    const target = {
      ...center,
      id: toBuildingId('legacy-smelter'),
      kind: 'smelter' as const,
      x: center.x + 2,
      recipeId: 'smelt-ore',
      inventoryCapacity: 20,
      maxHealth: 10,
      health: 10,
    };
    current.buildings[source.id] = source;
    current.buildings[target.id] = target;
    const legacy = {
      ...current,
      schemaVersion: 29,
      contentVersion: 4,
      // Version 29 had no carrier registry, and its links carried a per-tick throughput
      // plus a cooldown standing in for the return journey.
      carriers: undefined,
      players: Object.fromEntries(
        Object.entries(current.players).map(([id, player]) => {
          const { stone: _stone, brick: _brick, ...inventory } = player.inventory;
          void _stone;
          void _brick;
          const { masonry: _masonry, ...unlocked } = player.research.unlocked;
          void _masonry;
          return [id, { ...player, inventory, research: { ...player.research, unlocked } }];
        }),
      ),
      buildings: Object.fromEntries(
        Object.entries(current.buildings).map(([id, building]) => {
          const { tier: _tier, inventory, constructionMaterials, ...rest } = building;
          void _tier;
          const { stone: _inventoryStone, brick: _inventoryBrick, ...legacyInventory } = inventory;
          void _inventoryStone;
          void _inventoryBrick;
          const {
            stone: _materialStone,
            brick: _materialBrick,
            ...legacyMaterials
          } = constructionMaterials;
          void _materialStone;
          void _materialBrick;
          return [
            id,
            { ...rest, inventory: legacyInventory, constructionMaterials: legacyMaterials },
          ];
        }),
      ),
      logisticsLinks: {
        'legacy-link': {
          id: 'legacy-link',
          ownerId: toPlayerId('player-a'),
          sourceBuildingId: source.id,
          targetBuildingId: target.id,
          item: 'ore' as const,
          priority: 1 as const,
          throughputPerTick: 1,
          carrierId: 'carrier-legacy-link',
          routeDistance: 0,
          travelTicksRemaining: 3,
          status: 'in-transit' as const,
        },
      },
    };
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.contentVersion).toBe(CONTENT_VERSION);
    expect(migrated.carriers).toEqual({});
    expect(migrated.players['player-a']).toMatchObject({
      inventory: { stone: 0, brick: 0 },
      research: { unlocked: { masonry: false } },
    });
    expect(migrated.buildings[target.id]).toMatchObject({ tier: 1, inventory: { stone: 0 } });
    const link = migrated.logisticsLinks['legacy-link']!;
    expect(link.capacityPerTrip).toBe(4);
    expect(link).not.toHaveProperty('throughputPerTick');
    expect(link).not.toHaveProperty('travelTicksRemaining');
    // The route is left unplanned so the first tick surveys it under the shared budget.
    expect(link.route).toBeUndefined();
    advanceTick(migrated);
    expect(migrated.logisticsLinks['legacy-link']?.route).toEqual([target.x, target.y]);
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('trims version 27 idempotency and transfer ledgers onto their retention windows', () => {
    const legacy = {
      ...createWorld(49),
      schemaVersion: 27,
      contentVersion: 3,
      processedCommands: Array.from(
        { length: worldRetention.processedCommands + 25 },
        (_, index) => `command-${index}`,
      ),
    };
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.processedCommands).toHaveLength(worldRetention.processedCommands);
    expect(migrated.processedCommands.at(0)).toBe('command-25');
    expect(migrated.processedCommands.at(-1)).toBe(
      `command-${worldRetention.processedCommands + 24}`,
    );
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('keeps the idempotency window bounded while still rejecting in-flight retries', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const issue = (sequence: number) =>
      applyCommand(world, {
        id: `command-${sequence}`,
        playerId: toPlayerId('player-a'),
        sequence,
        type: 'explore',
        x: sequence % 32,
        y: 0,
      }).result;
    const total = worldRetention.processedCommands + 50;
    for (let sequence = 1; sequence <= total; sequence += 1)
      expect(issue(sequence).accepted).toBe(true);
    expect(world.processedCommands).toHaveLength(worldRetention.processedCommands);
    expect(world.processedCommands.at(-1)).toBe(`command-${total}`);
    // A retry still inside the window is rejected as a duplicate.
    expect(issue(total)).toEqual({
      accepted: false,
      commandId: `command-${total}`,
      code: 'duplicate-command',
    });
    // A retry that has aged out of the window is still rejected, by sequence.
    expect(issue(1)).toEqual({
      accepted: false,
      commandId: 'command-1',
      code: 'out-of-order-command',
    });
    expect(inspectWorld(world)).toEqual([]);
  });

  it('reports an over-retained idempotency window as an invariant failure', () => {
    const world = createWorld();
    world.processedCommands = Array.from(
      { length: worldRetention.processedCommands + 1 },
      (_, index) => `command-${index}`,
    );
    expect(inspectWorld(world)).toContain(
      'world state retains too many processed command identifiers',
    );
  });

  it('adds settlement capacity and grows aggregated population', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'housing',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeHousing',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 200; index += 1) advanceTick(world);
    expect(world.players['player-a']?.population.capacity).toBe(6);
    expect(world.players['player-a']?.population.total).toBe(3);
  });

  it('loses surplus settlers after a sustained shelter shortage', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.population.total = 3;
    for (let index = 0; index < 200; index += 1) advanceTick(world);
    expect(world.players['player-a']?.population.total).toBe(2);
  });

  it('requires research and exploration before adjacent territory can be claimed', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.ingot = 3;
    world.players['player-a']!.inventory.tool = 2;
    expect(
      applyCommand(world, {
        id: 'research-metal',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'research',
        technologyId: 'metallurgy',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(world.players['player-a']?.research.unlocked.metallurgy).toBe(true);
    expect(
      applyCommand(world, {
        id: 'research-charter',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'research',
        technologyId: 'territorial-charter',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 20; index += 1) advanceTick(world);
    // The starting settlement reveals its own footprint and gather range, so
    // extend to that explored frontier first, then claim just beyond it.
    expect(
      applyCommand(world, {
        id: 'claim-frontier',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'claimTerritory',
        x: 24,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'claim-before-explore',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'claimTerritory',
        x: 32,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'not-explored' });
    applyCommand(world, {
      id: 'explore',
      playerId: toPlayerId('player-a'),
      sequence: 5,
      type: 'explore',
      x: 32,
      y: 0,
    });
    expect(
      applyCommand(world, {
        id: 'claim',
        playerId: toPlayerId('player-a'),
        sequence: 6,
        type: 'claimTerritory',
        x: 32,
        y: 0,
      }).result.accepted,
    ).toBe(true);
  });

  it('tracks historical exploration separately from currently visible settlement chunks', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    expect(player.exploredChunks['3:0']).toBeUndefined();
    expect(player.visibleChunks?.['0:0']).toBe(true);
    expect(
      applyCommand(world, {
        id: 'survey-distant-chunk',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'explore',
        x: 48,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(player.exploredChunks['3:0']).toBe(true);
    expect(player.visibleChunks?.['3:0']).toBeUndefined();
    expect(player.visibleChunks?.['1:0']).toBe(true);
  });

  it('grants each deterministic landmark reward only on its first exploration', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    const plotChunk = chunkCoordinateFor(player.plot.x, player.plot.y);
    let landmark:
      | (NonNullable<ReturnType<typeof landmarkAtChunk>> & { chunkX: number; chunkY: number })
      | undefined;
    for (let offsetX = -3; offsetX <= 3 && !landmark; offsetX += 1)
      for (let offsetY = -3; offsetY <= 3 && !landmark; offsetY += 1) {
        const chunkX = Number(plotChunk[0]) + offsetX;
        const chunkY = Number(plotChunk[1]) + offsetY;
        const worldX = chunkX * 16;
        const worldY = chunkY * 16;
        const plotCenterX = player.plot.x + Math.floor(player.plot.size / 2);
        const plotCenterY = player.plot.y + Math.floor(player.plot.size / 2);
        if (Math.abs(plotCenterX - worldX) + Math.abs(plotCenterY - worldY) > 64) continue;
        const candidate = landmarkAtChunk(world.seed, chunkX, chunkY);
        if (candidate) landmark = { ...candidate, chunkX, chunkY };
      }
    if (!landmark) throw new Error('Expected a landmark within exploration range.');
    const inventoryTotal = () => Object.values(player.inventory).reduce((total, n) => total + n, 0);
    const before = inventoryTotal();
    const first = applyCommand(world, {
      id: 'landmark-first-visit',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'explore',
      x: landmark.chunkX * 16,
      y: landmark.chunkY * 16,
    });
    expect(first.events).toContainEqual({
      type: 'landmarkDiscovered',
      playerId: 'player-a',
      landmarkKind: landmark.kind,
    });
    expect(player.discoveries[`${landmark.chunkX}:${landmark.chunkY}`]?.kind).toBe(landmark.kind);
    expect(inventoryTotal()).toBe(before);
    expect(
      applyCommand(world, {
        id: 'landmark-salvage',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'resolveLandmark',
        x: landmark.x,
        y: landmark.y,
        choice: 'salvage',
      }).result.accepted,
    ).toBe(true);
    expect(inventoryTotal()).toBeGreaterThan(before);
    const afterFirstVisit = inventoryTotal();
    const second = applyCommand(world, {
      id: 'landmark-return-visit',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'explore',
      x: landmark.chunkX * 16,
      y: landmark.chunkY * 16,
    });
    expect(second.events).toEqual([]);
    expect(inventoryTotal()).toBe(afterFirstVisit);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('locks the competing development branch after research completes', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.research.unlocked.metallurgy = true;
    player.inventory.tool = 2;
    expect(
      applyCommand(world, {
        id: 'choose-engineering',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'research',
        technologyId: 'engineering',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 15; index += 1) advanceTick(world);
    expect(player.research.unlocked.engineering).toBe(true);
    expect(
      applyCommand(world, {
        id: 'try-stewardship',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'research',
        technologyId: 'stewardship',
      }).result,
    ).toMatchObject({ code: 'research-branch-locked' });
    expect(player.inventory.tool).toBe(1);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('migrates version 30 worlds onto landmark choices, initiatives, and stock targets', () => {
    const current = createWorld(54);
    joinPlayer(current, 'player-a');
    const legacy = {
      ...current,
      schemaVersion: 30,
      contentVersion: 5,
      players: Object.fromEntries(
        Object.entries(current.players).map(([id, player]) => {
          const { initiative: _initiative, gatherOrder: _gatherOrder, ...retained } = player;
          void _initiative;
          void _gatherOrder;
          return [id, retained];
        }),
      ),
    };
    const migrated = deserializeWorld(legacy);
    expect(migrated).toMatchObject({ schemaVersion: 31, contentVersion: CONTENT_VERSION });
    expect(migrated.players['player-a']?.initiative).toBeNull();
    expect(inspectWorld(migrated)).toEqual([]);
  });

  it('spends mature goods on a timed builders initiative that accelerates construction', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory = { ...emptyInventoryFixture(), wood: 2, tool: 1, brick: 3 };
    expect(
      applyCommand(world, {
        id: 'builders-festival',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'startSettlementInitiative',
        initiativeId: 'builders-festival',
      }).result.accepted,
    ).toBe(true);
    expect(player.inventory).toEqual({ ...emptyInventoryFixture(), wood: 2 });
    expect(
      applyCommand(world, {
        id: 'festival-storage',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeStorage',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    expect(storage.constructionTicks).toBe(5);
    for (let index = 0; index < 3; index += 1) advanceTick(world);
    expect(storage.constructionTicks).toBe(0);
    expect(player.initiative?.id).toBe('builders-festival');
    expect(inspectWorld(world)).toEqual([]);
  });

  it('makes rough resource terrain delay scouts unless a road covers the step', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const scout = world.scouts['scout-player-a']!;
    let route: { x: number; y: number } | undefined;
    for (let x = -32; x <= 32 && !route; x += 1)
      for (let y = -32; y <= 32 && !route; y += 1)
        if (
          ['ore', 'wood'].includes(terrainAt(world.seed, x, y)) &&
          isOpenTile(world.seed, x - 1, y) &&
          isOpenTile(world.seed, x + 1, y)
        )
          route = { x, y };
    if (!route) throw new Error('Expected a short route through rough terrain.');
    scout.x = route.x - 1;
    scout.y = route.y;
    applyCommand(world, {
      id: 'cross-rough-ground',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'moveScout',
      scoutId: scout.id,
      x: route.x + 1,
      y: route.y,
    });
    advanceTick(world);
    expect(scout).toMatchObject({ x: route.x, y: route.y, moveCooldown: 1 });
    advanceTick(world);
    expect(scout).toMatchObject({ x: route.x, y: route.y, moveCooldown: 0 });
    advanceTick(world);
    expect(scout).toMatchObject({ x: route.x + 1, y: route.y });

    scout.x = route.x - 1;
    scout.y = route.y;
    scout.moveCooldown = 0;
    world.roads[`${route.x}:${route.y}`] = toPlayerId('player-a');
    applyCommand(world, {
      id: 'cross-road',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'moveScout',
      scoutId: scout.id,
      x: route.x + 1,
      y: route.y,
    });
    advanceTick(world);
    expect(scout.moveCooldown).toBe(0);
    advanceTick(world);
    expect(scout).toMatchObject({ x: route.x + 1, y: route.y });
  });

  it('moves an owned scout authoritatively and reveals the chunk it reaches', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const scout = world.scouts?.['scout-player-a'];
    if (!scout) throw new Error('Expected player scout.');
    const target = { x: scout.x + 4, y: scout.y };
    expect(
      applyCommand(world, {
        id: 'other-player-scout',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'moveScout',
        scoutId: scout.id,
        ...target,
      }).result,
    ).toMatchObject({ accepted: false, code: 'unauthorized' });
    expect(
      applyCommand(world, {
        id: 'move-own-scout',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'moveScout',
        scoutId: scout.id,
        ...target,
      }).result.accepted,
    ).toBe(true);
    for (let tick = 0; tick < 8; tick += 1) advanceTick(world);
    expect(scout).toMatchObject(target);
    expect(
      world.players['player-a']?.exploredChunks[
        `${Math.floor(target.x / 16)}:${Math.floor(target.y / 16)}`
      ],
    ).toBe(true);
  });

  it('unlocks a workshop that deterministically turns ingots and wood into tools', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 10;
    world.players['player-a']!.inventory.ingot = 1;
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'workshop-too-early',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeWorkshop',
        x: 13,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'technology-locked' });
    expect(
      applyCommand(world, {
        id: 'research',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'research',
        technologyId: 'metallurgy',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'workshop',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'placeWorkshop',
        x: 13,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const workshop = Object.values(world.buildings).find(
      (building) => building.kind === 'workshop',
    )!;
    workshop.inventory.ingot = 1;
    workshop.inventory.wood = 1;
    for (let index = 0; index < 6; index += 1) advanceTick(world);
    expect(workshop.inventory).toMatchObject({ ingot: 0, wood: 0, tool: 1 });
  });

  it('spawns PvE raids against assets and lets watchtowers defeat them automatically', () => {
    const world = createWorld(TEST_SEED, false);
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'tower',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeWatchtower',
        x: 13,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'technology-locked' });
    world.players['player-a']!.inventory.ingot = 1;
    expect(
      applyCommand(world, {
        id: 'research-metallurgy',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'research',
        technologyId: 'metallurgy',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'tower',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'placeWatchtower',
        x: 13,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    let spawnedTick: number | undefined;
    for (let index = 0; index < 360; index += 1) {
      const events = advanceTick(world);
      if (events.some((event) => event.type === 'threatSpawned')) spawnedTick ??= world.tick;
    }
    expect(spawnedTick).toBe(300);
    expect(Object.keys(world.threats)).toHaveLength(0);
    expect(
      Object.values(world.buildings).find((building) => building.kind === 'smelter')?.health,
    ).toBeGreaterThan(0);
  });

  it('defaults to a peaceful world where no PvE raids spawn against valid targets', () => {
    expect(createWorld().peaceful).toBe(true);
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 200; index += 1) advanceTick(world);
    expect(Object.keys(world.threats)).toHaveLength(0);
    expect(
      Object.values(world.buildings).find((building) => building.kind === 'smelter')?.health,
    ).toBeGreaterThan(0);
  });

  it('applies a deterministic acid-rain event to one completed owned building that can be repaired', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 299; index += 1) advanceTick(world);
    const healthBeforeEvent = Object.fromEntries(
      Object.values(world.buildings).map((building) => [building.id, building.health]),
    );
    const events = advanceTick(world);
    const hazard = events.find((event) => event.type === 'hazard');
    expect(hazard).toMatchObject({ environmentalEventId: 'acid-rain' });
    expect(hazard?.buildingId).toBeDefined();
    const damaged = world.buildings[hazard!.buildingId!]!;
    expect(damaged.health).toBe(healthBeforeEvent[damaged.id]! - 1);
    expect(
      applyCommand(world, {
        id: 'repair',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'repair',
        buildingId: damaged.id,
      }).result.accepted,
    ).toBe(true);
    expect(damaged.health).toBe(damaged.maxHealth);
  });

  it('pauses damaged producer work until the building is repaired', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    smelter.health -= 1;
    smelter.progress = 3;
    advanceTick(world);
    expect(smelter.progress).toBe(3);
    expect(
      applyCommand(world, {
        id: 'repair',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'repair',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(smelter.progress).toBe(2);
  });

  it('navigates raiders toward their target before they can deal damage', () => {
    const world = createWorld(TEST_SEED, false);
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 300; index += 1) advanceTick(world);
    const raider = Object.values(world.threats)[0]!;
    const initialPosition = { x: raider.x, y: raider.y };
    const target = world.buildings[raider.targetBuildingId]!;
    const initialDistance = Math.abs(raider.x - target.x) + Math.abs(raider.y - target.y);
    advanceTick(world);
    const movedDistance = Math.abs(raider.x - target.x) + Math.abs(raider.y - target.y);
    expect({ x: raider.x, y: raider.y }).not.toEqual(initialPosition);
    expect(movedDistance).toBeLessThanOrEqual(initialDistance);
  });

  it('invalidates a threat route when a newly placed building blocks its next tile', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const target = world.buildings['center-player-a']!;
    const occupied = new Set(
      Object.values(world.buildings).map((building) => `${building.x}:${building.y}`),
    );
    const route = Array.from({ length: 20 }, (_, offset) => ({
      x: target.x - 20 + offset,
      y: target.y,
    }))
      .map((start) =>
        findPath({
          start,
          goal: target,
          maxVisited: 128,
          bounds: {
            minX: Math.min(start.x, target.x) - 8,
            maxX: Math.max(start.x, target.x) + 8,
            minY: target.y - 8,
            maxY: target.y + 8,
          },
          isPassable: (tile) =>
            (tile.x === target.x && tile.y === target.y) ||
            (terrainAt(world.seed, tile.x, tile.y) !== 'water' &&
              !occupied.has(`${tile.x}:${tile.y}`)),
        }),
      )
      .find((candidate) => candidate.status === 'found' && candidate.path.length > 2);
    if (!route || route.status !== 'found')
      throw new Error('Expected a deterministic threat route.');
    const [start, blockedTile] = route.path;
    if (!start || !blockedTile) throw new Error('Expected a route with a next tile.');
    world.threats.dynamic = {
      id: 'dynamic',
      targetBuildingId: target.id,
      health: 10,
      damage: 1,
      spawnedTick: 0,
      ...start,
    };
    world.buildings['dynamic-blocker'] = {
      ...target,
      id: toBuildingId('dynamic-blocker'),
      kind: 'storage',
      x: blockedTile.x,
      y: blockedTile.y,
      inventory: { ore: 0, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
      inventoryCapacity: 200,
      populationCapacity: 0,
      jobPriority: 0,
      recipeId: null,
      productionState: 'idle',
    };
    advanceTick(world);
    expect({ x: world.threats.dynamic?.x, y: world.threats.dynamic?.y }).not.toEqual(blockedTile);
  });

  it('shares a bounded pathfinding budget fairly across a large raider wave', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const target = world.buildings['center-player-a']!;
    for (let index = 0; index < 8; index += 1) {
      const y = index * 2;
      // A wave has to start on ground a raider can actually leave, so this needs the
      // shared open-tile predicate: mountains block movement exactly as water does.
      const x = Array.from({ length: 16 }, (_, offset) => -24 + offset).find((candidate) =>
        isOpenTile(world.seed, candidate, y),
      );
      if (x === undefined) throw new Error('Expected a passable deterministic wave spawn tile.');
      world.threats[`budget-raider-${index}`] = {
        id: `budget-raider-${index}`,
        targetBuildingId: target.id,
        health: 100,
        damage: 0,
        spawnedTick: 0,
        x,
        y,
      };
    }
    const before = Object.fromEntries(
      Object.values(world.threats).map((threat) => [threat.id, { x: threat.x, y: threat.y }]),
    );
    advanceTick(world);
    const movedFirstTick = Object.values(world.threats)
      .filter((threat) => {
        const start = before[threat.id]!;
        return threat.x !== start.x || threat.y !== start.y;
      })
      .map((threat) => threat.id);
    expect(movedFirstTick.length).toBeGreaterThan(0);
    expect(movedFirstTick.length).toBeLessThan(8);
    const afterFirstTick = Object.fromEntries(
      Object.values(world.threats).map((threat) => [threat.id, { x: threat.x, y: threat.y }]),
    );
    advanceTick(world);
    const movedSecondTick = Object.values(world.threats)
      .filter((threat) => {
        const start = afterFirstTick[threat.id]!;
        return threat.x !== start.x || threat.y !== start.y;
      })
      .map((threat) => threat.id);
    expect(movedSecondTick.some((id) => !movedFirstTick.includes(id))).toBe(true);
  });

  it('reserves overlapping spawn resources for the nearest starting settlement', () => {
    const world = createWorld(37);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    world.players['player-a']!.plot = { x: 0, y: 0, size: 8 };
    world.players['player-b']!.plot = { x: 8, y: 0, size: 8 };
    const resource = Array.from({ length: 17 }, (_, x) => x)
      .flatMap((x) => Array.from({ length: 9 }, (_, y) => ({ x, y })))
      .find(({ x, y }) => {
        const terrain = terrainAt(world.seed, x, y);
        const distanceA = Math.abs(4 - x) + Math.abs(4 - y);
        const distanceB = Math.abs(12 - x) + Math.abs(4 - y);
        return (
          (terrain === 'ore' || terrain === 'wood') &&
          distanceA <= 8 &&
          distanceB <= 8 &&
          distanceA < distanceB
        );
      });
    expect(resource).toBeDefined();
    expect(
      applyCommand(world, {
        id: 'steal-spawn-resource',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'gather',
        ...resource!,
      }).result,
    ).toMatchObject({ code: 'reserved-resource' });
    expect(
      applyCommand(world, {
        id: 'gather-reserved-resource',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'gather',
        ...resource!,
      }).result.accepted,
    ).toBe(true);
  });

  it('preserves settlement buffers and an unbuildable access lane', () => {
    // This case needs two plots arranged so the cell west of player-b's is inside its
    // buffer, which is a property of where terrain lets those plots land.
    const world = createWorld(44);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const player = world.players['player-a']!;
    const other = world.players['player-b']!;
    player.research.unlocked['territorial-charter'] = true;
    const targetX = Math.floor(other.plot.x / 8) * 8 - 8;
    const targetY = Math.floor(other.plot.y / 8) * 8;
    const targetCellX = Math.floor(targetX / 8);
    const targetCellY = Math.floor(targetY / 8);
    player.territoryCells[`${targetCellX - 1}:${targetCellY}`] = true;
    player.exploredChunks[`${Math.floor(targetX / 16)}:${Math.floor(targetY / 16)}`] = true;
    expect(
      applyCommand(world, {
        id: 'surround-settlement',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'claimTerritory',
        x: targetX,
        y: targetY,
      }).result,
    ).toMatchObject({ code: 'protected-area' });

    const center = world.buildings['center-player-a']!;
    expect(
      applyCommand(world, {
        id: 'block-settlement-access',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeStorage',
        x: player.plot.x,
        y: center.y,
      }).result,
    ).toMatchObject({ code: 'protected-area' });
  });

  it('never routes a threat through another settlement or changes its target', () => {
    const world = createWorld(43);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const target = world.buildings['center-player-a']!;
    const foreignPlot = { x: target.x - 6, y: target.y - 2, size: 4 };
    world.players['player-b']!.plot = foreignPlot;
    world.threats.leashed = {
      id: 'leashed',
      targetBuildingId: target.id,
      health: 100,
      damage: 1,
      spawnedTick: 0,
      x: foreignPlot.x - 3,
      y: target.y,
    };
    advanceTick(world);
    const threat = world.threats.leashed!;
    expect(threat.targetBuildingId).toBe(target.id);
    expect(
      threat.x >= foreignPlot.x - 2 &&
        threat.x < foreignPlot.x + foreignPlot.size + 2 &&
        threat.y >= foreignPlot.y - 2 &&
        threat.y < foreignPlot.y + foreignPlot.size + 2,
    ).toBe(false);
  });

  it('lets inactive settlements take pressure without allowing unattended destruction', () => {
    const world = createWorld(47);
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    const target = {
      ...center,
      id: toBuildingId('offline-storage'),
      kind: 'storage' as const,
      x: center.x + 1,
      health: 6,
      maxHealth: 10,
      inventoryCapacity: 200,
    };
    world.buildings[target.id] = target;
    world.playerActivity['player-a'] = { lastActiveTick: 0, raidEligibleTick: 0 };
    world.tick = 309;
    world.threats.offline = {
      id: 'offline',
      targetBuildingId: target.id,
      health: 100,
      damage: 3,
      spawnedTick: 0,
      x: target.x + 1,
      y: target.y,
    };
    advanceTick(world);
    expect(target.health).toBe(5);
    expect(world.threats.offline).toBeDefined();

    expect(
      applyCommand(world, {
        id: 'return-online',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'explore',
        x: center.x,
        y: center.y,
      }).result.accepted,
    ).toBe(true);
    world.tick = 319;
    advanceTick(world);
    expect(target.health).toBe(2);
  });

  it('conserves combat state changes to configured damage and defense', () => {
    const world = createWorld(53);
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    const target = {
      ...center,
      id: toBuildingId('combat-storage'),
      kind: 'storage' as const,
      x: center.x + 1,
      health: 10,
      maxHealth: 10,
      inventoryCapacity: 200,
    };
    const tower = {
      ...center,
      id: toBuildingId('combat-tower'),
      kind: 'watchtower' as const,
      x: center.x + 2,
      y: center.y + 1,
      health: 15,
      maxHealth: 15,
    };
    world.buildings[target.id] = target;
    world.buildings[tower.id] = tower;
    world.playerActivity['player-a'] = { lastActiveTick: 9, raidEligibleTick: 0 };
    world.tick = 9;
    world.threats.combat = {
      id: 'combat',
      targetBuildingId: target.id,
      health: 10,
      damage: 2,
      spawnedTick: 0,
      x: target.x + 1,
      y: target.y,
    };
    const inventoryBefore = structuredClone(world.players['player-a']!.inventory);
    advanceTick(world);
    expect(world.threats.combat?.health).toBe(9);
    expect(target.health).toBe(8);
    expect(world.players['player-a']!.inventory).toEqual(inventoryBefore);
  });

  it('keeps long-running inactive threat pressure deterministic and bounded', () => {
    const left = createWorld(59, false);
    for (const id of ['player-a', 'player-b', 'player-c']) {
      joinPlayer(left, id);
      const center = left.buildings[`center-${id}`]!;
      left.buildings[`durable-${id}`] = {
        ...center,
        id: toBuildingId(`durable-${id}`),
        kind: 'storage',
        x: center.x + 1,
        y: center.y + 1,
        health: 100,
        maxHealth: 100,
        inventoryCapacity: 200,
      };
      left.playerActivity[id] = { lastActiveTick: 0, raidEligibleTick: 0 };
    }
    const right = structuredClone(left);
    for (let index = 0; index < 3_000; index += 1) {
      advanceTick(left);
      advanceTick(right);
    }
    expect(stateHash(left)).toBe(stateHash(right));
    expect(inspectWorld(left)).toEqual([]);
    expect(Object.keys(left.threats).length).toBeLessThanOrEqual(3);
    for (const building of Object.values(left.buildings))
      expect(building.health).toBeGreaterThanOrEqual(Math.ceil(building.maxHealth / 2));
  });

  it('transfers resources atomically between players and rejects duplicate retries', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const command = {
      id: 'gift',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'transferToPlayer' as const,
      targetPlayerId: toPlayerId('player-b'),
      item: 'wood' as const,
      amount: 2,
    };
    expect(applyCommand(world, command).result.accepted).toBe(true);
    expect(world.players['player-a']?.inventory.wood).toBe(3);
    expect(world.players['player-b']?.inventory.wood).toBe(7);
    expect(world.transfers).toEqual([
      {
        id: 'gift',
        fromPlayerId: 'player-a',
        toPlayerId: 'player-b',
        item: 'wood',
        amount: 2,
        tick: 0,
      },
    ]);
    expect(applyCommand(world, command).result).toMatchObject({ code: 'duplicate-command' });
    expect(world.players['player-b']?.inventory.wood).toBe(7);
    expect(world.transfers).toHaveLength(1);
  });

  it('linearizes competing recipient-capacity transfers without creating or destroying items', () => {
    for (const firstSender of ['player-a', 'player-c'] as const) {
      const secondSender = firstSender === 'player-a' ? 'player-c' : 'player-a';
      const world = createWorld();
      joinPlayer(world, 'player-a');
      joinPlayer(world, 'player-b');
      joinPlayer(world, 'player-c');
      world.players['player-a']!.inventory = {
        ore: 0,
        wood: 0,
        stone: 0,
        ingot: 5,
        brick: 0,
        tool: 0,
      };
      world.players['player-b']!.inventory = {
        ore: 0,
        wood: 0,
        stone: 0,
        ingot: 95,
        brick: 0,
        tool: 0,
      };
      world.players['player-c']!.inventory = {
        ore: 0,
        wood: 0,
        stone: 0,
        ingot: 5,
        brick: 0,
        tool: 0,
      };
      const transfer = (sender: 'player-a' | 'player-c') =>
        applyCommand(world, {
          id: `capacity-${sender}`,
          playerId: toPlayerId(sender),
          sequence: 1,
          type: 'transferToPlayer',
          targetPlayerId: toPlayerId('player-b'),
          item: 'ingot',
          amount: 5,
        }).result;
      expect(transfer(firstSender).accepted).toBe(true);
      expect(transfer(secondSender)).toMatchObject({ accepted: false, code: 'inventory-full' });
      expect(world.players['player-b']?.inventory.ingot).toBe(100);
      expect(
        Object.values(world.players).reduce((total, player) => total + player.inventory.ingot, 0),
      ).toBe(105);
      expect(world.transfers).toHaveLength(1);
      expect(inspectWorld(world)).toEqual([]);
    }
  });

  it('resolves acceptance/removal and ownership/removal conflicts in authoritative order', () => {
    const membershipWorld = (removeFirst: boolean) => {
      const world = createWorld();
      joinPlayer(world, 'player-a');
      joinPlayer(world, 'player-b');
      applyCommand(world, {
        id: `invite-${removeFirst}`,
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'inviteToSettlement',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      });
      const accept = {
        id: `accept-${removeFirst}`,
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'acceptSettlementInvite' as const,
        settlementId: 'settlement-player-a',
      };
      const remove = {
        id: `remove-${removeFirst}`,
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'removeSettlementMember' as const,
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      };
      const results = removeFirst
        ? [applyCommand(world, remove).result, applyCommand(world, accept).result]
        : [applyCommand(world, accept).result, applyCommand(world, remove).result];
      return { world, results };
    };
    const removedAfterAccept = membershipWorld(false);
    expect(removedAfterAccept.results.every(({ accepted }) => accepted)).toBe(true);
    expect(
      removedAfterAccept.world.settlements['settlement-player-a']?.members['player-b'],
    ).toBeUndefined();
    const acceptedAfterFailedRemove = membershipWorld(true);
    expect(acceptedAfterFailedRemove.results[0]).toMatchObject({ code: 'not-settlement-member' });
    expect(
      acceptedAfterFailedRemove.world.settlements['settlement-player-a']?.members['player-b'],
    ).toBe('member');

    const ownershipWorld = (removeFirst: boolean) => {
      const world = createWorld();
      joinPlayer(world, 'player-a');
      joinPlayer(world, 'player-b');
      applyCommand(world, {
        id: `invite-owner-${removeFirst}`,
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'inviteToSettlement',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      });
      applyCommand(world, {
        id: `accept-owner-${removeFirst}`,
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'acceptSettlementInvite',
        settlementId: 'settlement-player-a',
      });
      const first = removeFirst
        ? applyCommand(world, {
            id: 'remove-before-transfer',
            playerId: toPlayerId('player-a'),
            sequence: 2,
            type: 'removeSettlementMember',
            settlementId: 'settlement-player-a',
            targetPlayerId: toPlayerId('player-b'),
          }).result
        : applyCommand(world, {
            id: 'transfer-before-remove',
            playerId: toPlayerId('player-a'),
            sequence: 2,
            type: 'transferSettlementOwnership',
            settlementId: 'settlement-player-a',
            targetPlayerId: toPlayerId('player-b'),
          }).result;
      const second = removeFirst
        ? applyCommand(world, {
            id: 'transfer-after-remove',
            playerId: toPlayerId('player-a'),
            sequence: 3,
            type: 'transferSettlementOwnership',
            settlementId: 'settlement-player-a',
            targetPlayerId: toPlayerId('player-b'),
          }).result
        : applyCommand(world, {
            id: 'remove-after-transfer',
            playerId: toPlayerId('player-a'),
            sequence: 3,
            type: 'removeSettlementMember',
            settlementId: 'settlement-player-a',
            targetPlayerId: toPlayerId('player-b'),
          }).result;
      return { world, first, second };
    };
    const transferred = ownershipWorld(false);
    expect(transferred.first.accepted).toBe(true);
    expect(transferred.second).toMatchObject({ code: 'settlement-permission-denied' });
    expect(transferred.world.settlements['settlement-player-a']?.ownerId).toBe('player-b');
    const removed = ownershipWorld(true);
    expect(removed.first.accepted).toBe(true);
    expect(removed.second).toMatchObject({ code: 'not-settlement-member' });
    expect(removed.world.settlements['settlement-player-a']?.ownerId).toBe('player-a');
    expect(inspectWorld(transferred.world)).toEqual([]);
    expect(inspectWorld(removed.world)).toEqual([]);
  });

  it('completes a multi-settlement objective and grants each contributor one auditable reward', () => {
    const world = createWorld(73);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    joinPlayer(world, 'player-c');
    world.players['player-a']!.inventory.tool = 10;
    world.players['player-b']!.inventory.tool = 10;
    expect(
      applyCommand(world, {
        id: 'contribute-a',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'contributeToObjective',
        objectiveId: 'frontier-beacon',
        settlementId: 'settlement-player-a',
        amount: 10,
      }).result,
    ).toMatchObject({ accepted: true });
    const completion = applyCommand(world, {
      id: 'contribute-b',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'contributeToObjective',
      objectiveId: 'frontier-beacon',
      settlementId: 'settlement-player-b',
      amount: 10,
    });
    expect(completion.events.map(({ type }) => type)).toEqual([
      'objectiveContributed',
      'objectiveCompleted',
    ]);
    const objective = world.cooperativeObjectives['frontier-beacon'];
    expect(objective).toMatchObject({
      totalContributed: 20,
      completedTick: 0,
      contributionsBySettlement: {
        'settlement-player-a': 10,
        'settlement-player-b': 10,
      },
    });
    expect(
      applyCommand(world, {
        id: 'claim-without-contribution',
        playerId: toPlayerId('player-c'),
        sequence: 1,
        type: 'claimObjectiveReward',
        objectiveId: 'frontier-beacon',
      }).result,
    ).toMatchObject({ accepted: false, code: 'objective-contribution-required' });
    const claim = {
      id: 'claim-a',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'claimObjectiveReward' as const,
      objectiveId: 'frontier-beacon' as const,
    };
    expect(applyCommand(world, claim).result).toMatchObject({ accepted: true });
    expect(world.players['player-a']!.inventory.ingot).toBe(2);
    expect(applyCommand(world, claim).result).toMatchObject({
      accepted: false,
      code: 'duplicate-command',
    });
    expect(
      applyCommand(world, { ...claim, id: 'claim-a-again', sequence: 3 }).result,
    ).toMatchObject({ accepted: false, code: 'reward-already-claimed' });
    expect(world.players['player-a']!.inventory.ingot).toBe(2);
    expect(objective.rewardHistory).toEqual([
      { commandId: 'claim-a', playerId: 'player-a', reward: { ingot: 2 }, tick: 0 },
    ]);
    expect(inspectWorld(world)).toEqual([]);
    expect(stateHash(deserializeWorld(JSON.parse(JSON.stringify(world))))).toBe(stateHash(world));
  });

  it('funds a settlement-owned construction project from multiple members with exact history', () => {
    const world = createWorld(79);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    joinPlayer(world, 'player-c');
    applyCommand(world, {
      id: 'invite-project-builder',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept-project-builder',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    const owner = world.players['player-a']!;
    const center = world.buildings['center-player-a']!;
    const tile = Array.from({ length: owner.plot.size }, (_, offsetX) =>
      Array.from({ length: owner.plot.size }, (_, offsetY) => ({
        x: owner.plot.x + offsetX,
        y: owner.plot.y + offsetY,
      })),
    )
      .flat()
      .find(
        ({ x, y }) =>
          terrainAt(world.seed, x, y) !== 'water' &&
          !(y === center.y && x < center.x) &&
          !(x === center.x && y === center.y),
      )!;
    expect(
      applyCommand(world, {
        id: 'member-cannot-create-project',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'createSharedConstructionProject',
        settlementId: 'settlement-player-a',
        buildingKind: 'storage',
        ...tile,
      }).result,
    ).toMatchObject({ code: 'settlement-permission-denied' });
    applyCommand(world, {
      id: 'make-project-builder',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
      role: 'builder',
    });
    const creation = applyCommand(world, {
      id: 'shared-storage',
      playerId: toPlayerId('player-b'),
      sequence: 2,
      type: 'createSharedConstructionProject',
      settlementId: 'settlement-player-a',
      buildingKind: 'storage',
      ...tile,
    });
    expect(creation.events.map(({ type }) => type)).toEqual(['sharedProjectCreated']);
    const projectId = 'shared-storage';
    expect(
      applyCommand(world, {
        id: 'outsider-project-contribution',
        playerId: toPlayerId('player-c'),
        sequence: 1,
        type: 'contributeToSharedConstructionProject',
        projectId,
        item: 'wood',
        amount: 1,
      }).result,
    ).toMatchObject({ code: 'not-settlement-member' });
    const contribution = {
      id: 'builder-project-contribution',
      playerId: toPlayerId('player-b'),
      sequence: 3,
      type: 'contributeToSharedConstructionProject' as const,
      projectId,
      item: 'wood' as const,
      amount: 1,
    };
    expect(applyCommand(world, contribution).result.accepted).toBe(true);
    expect(applyCommand(world, contribution).result).toMatchObject({ code: 'duplicate-command' });
    const completion = applyCommand(world, {
      id: 'owner-project-contribution',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'contributeToSharedConstructionProject',
      projectId,
      item: 'wood',
      amount: 1,
    });
    expect(completion.events.map(({ type }) => type)).toEqual([
      'sharedProjectContributed',
      'sharedProjectCompleted',
    ]);
    const project = world.sharedConstructionProjects[projectId]!;
    expect(project).toMatchObject({
      settlementId: 'settlement-player-a',
      contributed: { wood: 2 },
      completedTick: 0,
    });
    expect(project.contributionHistory.map(({ playerId }) => playerId)).toEqual([
      'player-b',
      'player-a',
    ]);
    expect(world.buildings[project.buildingId!]).toMatchObject({
      ownerId: 'player-a',
      kind: 'storage',
      x: tile.x,
      y: tile.y,
      constructionMaterials: { wood: 2 },
    });
    expect(world.players['player-a']!.inventory.wood).toBe(4);
    expect(world.players['player-b']!.inventory.wood).toBe(4);
    expect(
      applyCommand(world, {
        id: 'transfer-project-owner',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'transferSettlementOwnership',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }).result.accepted,
    ).toBe(true);
    expect(world.buildings[project.buildingId!]?.ownerId).toBe('player-b');
    expect(inspectWorld(world)).toEqual([]);
    expect(stateHash(deserializeWorld(JSON.parse(JSON.stringify(world))))).toBe(stateHash(world));
  });

  it('normalizes unique names and enforces moderated, rate-limited, reportable chat', () => {
    const world = createWorld(83);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    expect(
      applyCommand(world, {
        id: 'name-a',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'setPlayerName',
        name: '  Álpha   One  ',
      }).result.accepted,
    ).toBe(true);
    expect(world.social.playerNames['player-a']).toBe('Álpha One');
    expect(
      applyCommand(world, {
        id: 'duplicate-name',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'setPlayerName',
        name: 'A\u0301LPHA ONE',
      }).result,
    ).toMatchObject({ code: 'name-taken' });
    expect(
      applyCommand(world, {
        id: 'moderated-name',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'setPlayerName',
        name: 'System Herald',
      }).result,
    ).toMatchObject({ code: 'content-rejected' });
    expect(
      applyCommand(world, {
        id: 'name-b',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'setPlayerName',
        name: 'Beta Two',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'settlement-name',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'setSettlementName',
        settlementId: 'settlement-player-a',
        name: '  Iron   Vale ',
      }).result.accepted,
    ).toBe(true);
    expect(world.social.settlementNames['settlement-player-a']).toBe('Iron Vale');
    expect(
      applyCommand(world, {
        id: 'unauthorized-settlement-name',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'setSettlementName',
        settlementId: 'settlement-player-a',
        name: 'Stolen Vale',
      }).result,
    ).toMatchObject({ code: 'settlement-permission-denied' });

    expect(
      applyCommand(world, {
        id: 'chat-a-1',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'sendChatMessage',
        channel: 'global',
        text: '  Need   wood\nnear the beacon. ',
      }).result.accepted,
    ).toBe(true);
    expect(world.social.messages[0]).toMatchObject({
      id: 'chat-a-1',
      senderName: 'Álpha One',
      text: 'Need wood near the beacon.',
      channel: 'global',
    });
    expect(
      applyCommand(world, {
        id: 'chat-too-fast',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'sendChatMessage',
        channel: 'global',
        text: 'Another message',
      }).result,
    ).toMatchObject({ code: 'chat-rate-limited' });
    expect(
      applyCommand(world, {
        id: 'block-a',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'setPlayerBlocked',
        targetPlayerId: toPlayerId('player-a'),
        blocked: true,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'report-a',
        playerId: toPlayerId('player-b'),
        sequence: 3,
        type: 'reportChatMessage',
        messageId: 'chat-a-1',
        reason: '  abusive   coordination ',
      }).result.accepted,
    ).toBe(true);
    expect(world.social.reports[0]).toMatchObject({
      reporterId: 'player-b',
      reason: 'abusive coordination',
      reportedMessage: { id: 'chat-a-1', text: 'Need wood near the beacon.' },
      status: 'open',
    });
    expect(
      applyCommand(world, {
        id: 'report-a-again',
        playerId: toPlayerId('player-b'),
        sequence: 4,
        type: 'reportChatMessage',
        messageId: 'chat-a-1',
        reason: 'duplicate report',
      }).result,
    ).toMatchObject({ code: 'already-reported' });
    for (let index = 0; index < 5; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'chat-a-2',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'sendChatMessage',
        channel: 'global',
        text: 'Cooldown elapsed',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'outsider-settlement-chat',
        playerId: toPlayerId('player-b'),
        sequence: 4,
        type: 'sendChatMessage',
        channel: 'settlement',
        settlementId: 'settlement-player-a',
        text: 'Private channel',
      }).result,
    ).toMatchObject({ code: 'not-settlement-member' });
    applyCommand(world, {
      id: 'invite-chat-member',
      playerId: toPlayerId('player-a'),
      sequence: 5,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept-chat-member',
      playerId: toPlayerId('player-b'),
      sequence: 4,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    expect(
      applyCommand(world, {
        id: 'settlement-chat',
        playerId: toPlayerId('player-b'),
        sequence: 5,
        type: 'sendChatMessage',
        channel: 'settlement',
        settlementId: 'settlement-player-a',
        text: 'Private channel',
      }).result.accepted,
    ).toBe(true);
    expect(inspectWorld(world)).toEqual([]);
    expect(stateHash(deserializeWorld(JSON.parse(JSON.stringify(world))))).toBe(stateHash(world));
  });

  it('enforces settlement roles while allowing delegated building and logistics work', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    expect(
      applyCommand(world, {
        id: 'invite',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'inviteToSettlement',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'accept',
        playerId: toPlayerId('player-b'),
        sequence: 1,
        type: 'acceptSettlementInvite',
        settlementId: 'settlement-player-a',
      }).result.accepted,
    ).toBe(true);
    applyCommand(world, {
      id: 'make-builder',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
      role: 'builder',
    });
    applyCommand(world, {
      id: 'build',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    smelter.health = 1;
    expect(
      applyCommand(world, {
        id: 'repair',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'repair',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(smelter.health).toBe(3);
    expect(
      applyCommand(world, {
        id: 'blocked-load',
        playerId: toPlayerId('player-b'),
        sequence: 3,
        type: 'transfer',
        buildingId: smelter.id,
        item: 'ore',
        amount: 1,
        direction: 'toBuilding',
      }).result,
    ).toMatchObject({ code: 'settlement-permission-denied' });
    world.players['player-b']!.inventory.ore = 1;
    applyCommand(world, {
      id: 'make-logistics',
      playerId: toPlayerId('player-a'),
      sequence: 4,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
      role: 'logistics',
    });
    expect(
      applyCommand(world, {
        id: 'load',
        playerId: toPlayerId('player-b'),
        sequence: 3,
        type: 'transfer',
        buildingId: smelter.id,
        item: 'ore',
        amount: 1,
        direction: 'toBuilding',
      }).result.accepted,
    ).toBe(true);
    expect(smelter.inventory.ore).toBe(1);
    expect(
      applyCommand(world, {
        id: 'owner-cannot-leave',
        playerId: toPlayerId('player-a'),
        sequence: 5,
        type: 'leaveSettlement',
        settlementId: 'settlement-player-a',
      }).result,
    ).toMatchObject({ code: 'cannot-leave-settlement-owner' });
  });

  it('transfers settlement ownership atomically before the previous owner leaves', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'invite',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    expect(
      applyCommand(world, {
        id: 'transfer-owner',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'transferSettlementOwnership',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']).toMatchObject({
      ownerId: 'player-b',
      members: { 'player-a': 'member', 'player-b': 'owner' },
    });
    expect(
      applyCommand(world, {
        id: 'leave-after-transfer',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'leaveSettlement',
        settlementId: 'settlement-player-a',
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']?.members['player-a']).toBeUndefined();
    expect(inspectWorld(world)).toEqual([]);
  });

  it('deletes a non-owner account atomically, anonymizes history, and reserves its identity', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'invite-a',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept-b',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    expect(
      applyCommand(world, {
        id: 'delete-while-owner',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'deleteAccount',
        confirmation: 'DELETE',
      }).result,
    ).toMatchObject({ code: 'cannot-delete-settlement-owner' });
    applyCommand(world, {
      id: 'transfer-owner',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'transferSettlementOwnership',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'invite-deleting-player',
      playerId: toPlayerId('player-b'),
      sequence: 2,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-b',
      targetPlayerId: toPlayerId('player-a'),
    });
    applyCommand(world, {
      id: 'farewell-message',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'sendChatMessage',
      channel: 'global',
      text: 'Goodbye',
    });
    applyCommand(world, {
      id: 'report-farewell',
      playerId: toPlayerId('player-b'),
      sequence: 3,
      type: 'reportChatMessage',
      messageId: 'farewell-message',
      reason: 'Keep the moderation record',
    });
    applyCommand(world, {
      id: 'block-a',
      playerId: toPlayerId('player-b'),
      sequence: 4,
      type: 'setPlayerBlocked',
      targetPlayerId: toPlayerId('player-a'),
      blocked: true,
    });
    expect(
      applyCommand(world, {
        id: 'delete-unconfirmed',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'deleteAccount',
        confirmation: 'delete',
      }).result,
    ).toMatchObject({ code: 'account-deletion-confirmation-required' });
    const deletion = applyCommand(world, {
      id: 'delete-confirmed',
      playerId: toPlayerId('player-a'),
      sequence: 4,
      type: 'deleteAccount',
      confirmation: 'DELETE',
    });
    expect(deletion.result.accepted).toBe(true);
    expect(deletion.events).toContainEqual({ type: 'playerDeleted', playerId: 'player-a' });
    expect(world.players['player-a']).toBeUndefined();
    expect(world.deletedPlayers['player-a']).toEqual({
      id: 'player-a',
      deletedTick: 0,
      reason: 'account-deletion',
    });
    expect(Object.values(world.buildings).some(({ ownerId }) => ownerId === 'player-a')).toBe(
      false,
    );
    expect(world.settlements['settlement-player-a']?.members['player-a']).toBeUndefined();
    expect(world.settlements['settlement-player-b']?.invitations['player-a']).toBeUndefined();
    expect(world.social.playerNames['player-a']).toBeUndefined();
    expect(world.social.blockedPlayers['player-b']?.['player-a']).toBeUndefined();
    expect(world.social.messages[0]).toMatchObject({
      senderId: 'player-a',
      senderName: 'Deleted player 1',
    });
    expect(world.social.reports[0]?.reportedMessage.senderName).toBe('Deleted player 1');
    expect(joinPlayer(world, 'player-a')).toEqual([]);
    expect(
      applyCommand(world, {
        id: 'deleted-retry',
        playerId: toPlayerId('player-a'),
        sequence: 5,
        type: 'gather',
        x: 0,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'account-deleted' });
    expect(inspectWorld(world)).toEqual([]);
    expect(inspectWorld(deserializeWorld(JSON.parse(JSON.stringify(world))))).toEqual([]);
  });

  it("lets settlement owners revoke a member's delegated building permissions", () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'invite',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
    });
    applyCommand(world, {
      id: 'accept',
      playerId: toPlayerId('player-b'),
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    applyCommand(world, {
      id: 'make-builder',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: toPlayerId('player-b'),
      role: 'builder',
    });
    applyCommand(world, {
      id: 'build',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'builder-priority',
        playerId: toPlayerId('player-b'),
        sequence: 2,
        type: 'setJobPriority',
        buildingId: smelter.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'remove-member',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-b'),
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']?.members['player-b']).toBeUndefined();
    expect(
      applyCommand(world, {
        id: 'revoked-priority',
        playerId: toPlayerId('player-b'),
        sequence: 3,
        type: 'setJobPriority',
        buildingId: smelter.id,
        priority: 1,
      }).result,
    ).toMatchObject({ code: 'settlement-permission-denied' });
    expect(
      applyCommand(world, {
        id: 'remove-owner',
        playerId: toPlayerId('player-a'),
        sequence: 5,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: toPlayerId('player-a'),
      }).result,
    ).toMatchObject({ code: 'cannot-remove-settlement-owner' });
  });

  it('refunds the exact construction cost when cancelling', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'storage',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeStorage',
      x: 12,
      y: 0,
    });
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    expect(world.players['player-a']?.inventory.wood).toBe(3);
    expect(
      applyCommand(world, {
        id: 'cancel',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'cancelConstruction',
        buildingId: storage.id,
      }).result.accepted,
    ).toBe(true);
    expect(world.players['player-a']?.inventory.wood).toBe(5);
  });

  it('extracts a nearby deposit into a mine without a gather command', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 20;
    const { building: mine, x, y } = placeExtractor(world, 'placeMine', 1);
    expect(mine.kind).toBe('mine');
    expect(mine.jobPriority).toBe(1);
    const deposit = extractableTile(world, {
      kind: 'mine',
      ownerId: toPlayerId('player-a'),
      x,
      y,
    })!;
    expect(deposit).toBeDefined();
    expect(terrainAt(world.seed, deposit.x, deposit.y)).toBe('ore');

    for (let index = 0; index < buildingDefinitions.mine.constructionTicks; index += 1)
      advanceTick(world);
    expect(mine.constructionTicks).toBe(0);
    expect(mine.inventory.ore).toBe(0);

    const events = Array.from({ length: extractors.mine.ticksPerUnit }, () =>
      advanceTick(world),
    ).flat();
    expect(mine.inventory.ore).toBe(1);
    expect(mine.productionState).toBe('working');
    expect(world.minedTiles[`${deposit.x}:${deposit.y}`]).toBe(1);
    expect(events).toContainEqual({ type: 'extracted', buildingId: mine.id, playerId: 'player-a' });
    // Extraction spends the same finite deposit that manual gathering does.
    expect(
      applyCommand(world, {
        id: 'gather-same-deposit',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'gather',
        ...deposit,
      }).result.accepted,
    ).toBe(true);
    expect(world.minedTiles[`${deposit.x}:${deposit.y}`]).toBe(2);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('quarries stone from a mountain range and fires it into brick', () => {
    const world = createWorld(47);
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 40;
    player.research.unlocked.metallurgy = true;
    player.research.unlocked.masonry = true;
    // A starter plot is nearly clear ground, so claim the sector holding a nearby range and
    // build the quarry on open ground beside it: the range itself stays unbuildable.
    const range = (() => {
      for (let x = player.plot.x - 16; x < player.plot.x + player.plot.size + 16; x += 1)
        for (let y = player.plot.y - 16; y < player.plot.y + player.plot.size + 16; y += 1)
          if (terrainAt(world.seed, x, y) === 'mountain') return { x, y };
      return undefined;
    })();
    if (!range) throw new Error('Expected a mountain range near the seeded starter plot');
    const quarrySite = (() => {
      for (let offsetX = -extractors.quarry.range; offsetX <= extractors.quarry.range; offsetX += 1)
        for (
          let offsetY = -extractors.quarry.range;
          offsetY <= extractors.quarry.range;
          offsetY += 1
        ) {
          const tile = { x: range.x + offsetX, y: range.y + offsetY };
          if (
            Math.abs(offsetX) + Math.abs(offsetY) <= extractors.quarry.range &&
            terrainAt(world.seed, tile.x, tile.y) === 'grass'
          )
            return tile;
        }
      return undefined;
    })();
    if (!quarrySite) throw new Error('Expected open ground beside the range');
    for (const tile of [range, quarrySite])
      player.territoryCells[`${Math.floor(tile.x / 8)}:${Math.floor(tile.y / 8)}`] = true;

    expect(
      applyCommand(world, {
        id: 'quarry',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeQuarry',
        ...quarrySite,
      }).result.accepted,
    ).toBe(true);
    const quarry = Object.values(world.buildings).find((building) => building.kind === 'quarry')!;
    for (let index = 0; index < buildingDefinitions.quarry.constructionTicks; index += 1)
      advanceTick(world);
    expect(quarry.constructionTicks).toBe(0);
    for (let index = 0; index < extractors.quarry.ticksPerUnit; index += 1) advanceTick(world);
    expect(quarry.inventory.stone).toBe(1);
    const worked = extractableTile(world, quarry)!;
    expect(terrainAt(world.seed, worked.x, worked.y)).toBe('mountain');
    expect(world.minedTiles[`${worked.x}:${worked.y}`]).toBe(1);

    // The brickworks turns that stone plus timber into brick, so masonry is a real chain
    // rather than a second name for stone.
    const brickSite = { x: quarrySite.x, y: quarrySite.y + 1 };
    if (terrainAt(world.seed, brickSite.x, brickSite.y) !== 'grass')
      throw new Error('Expected a second open tile beside the quarry');
    expect(
      applyCommand(world, {
        id: 'brickworks',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeBrickworks',
        ...brickSite,
      }).result.accepted,
    ).toBe(true);
    const brickworks = Object.values(world.buildings).find(
      (building) => building.kind === 'brickworks',
    )!;
    expect(brickworks.recipeId).toBe('fire-brick');
    for (let index = 0; index < buildingDefinitions.brickworks.constructionTicks; index += 1)
      advanceTick(world);
    quarry.jobPriority = 0;
    brickworks.inventory.stone = 2;
    brickworks.inventory.wood = 1;
    for (let index = 0; index <= recipes.fireBrick.ticks; index += 1) advanceTick(world);
    expect(brickworks.inventory.brick).toBe(1);
    expect(brickworks.inventory.stone).toBe(0);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('rejects a quarry with no range in reach and gates the masonry chain behind research', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 40;
    const openTile = { x: player.plot.x, y: player.plot.y };
    expect(
      applyCommand(world, {
        id: 'locked-quarry',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeQuarry',
        ...openTile,
      }).result,
    ).toMatchObject({ code: 'technology-locked' });
    player.research.unlocked.masonry = true;
    // The seeded starter plot is clear ground, so nothing within range yields stone.
    expect(
      applyCommand(world, {
        id: 'quarry-without-range',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeQuarry',
        ...openTile,
      }).result,
    ).toMatchObject({ code: 'no-deposit-in-range' });
    expect(player.inventory.wood).toBe(40);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('raises a brick wall that outlasts timber buildings and blocks a raider route', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.research.unlocked.metallurgy = true;
    player.research.unlocked.masonry = true;
    player.inventory.brick = 1;
    const site = { x: player.plot.x, y: player.plot.y };
    expect(
      applyCommand(world, {
        id: 'wall',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeWall',
        ...site,
      }).result.accepted,
    ).toBe(true);
    expect(player.inventory.brick).toBe(0);
    const wall = Object.values(world.buildings).find((building) => building.kind === 'wall')!;
    for (let index = 0; index < buildingDefinitions.wall.constructionTicks; index += 1)
      advanceTick(world);
    expect(wall.constructionTicks).toBe(0);
    // Durability is the point of brick: a wall takes far more punishment than timber.
    expect(wall.maxHealth).toBeGreaterThan(buildingDefinitions.watchtower.maxHealth * 2);
    // Walls occupy a tile like any other building, so raider routes have to go around.
    expect(
      applyCommand(world, {
        id: 'wall-on-wall',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeWall',
        ...site,
      }).result,
    ).toMatchObject({ code: 'occupied' });
    expect(inspectWorld(world)).toEqual([]);
  });

  it('upgrades a smelter into a faster, larger, tougher second tier', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    expect(smelter).toMatchObject({ tier: 1, constructionTicks: 0 });
    const upgrade = buildingUpgrades.smelter;

    const request = (id: string, sequence: number) =>
      applyCommand(world, {
        id,
        playerId: toPlayerId('player-a'),
        sequence,
        type: 'upgradeBuilding',
        buildingId: smelter.id,
      }).result;
    expect(request('locked-upgrade', 2)).toMatchObject({ code: 'technology-locked' });
    player.research.unlocked.masonry = true;
    expect(request('unaffordable-upgrade', 3)).toMatchObject({ code: 'insufficient-resources' });
    for (const [item, amount] of Object.entries(upgrade.cost))
      player.inventory[item as 'tool' | 'brick'] = amount;
    // An upgrade cannot interrupt a batch whose inputs are already consumed.
    smelter.progress = 2;
    expect(request('busy-upgrade', 4)).toMatchObject({ code: 'busy' });
    smelter.progress = 0;

    expect(request('upgrade', 5).accepted).toBe(true);
    expect(player.inventory.brick).toBe(0);
    expect(player.inventory.tool).toBe(0);
    expect(smelter).toMatchObject({
      tier: 1,
      upgradeTier: 2,
      constructionTicks: upgrade.constructionTicks,
      productionState: 'constructing',
    });
    // The building stops working while the tier is built, and needs a worker like any site.
    const tierEvents = Array.from({ length: upgrade.constructionTicks }, () =>
      advanceTick(world),
    ).flat();
    expect(tierEvents).toContainEqual({
      type: 'buildingUpgraded',
      buildingId: smelter.id,
      playerId: 'player-a',
    });
    expect(smelter.tier).toBe(2);
    expect(smelter.upgradeTier).toBeUndefined();
    expect(smelter.inventoryCapacity).toBe(
      buildingDefinitions.smelter.inventoryCapacity * upgrade.inventoryCapacityMultiplier,
    );
    expect(smelter.maxHealth).toBeGreaterThan(buildingDefinitions.smelter.maxHealth);
    expect(smelter.health).toBe(smelter.maxHealth);

    // The tier is permanent, and the recipe now finishes in fewer ticks than at tier one.
    expect(request('second-upgrade', 6)).toMatchObject({ code: 'already-upgraded' });
    expect(recipeTicksFor(smelter, recipes.smeltOre.ticks)).toBeLessThan(recipes.smeltOre.ticks);
    const tieredTicks = recipeTicksFor(smelter, recipes.smeltOre.ticks);
    smelter.inventory.ore = 1;
    // The batch is started with the tier's shorter duration, then counted down from there.
    advanceTick(world);
    expect(smelter.progress).toBe(tieredTicks);
    for (let index = 0; index < tieredTicks; index += 1) advanceTick(world);
    expect(smelter.inventory.ingot).toBe(1);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('refunds an upgrade that is cancelled and leaves the working building in place', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    applyCommand(world, {
      id: 'storage',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeStorage',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    player.research.unlocked.masonry = true;
    player.inventory.brick = buildingUpgrades.storage.cost.brick;
    expect(
      applyCommand(world, {
        id: 'upgrade-storage',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'upgradeBuilding',
        buildingId: storage.id,
      }).result.accepted,
    ).toBe(true);
    expect(player.inventory.brick).toBe(0);
    advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'cancel-upgrade',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'cancelConstruction',
        buildingId: storage.id,
      }).result.accepted,
    ).toBe(true);
    // Cancelling a tier returns its materials and keeps the tier-one building working,
    // unlike cancelling a first-time construction, which removes the site entirely.
    expect(player.inventory.brick).toBe(buildingUpgrades.storage.cost.brick);
    expect(world.buildings[storage.id]).toBeDefined();
    expect(storage).toMatchObject({ tier: 1, constructionTicks: 0, productionState: 'idle' });
    expect(storage.upgradeTier).toBeUndefined();
    expect(inspectWorld(world)).toEqual([]);
  });

  it('recovers carrier cargo when a linked building is demolished', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    for (const [sequence, type, x] of [
      [1, 'placeSmelter', 12],
      [2, 'placeStorage', 16],
    ] as const)
      expect(
        applyCommand(world, {
          id: `${type}-${x}`,
          playerId: toPlayerId('player-a'),
          sequence,
          type,
          x,
          y: 0,
        }).result.accepted,
      ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    smelter.jobPriority = 0;
    storage.inventory.ore = 4;
    expect(
      applyCommand(world, {
        id: 'demolition-link',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'createLogisticsLink',
        sourceBuildingId: storage.id,
        targetBuildingId: smelter.id,
        item: 'ore',
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    const link = Object.values(world.logisticsLinks)[0]!;
    expect(world.carriers[link.carrierId!]?.cargo).toBe(4);
    expect(storage.inventory.ore).toBe(0);
    player.inventory.wood = 0;
    // The four ore exist only inside the carrier, so demolition has to hand them back
    // rather than let them disappear with the link.
    expect(
      applyCommand(world, {
        id: 'demolish-target',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'demolish',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(player.inventory.ore).toBe(4);
    expect(world.carriers).toEqual({});
    expect(world.logisticsLinks).toEqual({});
    expect(inspectWorld(world)).toEqual([]);
  });

  it('returns a loaded carrier to its source when its link is removed', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 20;
    for (const [sequence, type, x] of [
      [1, 'placeSmelter', 12],
      [2, 'placeStorage', 16],
    ] as const)
      applyCommand(world, {
        id: `${type}-${x}`,
        playerId: toPlayerId('player-a'),
        sequence,
        type,
        x,
        y: 0,
      });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    smelter.jobPriority = 0;
    storage.inventory.ore = 4;
    applyCommand(world, {
      id: 'removable-link',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'createLogisticsLink',
      sourceBuildingId: storage.id,
      targetBuildingId: smelter.id,
      item: 'ore',
    });
    advanceTick(world);
    const link = Object.values(world.logisticsLinks)[0]!;
    expect(world.carriers[link.carrierId!]?.cargo).toBe(4);
    expect(
      applyCommand(world, {
        id: 'remove-loaded-link',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'removeLogisticsLink',
        linkId: link.id,
      }).result.accepted,
    ).toBe(true);
    expect(storage.inventory.ore).toBe(4);
    expect(world.carriers).toEqual({});
    expect(inspectWorld(world)).toEqual([]);
  });

  it('lets a staffed forester restore previously harvested timber', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    player.research.unlocked.metallurgy = true;
    player.research.unlocked.stewardship = true;
    expect(
      applyCommand(world, {
        id: 'place-forester',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeForester',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    const forester = Object.values(world.buildings).find(
      (building) => building.kind === 'forester',
    )!;
    for (let index = 0; index < buildingDefinitions.forester.constructionTicks; index += 1)
      advanceTick(world);
    const timber = nearestResourceTile(world.seed, forester.x, forester.y, 4, 'wood');
    if (!timber) throw new Error('Expected timber in forester range.');
    world.minedTiles[`${timber.x}:${timber.y}`] = 2;
    const events = Array.from({ length: renewers.forester.ticksPerUnit }, () =>
      advanceTick(world),
    ).flat();
    expect(world.minedTiles[`${timber.x}:${timber.y}`]).toBe(1);
    expect(events).toContainEqual({
      type: 'resourceRegenerated',
      buildingId: forester.id,
      playerId: 'player-a',
    });
    expect(inspectWorld(world)).toEqual([]);
  });

  it('reports an exhausted or full mine instead of extracting', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 20;
    const { building: mine, x, y } = placeExtractor(world, 'placeMine', 1);
    for (let index = 0; index < buildingDefinitions.mine.constructionTicks; index += 1)
      advanceTick(world);

    mine.inventory.ore = mine.inventoryCapacity;
    advanceTick(world);
    expect(mine.productionState).toBe('blocked-output');
    expect(mine.progress).toBe(0);

    mine.inventory.ore = 0;
    for (let offsetX = -extractors.mine.range; offsetX <= extractors.mine.range; offsetX += 1)
      for (let offsetY = -extractors.mine.range; offsetY <= extractors.mine.range; offsetY += 1)
        if (terrainAt(world.seed, x + offsetX, y + offsetY) === 'ore')
          world.minedTiles[`${x + offsetX}:${y + offsetY}`] = resources.ore.yield;
    advanceTick(world);
    expect(mine.productionState).toBe('blocked-input');
    expect(mine.inventory.ore).toBe(0);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('rejects an extractor site with no deposit in range and keeps its cost', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    // A lumber camp cannot work an ore deposit, and this plot has no grove in range.
    const site = { x: player.plot.x, y: player.plot.y };
    const hasGroveInRange = extractableTile(world, {
      kind: 'lumber-camp',
      ownerId: toPlayerId('player-a'),
      ...site,
    });
    if (!hasGroveInRange) {
      expect(
        applyCommand(world, {
          id: 'camp',
          playerId: toPlayerId('player-a'),
          sequence: 1,
          type: 'placeLumberCamp',
          ...site,
        }).result,
      ).toEqual({
        accepted: false,
        commandId: 'camp',
        code: 'no-deposit-in-range',
      });
      expect(player.inventory.wood).toBe(20);
    }
    expect(inspectWorld(world)).toEqual([]);
  });

  it('feeds a smelter straight from a mine and refuses storage-to-storage links', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 30;
    const { building: mine } = placeExtractor(world, 'placeMine', 1, [
      { x: 12, y: 0 },
      { x: 13, y: 0 },
      { x: 14, y: 0 },
    ]);
    for (const [sequence, type, x] of [
      [2, 'placeSmelter', 12],
      [3, 'placeStorage', 13],
      [4, 'placeStorage', 14],
    ] as const)
      expect(
        applyCommand(world, {
          id: `${type}-${x}`,
          playerId: toPlayerId('player-a'),
          sequence,
          type,
          x,
          y: 0,
        }).result.accepted,
      ).toBe(true);
    for (let index = 0; index < 20; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const [storage, secondStorage] = Object.values(world.buildings).filter(
      (building) => building.kind === 'storage',
    );
    expect(smelter.constructionTicks).toBe(0);

    expect(
      applyCommand(world, {
        id: 'mine-to-smelter',
        playerId: toPlayerId('player-a'),
        sequence: 5,
        type: 'createLogisticsLink',
        sourceBuildingId: mine.id,
        targetBuildingId: smelter.id,
        item: 'ore',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'mine-to-storage',
        playerId: toPlayerId('player-a'),
        sequence: 6,
        type: 'createLogisticsLink',
        sourceBuildingId: mine.id,
        targetBuildingId: storage!.id,
        item: 'ore',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'storage-to-storage',
        playerId: toPlayerId('player-a'),
        sequence: 7,
        type: 'createLogisticsLink',
        sourceBuildingId: storage!.id,
        targetBuildingId: secondStorage!.id,
        item: 'ore',
      }).result,
    ).toMatchObject({ code: 'invalid-logistics-link' });

    // Both links draw from the same mine, so the smelter needs the higher priority.
    expect(
      applyCommand(world, {
        id: 'prefer-smelter',
        playerId: toPlayerId('player-a'),
        sequence: 8,
        type: 'setLogisticsPriority',
        linkId: `link-${mine.id}-${smelter.id}-ore`,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    const minedTotal = () => Object.values(world.minedTiles).reduce((total, n) => total + n, 0);
    /** Every unit taken from a deposit is ore somewhere, inside a batch, or one ingot. */
    const heldTotal = () =>
      mine.inventory.ore +
      smelter.inventory.ore +
      storage!.inventory.ore +
      smelter.inventory.ingot +
      (smelter.progress > 0 ? 1 : 0);
    const minedBefore = minedTotal();
    const heldBefore = heldTotal();
    for (let index = 0; index < extractors.mine.ticksPerUnit * 3; index += 1) advanceTick(world);
    const extracted = minedTotal() - minedBefore;
    expect(extracted).toBeGreaterThan(0);
    expect(smelter.inventory.ingot).toBeGreaterThan(0);
    expect(heldTotal() - heldBefore).toBe(extracted);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('shares one worker pool between extractors and recipe producers', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 30;
    const { building: mine } = placeExtractor(world, 'placeMine', 1, [{ x: 12, y: 0 }]);
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 20; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    smelter.inventory.ore = 5;
    // Settlers arrive on the 200-tick cadence, so pin the pool to one worker here.
    player.population.total = 1;
    advanceTick(world);
    expect(
      [mine.productionState, smelter.productionState].filter((state) => state === 'unassigned'),
    ).toHaveLength(1);

    // A mine deprioritized to zero leaves the settler for the smelter.
    expect(
      applyCommand(world, {
        id: 'pause-mine',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'setJobPriority',
        buildingId: mine.id,
        priority: 0,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(mine.productionState).toBe('unassigned');
    expect(smelter.productionState).toBe('working');
    expect(inspectWorld(world)).toEqual([]);
  });

  it('moves storage items through deterministic logistics links without duplication', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'storage',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'placeStorage',
      x: 13,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    storage.inventory.ore = 2;
    const link = {
      id: 'link',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'createLogisticsLink' as const,
      sourceBuildingId: storage.id,
      targetBuildingId: smelter.id,
      item: 'ore' as const,
    };
    expect(applyCommand(world, link).result.accepted).toBe(true);
    expect(applyCommand(world, link).result).toMatchObject({ code: 'duplicate-command' });
    // The first tick loads the carrier: the items leave the source and exist only inside
    // the carrier until it arrives, so nothing is duplicated at any point on the journey.
    advanceTick(world);
    expect(Object.keys(world.logisticsLinks)).toHaveLength(1);
    const createdLink = Object.values(world.logisticsLinks)[0]!;
    expect(createdLink).toMatchObject({ capacityPerTrip: 4, status: 'in-transit' });
    const carrier = world.carriers[createdLink.carrierId!]!;
    expect(carrier).toMatchObject({ item: 'ore', cargo: 2, phase: 'outbound' });
    expect(storage.inventory.ore).toBe(0);
    expect(smelter.inventory.ore).toBe(0);
    // Storage and smelter are adjacent, so the next tick arrives and unloads.
    advanceTick(world);
    expect(smelter.inventory.ore).toBe(2);
    expect(world.logisticsLinks[createdLink.id]?.status).toBe('transferred');
    expect(
      applyCommand(world, {
        id: 'prioritize-link',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'setLogisticsPriority',
        linkId: createdLink.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    expect(world.logisticsLinks[createdLink.id]?.priority).toBe(3);
    // Walk the carrier home so the link is free to dispatch again.
    advanceTick(world);
    expect(world.carriers[createdLink.carrierId!]).toBeUndefined();
    storage.inventory.ore = 1;
    smelter.inventory = {
      ore: smelter.inventoryCapacity - 1,
      wood: 0,
      stone: 0,
      ingot: 0,
      brick: 0,
      tool: 0,
    };
    smelter.progress = 3;
    advanceTick(world);
    expect(world.logisticsLinks[createdLink.id]?.status).toBe('target-full');
    expect(storage.inventory.ore).toBe(1);
    delete world.buildings[storage.id];
    advanceTick(world);
    expect(Object.keys(world.logisticsLinks)).toHaveLength(0);
    expect(world.carriers).toEqual({});
  });

  it('walks a loaded carrier along its route and pays for paving with movement', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 20;
    player.research.unlocked.metallurgy = true;
    player.research.unlocked.engineering = true;
    for (const [sequence, type, x] of [
      [1, 'placeSmelter', 12],
      [2, 'placeStorage', 19],
    ] as const)
      expect(
        applyCommand(world, {
          id: `${type}-${x}`,
          playerId: toPlayerId('player-a'),
          sequence,
          type,
          x,
          y: 0,
        }).result.accepted,
      ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const storage = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    smelter.jobPriority = 0;
    storage.inventory.ore = 3;
    expect(
      applyCommand(world, {
        id: 'long-carrier-link',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'createLogisticsLink',
        sourceBuildingId: storage.id,
        targetBuildingId: smelter.id,
        item: 'ore',
      }).result.accepted,
    ).toBe(true);
    const link = Object.values(world.logisticsLinks)[0]!;
    // The route runs along the row between the two buildings, so it is seven tiles long
    // and every step is unpaved ground at first.
    expect(link).toMatchObject({ carrierId: `carrier-${link.id}`, routeDistance: 7 });
    expect(link.route).toEqual([18, 0, 17, 0, 16, 0, 15, 0, 14, 0, 13, 0, 12, 0]);
    advanceTick(world);
    const carrier = world.carriers[link.carrierId!]!;
    expect(carrier).toMatchObject({ cargo: 3, phase: 'outbound', routeIndex: 0 });
    expect(link.status).toBe('in-transit');
    // Engineering buys six movement points a tick and unpaved ground costs two, so the
    // carrier covers three tiles per tick and the whole load is in flight, not duplicated.
    advanceTick(world);
    expect(carrier).toMatchObject({ routeIndex: 3, x: 16, y: 0 });
    expect(storage.inventory.ore).toBe(0);
    expect(smelter.inventory.ore).toBe(0);
    advanceTick(world);
    expect(carrier).toMatchObject({ routeIndex: 6, x: 13, y: 0 });
    advanceTick(world);
    expect(smelter.inventory.ore).toBe(3);
    expect(link.status).toBe('transferred');
    expect(world.carriers[link.carrierId!]?.phase).toBe('returning');
    // Paving a step on the route halves its cost, so the return journey is measurably
    // shorter than the outbound one over the same tiles.
    expect(
      applyCommand(world, {
        id: 'road-on-carrier-route',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'placeRoad',
        x: 13,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(world.roads['13:0']).toBe('player-a');
    advanceTick(world);
    // Three unpaved steps cost six of the six points available; the paved tile costs one,
    // so the same budget now carries the carrier a fourth tile on the way home.
    expect(world.carriers[link.carrierId!]).toMatchObject({ routeIndex: 4, x: 15, y: 0 });
    advanceTick(world);
    advanceTick(world);
    expect(world.carriers[link.carrierId!]).toBeUndefined();
    expect(link.status).toBe('source-empty');
    expect(inspectWorld(world)).toEqual([]);
  });

  it('reports a link whose endpoints no open route connects instead of moving items', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    // Built directly rather than placed, so the fixture can put a storage on the far side of
    // a wall of water and check that a link across it is reported instead of silently idling.
    const island = {
      ...center,
      id: toBuildingId('island-storage'),
      kind: 'storage' as const,
      x: center.x + 40,
      y: center.y + 40,
      inventoryCapacity: 200,
      recipeId: null,
      productionState: 'idle' as const,
      inventory: { ore: 5, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
    };
    const smelter = {
      ...center,
      id: toBuildingId('linked-smelter'),
      kind: 'smelter' as const,
      x: center.x + 1,
      inventoryCapacity: 20,
      maxHealth: 10,
      health: 10,
      recipeId: 'smelt-ore',
      productionState: 'idle' as const,
      inventory: emptyInventoryFixture(),
    };
    world.buildings[island.id] = island;
    world.buildings[smelter.id] = smelter;
    expect(
      applyCommand(world, {
        id: 'unreachable-link',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'createLogisticsLink',
        sourceBuildingId: island.id,
        targetBuildingId: smelter.id,
        item: 'ore',
      }).result.accepted,
    ).toBe(true);
    const link = Object.values(world.logisticsLinks)[0]!;
    // The bounded search cannot reach 80 tiles away, so the link says so rather than
    // pretending to work, and no carrier or item is created.
    expect(link).toMatchObject({ status: 'no-route', route: [], routeDistance: 0 });
    advanceTick(world);
    expect(world.carriers).toEqual({});
    expect(link.status).toBe('no-route');
    expect(island.inventory.ore).toBe(5);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('uses a higher-priority logistics link first when a producer has one input slot left', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 12;
    for (const [sequence, type, x] of [
      [1, 'placeSmelter', 12],
      [2, 'placeStorage', 13],
      [3, 'placeStorage', 14],
    ] as const)
      expect(
        applyCommand(world, {
          id: `${type}-${x}`,
          playerId: toPlayerId('player-a'),
          sequence,
          type,
          x,
          y: 0,
        }).result.accepted,
      ).toBe(true);
    for (let index = 0; index < 20; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const storages = Object.values(world.buildings).filter(
      (building) => building.kind === 'storage',
    );
    const [normalSource, urgentSource] = storages;
    if (!normalSource || !urgentSource) throw new Error('Expected both storage buildings.');
    smelter.jobPriority = 0;
    smelter.inventory.ore = smelter.inventoryCapacity - 1;
    normalSource.inventory.ore = 1;
    urgentSource.inventory.ore = 1;
    for (const [sequence, sourceBuildingId] of [
      [4, normalSource.id],
      [5, urgentSource.id],
    ] as const)
      expect(
        applyCommand(world, {
          id: `priority-link-${sequence}`,
          playerId: toPlayerId('player-a'),
          sequence,
          type: 'createLogisticsLink',
          sourceBuildingId,
          targetBuildingId: smelter.id,
          item: 'ore',
        }).result.accepted,
      ).toBe(true);
    const urgentLink = Object.values(world.logisticsLinks).find(
      (link) => link.sourceBuildingId === urgentSource.id,
    )!;
    expect(
      applyCommand(world, {
        id: 'set-urgent-link-priority',
        playerId: toPlayerId('player-a'),
        sequence: 6,
        type: 'setLogisticsPriority',
        linkId: urgentLink.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    // The urgent link reserves the last input slot, so only its carrier loads; the normal
    // link keeps its ore rather than sending a carrier that could not unload on arrival.
    advanceTick(world);
    expect(urgentSource.inventory.ore).toBe(0);
    expect(normalSource.inventory.ore).toBe(1);
    expect(world.logisticsLinks[urgentLink.id]?.status).toBe('in-transit');
    advanceTick(world);
    expect(smelter.inventory.ore).toBe(smelter.inventoryCapacity);
    expect(normalSource.inventory.ore).toBe(1);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('preserves recipe material and transport capacity invariants across generated cases', () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const world = createWorld(seed);
      joinPlayer(world, 'player-a');
      const center = world.buildings['center-player-a']!;
      const sourceId = `property-storage-${seed}`;
      const targetId = `property-smelter-${seed}`;
      const source = {
        ...center,
        id: toBuildingId(sourceId),
        kind: 'storage' as const,
        x: center.x + 1,
        inventory: { ore: (seed * 7) % 101, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
        inventoryCapacity: 200,
        populationCapacity: 0,
        jobPriority: 0 as const,
        recipeId: null,
        productionState: 'idle' as const,
      };
      const target = {
        ...center,
        id: toBuildingId(targetId),
        kind: 'smelter' as const,
        x: center.x + 2,
        inventory: { ore: (seed * 11) % 20, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
        inventoryCapacity: 20,
        populationCapacity: 0,
        jobPriority: 0 as const,
        recipeId: 'smelt-ore',
        productionState: 'idle' as const,
        progress: seed % 2 === 0 ? 3 : 0,
      };
      world.buildings[sourceId] = source;
      world.buildings[targetId] = target;
      expect(
        applyCommand(world, {
          id: `property-link-${seed}`,
          playerId: toPlayerId('player-a'),
          sequence: 1,
          type: 'createLogisticsLink',
          sourceBuildingId: source.id,
          targetBuildingId: target.id,
          item: 'ore',
        }).result.accepted,
      ).toBe(true);
      // Ore in flight lives in the carrier, so conservation now spans three places rather
      // than two: source stock, target stock, and whatever is on the road between them.
      const inFlight = () =>
        Object.values(world.carriers).reduce(
          (total, carrier) => total + (carrier.item === 'ore' ? carrier.cargo : 0),
          0,
        );
      const before = source.inventory.ore + target.inventory.ore + inFlight();
      // Long enough for a carrier to load, walk one tile, unload, and walk home again.
      for (let tickIndex = 0; tickIndex < 4; tickIndex += 1) advanceTick(world);
      const after = source.inventory.ore + target.inventory.ore + inFlight();
      expect(after).toBe(before);
      expect(source.inventory.ore).toBeGreaterThanOrEqual(0);
      expect(target.inventory.ore).toBeGreaterThanOrEqual(0);
      expect(target.inventory.ore + target.inventory.ingot).toBeLessThanOrEqual(
        target.inventoryCapacity,
      );
      expect(inspectWorld(world)).toEqual([]);

      const recipeWorld = createWorld(seed + 100);
      joinPlayer(recipeWorld, 'player-a');
      const recipeCenter = recipeWorld.buildings['center-player-a']!;
      const recipeSmelter = {
        ...recipeCenter,
        id: toBuildingId(`property-recipe-${seed}`),
        kind: 'smelter' as const,
        x: recipeCenter.x + 1,
        inventory: { ore: 1 + (seed % 5), wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 },
        inventoryCapacity: 20,
        populationCapacity: 0,
        jobPriority: 1 as const,
        recipeId: 'smelt-ore',
        productionState: 'idle' as const,
      };
      recipeWorld.buildings[recipeSmelter.id] = recipeSmelter;
      const initialMaterial = recipeSmelter.inventory.ore;
      for (let tickIndex = 0; tickIndex < initialMaterial * 4; tickIndex += 1)
        advanceTick(recipeWorld);
      expect(recipeSmelter.inventory.ore + recipeSmelter.inventory.ingot).toBe(initialMaterial);
      expect(recipeSmelter.inventory.ore + recipeSmelter.inventory.ingot).toBeLessThanOrEqual(
        recipeSmelter.inventoryCapacity,
      );
    }
  });

  it("routes producer output into only the next recipe's required inputs", () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 10;
    world.players['player-a']!.inventory.ingot = 1;
    applyCommand(world, {
      id: 'smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'research',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'research',
      technologyId: 'metallurgy',
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    applyCommand(world, {
      id: 'workshop',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'placeWorkshop',
      x: 13,
      y: 0,
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    const workshop = Object.values(world.buildings).find(
      (building) => building.kind === 'workshop',
    )!;
    smelter.inventory.ingot = 1;
    expect(
      applyCommand(world, {
        id: 'ingot-link',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'createLogisticsLink',
        sourceBuildingId: smelter.id,
        targetBuildingId: workshop.id,
        item: 'ingot',
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'wrong-input',
        playerId: toPlayerId('player-a'),
        sequence: 5,
        type: 'createLogisticsLink',
        sourceBuildingId: workshop.id,
        targetBuildingId: smelter.id,
        item: 'ingot',
      }).result,
    ).toMatchObject({ code: 'invalid-logistics-link' });
    advanceTick(world);
    // The ingot leaves the smelter with the carrier and arrives on the following tick,
    // and no return link exists to carry it back the other way.
    expect(smelter.inventory.ingot).toBe(0);
    expect(workshop.inventory.ingot).toBe(0);
    advanceTick(world);
    expect(workshop.inventory.ingot).toBe(1);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('assigns limited workers to the highest-priority smelters deterministically', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 6;
    applyCommand(world, {
      id: 'first-smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'second-smelter',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'placeSmelter',
      x: 13,
      y: 0,
    });
    const smelters = Object.values(world.buildings)
      .filter((building) => building.kind === 'smelter')
      .sort((left, right) => left.x - right.x);
    const lowPriority = smelters[0]!;
    const highPriority = smelters[1]!;
    applyCommand(world, {
      id: 'high-priority',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'setJobPriority',
      buildingId: highPriority.id,
      priority: 3,
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    world.players['player-a']!.population.total = 1;
    lowPriority.inventory.ore = 1;
    highPriority.inventory.ore = 1;
    advanceTick(world);
    expect(world.players['player-a']?.population).toMatchObject({ employed: 1, unemployed: 0 });
    expect(lowPriority.progress).toBe(0);
    expect(highPriority.progress).toBe(3);
  });

  it('rotates equal-priority jobs so lower-ID producers do not monopolize workers', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 6;
    for (const [sequence, x] of [
      [1, 12],
      [2, 13],
    ] as const)
      applyCommand(world, {
        id: `equal-priority-${sequence}`,
        playerId: toPlayerId('player-a'),
        sequence,
        type: 'placeSmelter',
        x,
        y: 0,
      });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const smelters = Object.values(world.buildings).filter(
      (building) => building.kind === 'smelter',
    );
    world.players['player-a']!.population.total = 1;
    for (const smelter of smelters) smelter.inventory.ore = 1;
    advanceTick(world);
    advanceTick(world);
    expect(smelters.map((smelter) => smelter.progress)).toEqual([3, 3]);
  });

  it('switches idle producer recipes without changing inventory and rejects mid-batch changes', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 4;
    player.research.unlocked.metallurgy = true;
    player.research.unlocked.engineering = true;
    expect(
      applyCommand(world, {
        id: 'workshop',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeWorkshop',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const workshop = Object.values(world.buildings).find(
      (building) => building.kind === 'workshop',
    )!;
    workshop.inventory.ingot = 2;
    const inventoryBeforeSwitch = structuredClone(workshop.inventory);
    expect(
      applyCommand(world, {
        id: 'set-alternate-recipe',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'forge-tool-without-wood',
      }).result.accepted,
    ).toBe(true);
    expect(workshop.recipeId).toBe('forge-tool-without-wood');
    expect(workshop.inventory).toEqual(inventoryBeforeSwitch);
    advanceTick(world);
    expect(workshop.progress).toBe(6);
    expect(workshop.inventory).toEqual({ ore: 0, wood: 0, stone: 0, ingot: 0, brick: 0, tool: 0 });
    expect(
      applyCommand(world, {
        id: 'change-busy-recipe',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'forge-tool',
      }).result,
    ).toMatchObject({ accepted: false, code: 'busy' });
    for (let index = 0; index < 6; index += 1) advanceTick(world);
    expect(workshop.inventory.tool).toBe(2);
    expect(
      applyCommand(world, {
        id: 'invalid-recipe',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'smelt-ore',
      }).result,
    ).toMatchObject({ accepted: false, code: 'invalid-recipe' });
  });

  it('refills logistics targets within configured stock bounds and records throughput', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    for (const [sequence, type, x] of [
      [1, 'placeSmelter', 12],
      [2, 'placeStorage', 13],
    ] as const)
      applyCommand(world, {
        id: `stock-${type}`,
        playerId: toPlayerId('player-a'),
        sequence,
        type,
        x,
        y: 0,
      });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const source = Object.values(world.buildings).find((building) => building.kind === 'storage')!;
    const target = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    target.jobPriority = 0;
    source.inventory.ore = 10;
    target.inventory.ore = 2;
    applyCommand(world, {
      id: 'bounded-link',
      playerId: toPlayerId('player-a'),
      sequence: 3,
      type: 'createLogisticsLink',
      sourceBuildingId: source.id,
      targetBuildingId: target.id,
      item: 'ore',
    });
    const link = Object.values(world.logisticsLinks)[0]!;
    expect(
      applyCommand(world, {
        id: 'bounded-stock',
        playerId: toPlayerId('player-a'),
        sequence: 4,
        type: 'setLogisticsStockTarget',
        linkId: link.id,
        minimum: 3,
        maximum: 5,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(world.carriers[link.carrierId!]?.cargo).toBe(3);
    advanceTick(world);
    expect(target.inventory.ore).toBe(5);
    expect(link.deliveredTotal).toBe(3);
    expect(link.recentDeliveries).toEqual([{ tick: world.tick, amount: 3 }]);
    advanceTick(world);
    advanceTick(world);
    expect(link.status).toBe('target-satisfied');
    expect(source.inventory.ore).toBe(7);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('gives each permanent development branch its own efficient workshop recipe', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const player = world.players['player-a']!;
    player.inventory.wood = 4;
    player.research.unlocked.metallurgy = true;
    applyCommand(world, {
      id: 'branch-workshop',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeWorkshop',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    const workshop = Object.values(world.buildings).find(
      (building) => building.kind === 'workshop',
    )!;
    expect(
      applyCommand(world, {
        id: 'locked-engineering-recipe',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'forge-tool-without-wood',
      }).result,
    ).toMatchObject({ accepted: false, code: 'technology-locked' });
    player.research.unlocked.stewardship = true;
    expect(
      applyCommand(world, {
        id: 'steward-recipe',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'steward-tool-batch',
      }).result.accepted,
    ).toBe(true);
    workshop.inventory.ingot = 1;
    workshop.inventory.wood = 2;
    for (let index = 0; index < 8; index += 1) advanceTick(world);
    expect(workshop.inventory.tool).toBe(2);
    expect(inspectWorld(world)).toEqual([]);
  });

  it('copies compatible idle producer configuration without affecting inventory or active batches', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    const source = {
      ...center,
      id: toBuildingId('copy-source'),
      kind: 'workshop' as const,
      x: center.x + 1,
      inventory: { ore: 0, wood: 0, stone: 0, ingot: 2, brick: 0, tool: 0 },
      inventoryCapacity: 30,
      populationCapacity: 0,
      jobPriority: 3 as const,
      recipeId: 'forge-tool-without-wood',
      productionState: 'idle' as const,
    };
    const target = {
      ...source,
      id: toBuildingId('copy-target'),
      x: center.x + 2,
      inventory: { ore: 0, wood: 1, stone: 0, ingot: 1, brick: 0, tool: 0 },
      jobPriority: 0 as const,
      recipeId: 'forge-tool',
    };
    world.buildings[source.id] = source;
    world.buildings[target.id] = target;
    const inventoryBefore = structuredClone(target.inventory);
    expect(
      applyCommand(world, {
        id: 'copy-config',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'copyBuildingConfiguration',
        sourceBuildingId: source.id,
        targetBuildingId: target.id,
      }).result.accepted,
    ).toBe(true);
    expect(target).toMatchObject({
      recipeId: 'forge-tool-without-wood',
      jobPriority: 3,
      inventory: inventoryBefore,
    });
    target.progress = 2;
    expect(
      applyCommand(world, {
        id: 'copy-active-target',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'copyBuildingConfiguration',
        sourceBuildingId: source.id,
        targetBuildingId: target.id,
      }).result,
    ).toMatchObject({ accepted: false, code: 'busy' });
  });

  it('derives settlement satisfaction from shelter and available work', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    advanceTick(world);
    expect(world.players['player-a']?.population.satisfaction).toBe(60);
    applyCommand(world, {
      id: 'smelter',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 11; index += 1) advanceTick(world);
    expect(world.players['player-a']?.population.satisfaction).toBe(80);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    applyCommand(world, {
      id: 'pause-work',
      playerId: toPlayerId('player-a'),
      sequence: 2,
      type: 'setJobPriority',
      buildingId: smelter.id,
      priority: 0,
    });
    advanceTick(world);
    expect(world.players['player-a']?.population.satisfaction).toBe(60);
  });

  it('adds hearth wellbeing to the settlement satisfaction breakdown', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'hearth',
        playerId: toPlayerId('player-a'),
        sequence: 1,
        type: 'placeHearth',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 6; index += 1) advanceTick(world);
    expect(world.players['player-a']?.population.satisfaction).toBe(80);
  });

  it('migrates transfer-era snapshots to private individual settlements', () => {
    const legacy = createWorld() as unknown as {
      schemaVersion: 7;
      settlements?: unknown;
    };
    joinPlayer(legacy as never, 'player-a');
    legacy.schemaVersion = 7;
    delete legacy.settlements;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(31);
    expect(migrated.settlements['settlement-player-a']?.members['player-a']).toBe('owner');
  });

  it('allows destroyed buildings to be repaired or removed for recovery', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'build',
      playerId: toPlayerId('player-a'),
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    smelter.health = 0;
    expect(
      applyCommand(world, {
        id: 'repair',
        playerId: toPlayerId('player-a'),
        sequence: 2,
        type: 'repair',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(smelter.health).toBe(2);
    smelter.health = 0;
    expect(
      applyCommand(world, {
        id: 'demolish',
        playerId: toPlayerId('player-a'),
        sequence: 3,
        type: 'demolish',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(world.buildings[smelter.id]).toBeUndefined();
  });

  it('reports checkpoint invariant violations without mutating the world', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.buildings.invalid = {
      ...world.buildings['center-player-a']!,
      id: toBuildingId('invalid'),
      ownerId: toPlayerId('missing-player'),
      x: 12,
      y: 0,
    };
    const before = stateHash(world);
    expect(inspectWorld(world)).toContain('building invalid has unknown owner missing-player');
    expect(stateHash(world)).toBe(before);
  });

  it('detects malformed integer state and globally duplicated entity IDs', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.tick = 1.5;
    world.players['player-a']!.population.total = -1;
    world.buildings.invalid = {
      ...world.buildings['center-player-a']!,
      id: toBuildingId('player-a'),
      x: 0.5,
    };
    world.minedTiles['0:0'] = resources.mountain.yield + 1;
    expect(inspectWorld(world)).toEqual(
      expect.arrayContaining([
        'world has an invalid tick',
        'player player-a has invalid population',
        'entity id player-a is shared by player and building',
        'building invalid has invalid coordinates',
        'mined tile 0:0 has an invalid depletion value',
      ]),
    );
  });

  it('runs bot load scenarios deterministically without invariant errors', () => {
    const first = runBotScenario(12, 200);
    const second = runBotScenario(12, 200);
    expect(first.hash).toBe(second.hash);
    expect(first.commandCount).toBeGreaterThan(0);
    expect(first.invariantErrors).toEqual([]);
    expect(first.botActions).toMatchObject({
      gather: expect.any(Number),
      build: 48,
      research: 24,
      trade: 1,
      reconnect: 12,
    });
    expect(first.botActions.gather).toBeGreaterThan(0);
    expect(
      Object.values(first.state.buildings)
        .filter((building) => building.kind === 'workshop')
        .reduce((total, building) => total + building.inventory.tool, 0),
    ).toBeGreaterThan(0);
  });

  it('runs progression bots through expansion and active threat response', () => {
    const result = runBotScenario(2, 500);
    expect(result.botActions.research).toBeGreaterThanOrEqual(4);
    expect(result.botActions.expand).toBe(1);
    expect(result.botActions.defend).toBeGreaterThan(0);
    expect(result.botActions.trade).toBe(1);
    expect(result.botActions.reconnect).toBe(2);
    expect(result.invariantErrors).toEqual([]);
  });

  // These two scenarios run the target-density workload twice, so they need more than
  // the default per-test budget on a loaded machine.
  it('supports a target-density bot workload without changing its deterministic result', () => {
    const first = runBotScenario(20, 500, 50);
    const second = runBotScenario(20, 500, 50);
    expect(first.hash).toBe(second.hash);
    expect(Object.keys(first.state.buildings)).toHaveLength(1_000);
    expect(first.botActions.defend).toBeGreaterThan(0);
    expect(first.invariantErrors).toEqual([]);
  }, 30_000);

  it('keeps a multi-settlement simulation stable through a long headless run', () => {
    const first = runBotScenario(4, 1_000, 50);
    const second = runBotScenario(4, 1_000, 50);
    expect(first.hash).toBe(second.hash);
    expect(first.invariantErrors).toEqual([]);
    for (const player of Object.values(first.state.players)) {
      expect(player.population.total).toBeGreaterThanOrEqual(2);
      expect(player.population.total).toBeLessThanOrEqual(player.population.capacity);
      expect(player.population.satisfaction).toBeGreaterThanOrEqual(0);
      expect(player.population.satisfaction).toBeLessThanOrEqual(100);
    }
    expect(
      Object.values(first.state.buildings)
        .filter((building) => building.kind === 'workshop')
        .reduce((total, building) => total + building.inventory.tool, 0),
    ).toBeGreaterThan(0);
  }, 30_000);

  it('runs a deterministic thousand-pair logistics stress scenario without loss or invariant errors', () => {
    const first = runInfrastructureStressScenario();
    const second = runInfrastructureStressScenario();
    expect(first.hash).toBe(second.hash);
    expect(Object.keys(first.state.buildings)).toHaveLength(2_001);
    expect(Object.keys(first.state.logisticsLinks)).toHaveLength(1_000);
    expect(
      Object.values(first.state.buildings)
        .filter((building) => building.kind === 'storage')
        .reduce((total, building) => total + building.inventory.ore, 0),
    ).toBe(0);
    expect(
      Object.values(first.state.buildings)
        .filter((building) => building.kind === 'smelter')
        .reduce((total, building) => total + building.inventory.ore, 0),
    ).toBe(1_000);
    expect(first.invariantErrors).toEqual([]);
  });

  it('reports every deterministic tick phase for the infrastructure stress profile', () => {
    let clock = 0;
    const profile = profileInfrastructureStressScenario(
      () => {
        clock += 1;
        return clock;
      },
      1_000,
      2,
    );
    expect(profile.phaseDurationsMs).toEqual({
      'advance-clock': 2,
      'research-and-population': 2,
      'construction-and-production': 2,
      'environmental-events': 2,
      logistics: 2,
      'threat-spawning': 2,
      'threat-navigation-and-combat': 2,
      'emit-events-and-mark-changes': 2,
    });
    expect(profile.result.invariantErrors).toEqual([]);
  });
});
