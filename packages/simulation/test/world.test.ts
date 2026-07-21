import { describe, expect, it } from 'vitest';
import { findPath } from '@kings/pathfinding';
import {
  applyCommand,
  advanceTick,
  chunkCoordinate,
  chunkCoordinateFor,
  createWorld,
  deserializeWorld,
  FixedStepRunner,
  diffWorld,
  indexEntitiesByChunk,
  inspectWorld,
  joinPlayer,
  nearestOreTile,
  nearestResourceTile,
  neighboringChunks,
  nextRandom,
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

describe('world simulation', () => {
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
        playerId: 'player-a' as never,
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

  it('allocates buildable, non-overlapping settlement plots in the shared world', () => {
    const world = createWorld(99);
    for (let index = 0; index < 64; index += 1) joinPlayer(world, `player-${index}`);
    const plots = Object.values(world.players).map((player) => player.plot);
    for (const [index, plot] of plots.entries()) {
      const center = world.buildings[`center-player-${index}`]!;
      expect(terrainAt(world.seed, center.x, center.y)).not.toBe('water');
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'gather',
        ...oreTileFor(world),
      });
      applyCommand(world, {
        id: 'build-1',
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeStorage',
      x: 12,
      y: 0,
    });
    applyCommand(first, {
      id: 'housing',
      playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'gather',
        x: 0.5,
        y: 0,
      }).result,
    ).toMatchObject({ accepted: false, code: 'invalid-coordinate' });
    expect(
      applyCommand(world, {
        id: 'fractional-sequence',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'gather',
      ...oreTileFor(world),
    });
    expect(
      applyCommand(world, {
        id: 'load-ore',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    expect(world.players['player-a']?.inventory.wood).toBe(2);
    expect(smelter.constructionMaterials).toEqual({ ore: 0, wood: 3, ingot: 0, tool: 0 });
    world.players['player-a']!.population.total = 0;
    advanceTick(world);
    expect(smelter).toMatchObject({ constructionTicks: 10, constructionMaterials: { wood: 3 } });
    world.players['player-a']!.population.total = 1;
    advanceTick(world);
    expect(smelter).toMatchObject({ constructionTicks: 9, constructionMaterials: { wood: 2 } });
    expect(world.players['player-a']?.population).toMatchObject({ employed: 1, unemployed: 0 });
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'gather',
        ...grassTile,
      }).result,
    ).toMatchObject({ code: 'resource-depleted' });
    expect(
      applyCommand(world, {
        id: 'gather-ore',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    const smelter = Object.values(world.buildings).find((building) => building.kind === 'smelter')!;
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    applyCommand(world, {
      id: 'gather',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'gather',
      ...oreTileFor(world),
    });
    applyCommand(world, {
      id: 'load',
      playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
    expect(deserializeWorld(legacy).buildings.center?.inventory).toEqual({
      ore: 0,
      wood: 0,
      ingot: 0,
      tool: 0,
    });
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
    expect(migrated.schemaVersion).toBe(19);
    expect(migrated.players['player-a']?.inventory.tool).toBe(0);
    expect(migrated.buildings['center-player-a']?.inventory.tool).toBe(0);
  });

  it('upgrades version 14 snapshots with a deterministic random state', () => {
    const legacy = createWorld(27) as unknown as { schemaVersion: 14; randomState?: number };
    legacy.schemaVersion = 14;
    delete legacy.randomState;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(19);
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
      id: 'legacy-workshop' as never,
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
    expect(migrated.schemaVersion).toBe(19);
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
          throughputPerTick?: number;
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
    expect(migrated.schemaVersion).toBe(19);
    expect(migrated.buildings['center-player-a']?.productionState).toBe('idle');
    expect(migrated.logisticsLinks.legacy).toMatchObject({
      throughputPerTick: 1,
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
    expect(migrated.schemaVersion).toBe(19);
    expect(migrated.buildings['center-player-a']?.constructionMaterials).toEqual({
      ore: 0,
      wood: 0,
      ingot: 0,
      tool: 0,
    });
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
    expect(migrated.schemaVersion).toBe(19);
    expect(migrated.minedTiles[`${node.x}:${node.y}`]).toBe(3);
  });

  it('adds settlement capacity and grows aggregated population', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'housing',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 3,
        type: 'claimTerritory',
        x: 24,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'claim-before-explore',
        playerId: 'player-a' as never,
        sequence: 4,
        type: 'claimTerritory',
        x: 32,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'not-explored' });
    applyCommand(world, {
      id: 'explore',
      playerId: 'player-a' as never,
      sequence: 5,
      type: 'explore',
      x: 32,
      y: 0,
    });
    expect(
      applyCommand(world, {
        id: 'claim',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-b' as never,
        sequence: 1,
        type: 'moveScout',
        scoutId: scout.id,
        ...target,
      }).result,
    ).toMatchObject({ accepted: false, code: 'unauthorized' });
    expect(
      applyCommand(world, {
        id: 'move-own-scout',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'workshop-too-early',
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'placeWorkshop',
        x: 13,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'technology-locked' });
    expect(
      applyCommand(world, {
        id: 'research',
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'research',
        technologyId: 'metallurgy',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'workshop',
        playerId: 'player-a' as never,
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
    const world = createWorld();
    joinPlayer(world, 'player-a');
    expect(
      applyCommand(world, {
        id: 'smelter',
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'tower',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'research',
        technologyId: 'metallurgy',
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    expect(
      applyCommand(world, {
        id: 'tower',
        playerId: 'player-a' as never,
        sequence: 3,
        type: 'placeWatchtower',
        x: 13,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 150; index += 1) advanceTick(world);
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
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'placeSmelter',
        x: 12,
        y: 0,
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 99; index += 1) advanceTick(world);
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
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'repair',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(smelter.progress).toBe(2);
  });

  it('navigates raiders toward their target before they can deal damage', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'smelter',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    for (let index = 0; index < 150; index += 1) advanceTick(world);
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
      id: 'dynamic-blocker' as never,
      kind: 'storage',
      x: blockedTile.x,
      y: blockedTile.y,
      inventory: { ore: 0, wood: 0, ingot: 0, tool: 0 },
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
      const x = Array.from({ length: 16 }, (_, offset) => -24 + offset).find(
        (candidate) => terrainAt(world.seed, candidate, y) !== 'water',
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

  it('transfers resources atomically between players and rejects duplicate retries', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const command = {
      id: 'gift',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'transferToPlayer' as const,
      targetPlayerId: 'player-b' as never,
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

  it('enforces settlement roles while allowing delegated building and logistics work', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    expect(
      applyCommand(world, {
        id: 'invite',
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'inviteToSettlement',
        settlementId: 'settlement-player-a',
        targetPlayerId: 'player-b' as never,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'accept',
        playerId: 'player-b' as never,
        sequence: 1,
        type: 'acceptSettlementInvite',
        settlementId: 'settlement-player-a',
      }).result.accepted,
    ).toBe(true);
    applyCommand(world, {
      id: 'make-builder',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
      role: 'builder',
    });
    applyCommand(world, {
      id: 'build',
      playerId: 'player-a' as never,
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
        playerId: 'player-b' as never,
        sequence: 2,
        type: 'repair',
        buildingId: smelter.id,
      }).result.accepted,
    ).toBe(true);
    expect(smelter.health).toBe(3);
    expect(
      applyCommand(world, {
        id: 'blocked-load',
        playerId: 'player-b' as never,
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
      playerId: 'player-a' as never,
      sequence: 4,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
      role: 'logistics',
    });
    expect(
      applyCommand(world, {
        id: 'load',
        playerId: 'player-b' as never,
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
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    applyCommand(world, {
      id: 'accept',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    expect(
      applyCommand(world, {
        id: 'transfer-owner',
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'transferSettlementOwnership',
        settlementId: 'settlement-player-a',
        targetPlayerId: 'player-b' as never,
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']).toMatchObject({
      ownerId: 'player-b',
      members: { 'player-a': 'member', 'player-b': 'owner' },
    });
    expect(
      applyCommand(world, {
        id: 'leave-after-transfer',
        playerId: 'player-a' as never,
        sequence: 3,
        type: 'leaveSettlement',
        settlementId: 'settlement-player-a',
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']?.members['player-a']).toBeUndefined();
    expect(inspectWorld(world)).toEqual([]);
  });

  it("lets settlement owners revoke a member's delegated building permissions", () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    applyCommand(world, {
      id: 'invite',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    applyCommand(world, {
      id: 'accept',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    applyCommand(world, {
      id: 'make-builder',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
      role: 'builder',
    });
    applyCommand(world, {
      id: 'build',
      playerId: 'player-a' as never,
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
        playerId: 'player-b' as never,
        sequence: 2,
        type: 'setJobPriority',
        buildingId: smelter.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    expect(
      applyCommand(world, {
        id: 'remove-member',
        playerId: 'player-a' as never,
        sequence: 4,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: 'player-b' as never,
      }).result.accepted,
    ).toBe(true);
    expect(world.settlements['settlement-player-a']?.members['player-b']).toBeUndefined();
    expect(
      applyCommand(world, {
        id: 'revoked-priority',
        playerId: 'player-b' as never,
        sequence: 3,
        type: 'setJobPriority',
        buildingId: smelter.id,
        priority: 1,
      }).result,
    ).toMatchObject({ code: 'settlement-permission-denied' });
    expect(
      applyCommand(world, {
        id: 'remove-owner',
        playerId: 'player-a' as never,
        sequence: 5,
        type: 'removeSettlementMember',
        settlementId: 'settlement-player-a',
        targetPlayerId: 'player-a' as never,
      }).result,
    ).toMatchObject({ code: 'cannot-remove-settlement-owner' });
  });

  it('refunds the exact construction cost when cancelling', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'storage',
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'cancelConstruction',
        buildingId: storage.id,
      }).result.accepted,
    ).toBe(true);
    expect(world.players['player-a']?.inventory.wood).toBe(5);
  });

  it('moves storage items through deterministic logistics links without duplication', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'smelter',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'storage',
      playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'createLogisticsLink' as const,
      sourceBuildingId: storage.id,
      targetBuildingId: smelter.id,
      item: 'ore' as const,
    };
    expect(applyCommand(world, link).result.accepted).toBe(true);
    expect(applyCommand(world, link).result).toMatchObject({ code: 'duplicate-command' });
    advanceTick(world);
    expect(storage.inventory.ore).toBe(1);
    expect(smelter.inventory.ore).toBe(1);
    expect(Object.keys(world.logisticsLinks)).toHaveLength(1);
    const createdLink = Object.values(world.logisticsLinks)[0]!;
    expect(createdLink).toMatchObject({ throughputPerTick: 1, status: 'transferred' });
    expect(
      applyCommand(world, {
        id: 'prioritize-link',
        playerId: 'player-a' as never,
        sequence: 4,
        type: 'setLogisticsPriority',
        linkId: createdLink.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    expect(world.logisticsLinks[createdLink.id]?.priority).toBe(3);
    storage.inventory.ore = 1;
    smelter.inventory = { ore: smelter.inventoryCapacity - 1, wood: 0, ingot: 0, tool: 0 };
    smelter.progress = 3;
    advanceTick(world);
    expect(world.logisticsLinks[createdLink.id]?.status).toBe('target-full');
    expect(storage.inventory.ore).toBe(1);
    delete world.buildings[storage.id];
    advanceTick(world);
    expect(Object.keys(world.logisticsLinks)).toHaveLength(0);
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
          playerId: 'player-a' as never,
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
          playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 6,
        type: 'setLogisticsPriority',
        linkId: urgentLink.id,
        priority: 3,
      }).result.accepted,
    ).toBe(true);
    advanceTick(world);
    expect(smelter.inventory.ore).toBe(smelter.inventoryCapacity);
    expect(urgentSource.inventory.ore).toBe(0);
    expect(normalSource.inventory.ore).toBe(1);
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
        id: sourceId as never,
        kind: 'storage' as const,
        x: center.x + 1,
        inventory: { ore: (seed * 7) % 101, wood: 0, ingot: 0, tool: 0 },
        inventoryCapacity: 200,
        populationCapacity: 0,
        jobPriority: 0 as const,
        recipeId: null,
        productionState: 'idle' as const,
      };
      const target = {
        ...center,
        id: targetId as never,
        kind: 'smelter' as const,
        x: center.x + 2,
        inventory: { ore: (seed * 11) % 20, wood: 0, ingot: 0, tool: 0 },
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
          playerId: 'player-a' as never,
          sequence: 1,
          type: 'createLogisticsLink',
          sourceBuildingId: source.id,
          targetBuildingId: target.id,
          item: 'ore',
        }).result.accepted,
      ).toBe(true);
      const before = source.inventory.ore + target.inventory.ore;
      advanceTick(world);
      const after = source.inventory.ore + target.inventory.ore;
      expect(after).toBe(before);
      expect(source.inventory.ore).toBeGreaterThanOrEqual(0);
      expect(target.inventory.ore).toBeGreaterThanOrEqual(0);
      expect(target.inventory.ore + target.inventory.ingot).toBeLessThanOrEqual(
        target.inventoryCapacity,
      );

      const recipeWorld = createWorld(seed + 100);
      joinPlayer(recipeWorld, 'player-a');
      const recipeCenter = recipeWorld.buildings['center-player-a']!;
      const recipeSmelter = {
        ...recipeCenter,
        id: `property-recipe-${seed}` as never,
        kind: 'smelter' as const,
        x: recipeCenter.x + 1,
        inventory: { ore: 1 + (seed % 5), wood: 0, ingot: 0, tool: 0 },
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
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'research',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'research',
      technologyId: 'metallurgy',
    });
    for (let index = 0; index < 10; index += 1) advanceTick(world);
    applyCommand(world, {
      id: 'workshop',
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 5,
        type: 'createLogisticsLink',
        sourceBuildingId: workshop.id,
        targetBuildingId: smelter.id,
        item: 'ingot',
      }).result,
    ).toMatchObject({ code: 'invalid-logistics-link' });
    advanceTick(world);
    expect(smelter.inventory.ingot).toBe(0);
    expect(workshop.inventory.ingot).toBe(1);
  });

  it('assigns limited workers to the highest-priority smelters deterministically', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.wood = 6;
    applyCommand(world, {
      id: 'first-smelter',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    applyCommand(world, {
      id: 'second-smelter',
      playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
    expect(
      applyCommand(world, {
        id: 'workshop',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'forge-tool-without-wood',
      }).result.accepted,
    ).toBe(true);
    expect(workshop.recipeId).toBe('forge-tool-without-wood');
    expect(workshop.inventory).toEqual(inventoryBeforeSwitch);
    advanceTick(world);
    expect(workshop.progress).toBe(4);
    expect(workshop.inventory).toEqual({ ore: 0, wood: 0, ingot: 0, tool: 0 });
    expect(
      applyCommand(world, {
        id: 'change-busy-recipe',
        playerId: 'player-a' as never,
        sequence: 3,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'forge-tool',
      }).result,
    ).toMatchObject({ accepted: false, code: 'busy' });
    for (let index = 0; index < 4; index += 1) advanceTick(world);
    expect(workshop.inventory.tool).toBe(1);
    expect(
      applyCommand(world, {
        id: 'invalid-recipe',
        playerId: 'player-a' as never,
        sequence: 4,
        type: 'setRecipe',
        buildingId: workshop.id,
        recipeId: 'smelt-ore',
      }).result,
    ).toMatchObject({ accepted: false, code: 'invalid-recipe' });
  });

  it('copies compatible idle producer configuration without affecting inventory or active batches', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    const source = {
      ...center,
      id: 'copy-source' as never,
      kind: 'workshop' as const,
      x: center.x + 1,
      inventory: { ore: 0, wood: 0, ingot: 2, tool: 0 },
      inventoryCapacity: 30,
      populationCapacity: 0,
      jobPriority: 3 as const,
      recipeId: 'forge-tool-without-wood',
      productionState: 'idle' as const,
    };
    const target = {
      ...source,
      id: 'copy-target' as never,
      x: center.x + 2,
      inventory: { ore: 0, wood: 1, ingot: 1, tool: 0 },
      jobPriority: 0 as const,
      recipeId: 'forge-tool',
    };
    world.buildings[source.id] = source;
    world.buildings[target.id] = target;
    const inventoryBefore = structuredClone(target.inventory);
    expect(
      applyCommand(world, {
        id: 'copy-config',
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
    expect(migrated.schemaVersion).toBe(19);
    expect(migrated.settlements['settlement-player-a']?.members['player-a']).toBe('owner');
  });

  it('allows destroyed buildings to be repaired or removed for recovery', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    applyCommand(world, {
      id: 'build',
      playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
        playerId: 'player-a' as never,
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
      id: 'invalid',
      ownerId: 'missing-player' as never,
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
      id: 'player-a' as never,
      x: 0.5,
    };
    world.minedTiles['0:0'] = 11;
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
    expect(
      Object.values(first.state.buildings)
        .filter((building) => building.kind === 'workshop')
        .reduce((total, building) => total + building.inventory.tool, 0),
    ).toBeGreaterThan(0);
  });

  it('supports a target-density bot workload without changing its deterministic result', () => {
    const first = runBotScenario(2, 30, 50);
    const second = runBotScenario(2, 30, 50);
    expect(first.hash).toBe(second.hash);
    expect(Object.keys(first.state.buildings)).toHaveLength(100);
    expect(first.invariantErrors).toEqual([]);
  });

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
  });

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
