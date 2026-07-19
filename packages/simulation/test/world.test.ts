import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  advanceTick,
  createWorld,
  deserializeWorld,
  inspectWorld,
  joinPlayer,
  runBotScenario,
  stateHash,
  terrainAt,
} from '../src/index.js';

describe('world simulation', () => {
  it('replays identical commands to an identical hash', () => {
    const run = () => {
      const world = createWorld(99);
      joinPlayer(world, 'player-a');
      applyCommand(world, {
        id: 'gather-1',
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'gather',
        x: 12,
        y: 0,
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

  it('rejects duplicate commands without mutation', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const command = {
      id: 'gather-1',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'gather' as const,
      x: 12,
      y: 0,
    };
    expect(applyCommand(world, command).result.accepted).toBe(true);
    const hash = stateHash(world);
    expect(applyCommand(world, command).result).toMatchObject({
      accepted: false,
      code: 'duplicate-command',
    });
    expect(stateHash(world)).toBe(hash);
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
      x: 12,
      y: 0,
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
      x: 12,
      y: 0,
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
    });
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

  it('requires research and exploration before adjacent territory can be claimed', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.inventory.ingot = 3;
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
      }).result.accepted,
    ).toBe(true);
    for (let index = 0; index < 159; index += 1) advanceTick(world);
    expect(Object.keys(world.threats)).toHaveLength(0);
    expect(
      Object.values(world.buildings).find((building) => building.kind === 'smelter')?.health,
    ).toBeGreaterThan(0);
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

  it('migrates transfer-era snapshots to private individual settlements', () => {
    const legacy = createWorld() as unknown as {
      schemaVersion: 7;
      settlements?: unknown;
    };
    joinPlayer(legacy as never, 'player-a');
    legacy.schemaVersion = 7;
    delete legacy.settlements;
    const migrated = deserializeWorld(legacy);
    expect(migrated.schemaVersion).toBe(11);
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

  it('runs bot load scenarios deterministically without invariant errors', () => {
    const first = runBotScenario(12, 200);
    const second = runBotScenario(12, 200);
    expect(first.hash).toBe(second.hash);
    expect(first.commandCount).toBeGreaterThan(0);
    expect(first.invariantErrors).toEqual([]);
  });
});
