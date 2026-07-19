import { describe, expect, it } from 'vitest';
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
    for (let index = 0; index < 3; index += 1) advanceTick(world);
    expect(world.buildings[smelter.id]?.inventory.ingot).toBe(1);
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
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.players['player-a']?.inventory.tool).toBe(0);
    expect(migrated.buildings['center-player-a']?.inventory.tool).toBe(0);
  });

  it('upgrades version 14 snapshots with a deterministic random state', () => {
    const legacy = createWorld(27) as unknown as { schemaVersion: 14; randomState?: number };
    legacy.schemaVersion = 14;
    delete legacy.randomState;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(15);
    expect(migrated.randomState).toBeGreaterThan(0);
    expect(inspectWorld(migrated)).toEqual([]);
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
    expect(migrated.schemaVersion).toBe(15);
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
    expect(
      applyCommand(world, {
        id: 'claim-before-explore',
        playerId: 'player-a' as never,
        sequence: 3,
        type: 'claimTerritory',
        x: 24,
        y: 0,
      }).result,
    ).toMatchObject({ code: 'not-explored' });
    applyCommand(world, {
      id: 'explore',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'explore',
      x: 24,
      y: 0,
    });
    expect(
      applyCommand(world, {
        id: 'claim',
        playerId: 'player-a' as never,
        sequence: 4,
        type: 'claimTerritory',
        x: 24,
        y: 0,
      }).result.accepted,
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
    delete world.buildings[storage.id];
    advanceTick(world);
    expect(Object.keys(world.logisticsLinks)).toHaveLength(0);
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
    expect(migrated.schemaVersion).toBe(15);
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
});
