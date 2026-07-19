import { describe, expect, it } from 'vitest';
import {
  type Connection,
  GlobalWorldHost,
  INITIAL_MIGRATION_SQL,
  MemoryWorldPersistence,
  snapshotDirtyChunk,
  type WorldPersistence,
} from '../src/index.js';
import {
  advanceTick,
  chunkKeyFor,
  createWorld,
  joinPlayer,
  nearestOreTile,
} from '@kings/simulation';
import { parseEnvironment } from '../src/env.js';

const connection = (): Connection & { messages: string[] } => ({
  messages: [],
  send(message) {
    this.messages.push(message);
  },
  close() {},
});
const oreTileFor = (host: GlobalWorldHost, playerId = 'player-a') => {
  const player = host.world.players[playerId]!;
  const tile = nearestOreTile(
    host.world.seed,
    player.plot.x + Math.floor(player.plot.size / 2),
    player.plot.y + Math.floor(player.plot.size / 2),
    8,
  );
  if (!tile) throw new Error(`Expected a nearby ore deposit for ${playerId}`);
  return tile;
};

class InterruptedCheckpointPersistence extends MemoryWorldPersistence {
  interruptNextCheckpoint = false;

  override async saveCheckpoint(
    state: Parameters<MemoryWorldPersistence['saveCheckpoint']>[0],
    dirtyChunks?: Parameters<MemoryWorldPersistence['saveCheckpoint']>[1],
  ) {
    if (this.interruptNextCheckpoint) throw new Error('checkpoint writer interrupted');
    return super.saveCheckpoint(state, dirtyChunks);
  }
}

describe('durable world recovery', () => {
  it('defines the full initial durable-world schema, including sessions', () => {
    expect(INITIAL_MIGRATION_SQL.join('\n')).toContain('CREATE TABLE IF NOT EXISTS sessions');
  });

  it('serializes only entities and mined tiles that belong to a dirty chunk', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    const center = world.buildings['center-player-a']!;
    const chunk = chunkKeyFor(center.x, center.y);
    world.minedTiles[`${center.x}:${center.y}`] = 1;
    world.minedTiles['-32:0'] = 1;
    const chunkSnapshot = snapshotDirtyChunk(world, chunk);
    expect(chunkSnapshot.buildings).toEqual({ [center.id]: center });
    expect(chunkSnapshot.minedTiles).toEqual({ [`${center.x}:${center.y}`]: 1 });
    expect(chunkSnapshot.threats).toEqual({});
  });

  it('records dirty chunks with a completed checkpoint', async () => {
    const persistence = new MemoryWorldPersistence();
    const host = new GlobalWorldHost(1, persistence);
    const client = connection();
    await host.connect(client, 'player-a');
    const ore = oreTileFor(host);
    await host.command(client, {
      id: 'gather-dirty-chunk',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'gather',
      ...ore,
    });
    await host.checkpoint();
    expect((await persistence.loadLatestCheckpoint())?.dirtyChunks).toContain(
      chunkKeyFor(ore.x, ore.y),
    );
  });

  it('retains a recoverable checkpoint window and compacts only covered journal entries', async () => {
    const persistence: WorldPersistence = new MemoryWorldPersistence();
    const world = createWorld();
    await persistence.appendAcceptedCommand({
      targetTick: 1,
      command: {
        id: 'old-command',
        playerId: 'player-a' as never,
        sequence: 1,
        type: 'gather',
        x: 0,
        y: 0,
      },
    });
    for (let index = 0; index < 4; index += 1) {
      advanceTick(world);
      await persistence.saveCheckpoint(world);
    }
    await persistence.appendAcceptedCommand({
      targetTick: 5,
      command: {
        id: 'recent-command',
        playerId: 'player-a' as never,
        sequence: 2,
        type: 'gather',
        x: 0,
        y: 0,
      },
    });
    expect((await persistence.loadLatestCheckpoint())?.tick).toBe(4);
    expect((await persistence.loadJournalAfter(0)).map((entry) => entry.command.id)).toEqual([
      'recent-command',
    ]);
  });

  it('recovers the previous completed checkpoint when the next checkpoint is interrupted', async () => {
    const persistence = new InterruptedCheckpointPersistence();
    const host = new GlobalWorldHost(77, persistence);
    const client = connection();
    await host.connect(client, 'player-a');
    await host.command(client, {
      id: 'journaled-before-interruption',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'gather',
      ...oreTileFor(host),
    });
    persistence.interruptNextCheckpoint = true;
    await expect(host.checkpoint()).rejects.toThrow('checkpoint writer interrupted');

    const recovered = new GlobalWorldHost(1, persistence);
    await recovered.restore();
    expect(recovered.world.seed).toBe(77);
    expect(recovered.world.players['player-a']?.inventory.ore).toBe(1);
  });

  it('restores a completed checkpoint and replays later journaled commands', async () => {
    const persistence = new MemoryWorldPersistence();
    const initial = new GlobalWorldHost(77, persistence);
    await initial.restore();
    const client = connection();
    await initial.connect(client, 'player-a');
    await initial.checkpoint();
    await initial.command(client, {
      id: 'gather-1',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'gather',
      ...oreTileFor(initial),
    });

    const restored = new GlobalWorldHost(1, persistence);
    await restored.restore();
    expect(restored.world.seed).toBe(77);
    expect(restored.world.players['player-a']?.inventory.ore).toBe(1);
  });

  it('does not mutate the active world when journaling fails', async () => {
    const persistence = new MemoryWorldPersistence();
    const append = persistence.appendAcceptedCommand.bind(persistence);
    persistence.appendAcceptedCommand = async () => {
      throw new Error('database unavailable');
    };
    const host = new GlobalWorldHost(1, persistence);
    await host.restore();
    const client = connection();
    await host.connect(client, 'player-a');
    await host.command(client, {
      id: 'gather-1',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'gather',
      ...oreTileFor(host),
    });
    expect(host.world.players['player-a']?.inventory.ore).toBe(0);
    expect(client.messages.at(-1)).toContain('persistence-failed');
    expect(host.metrics.persistenceFailures).toBe(1);
    persistence.appendAcceptedCommand = append;
  });

  it('does not expose another player state or private building inventory', async () => {
    const host = new GlobalWorldHost();
    await host.restore();
    const first = connection();
    const second = connection();
    await host.connect(first, 'player-a');
    await host.connect(second, 'player-b');
    host.resync(first);
    const message = JSON.parse(first.messages.at(-1)!) as {
      state: {
        players: Record<string, unknown>;
        buildings: Record<
          string,
          { ownerId: string; inventory: { ore: number; wood: number; ingot: number; tool: number } }
        >;
        territory: Record<string, string>;
        processedCommands: string[];
      };
    };
    expect(Object.keys(message.state.players)).toEqual(['player-a']);
    for (const building of Object.values(message.state.buildings))
      if (building.ownerId === 'player-b')
        expect(building.inventory).toEqual({ ore: 0, wood: 0, ingot: 0, tool: 0 });
    expect(Object.values(message.state.territory)).toContain('player-b');
    expect(message.state.processedCommands).toEqual([]);
  });

  it('does not expose mined tiles outside the player’s explored chunks', async () => {
    const host = new GlobalWorldHost();
    await host.restore();
    const first = connection();
    const second = connection();
    await host.connect(first, 'player-a');
    await host.connect(second, 'player-b');
    host.world.minedTiles['32:0'] = 1;
    host.world.minedTiles['12:0'] = 1;
    await host.tick();
    host.resync(first);
    const message = JSON.parse(first.messages.at(-1)!) as {
      state: {
        minedTiles: Record<string, number>;
        processedCommands: string[];
        seed?: number;
        randomState?: number;
      };
    };
    expect(message.state.minedTiles).toEqual({ '12:0': 1 });
    expect(message.state.processedCommands).toEqual([]);
    expect(message.state.seed).toBeUndefined();
    expect(message.state.randomState).toBeUndefined();
  });

  it('sends a full relevant-world snapshot when an explored viewport chunk is subscribed', async () => {
    const host = new GlobalWorldHost();
    const client = connection();
    await host.connect(client, 'player-a');
    joinPlayer(host.world, 'player-b');
    host.world.players['player-a']!.exploredChunks['2:0'] = true;
    host.world.buildings.hidden = {
      ...host.world.buildings['center-player-a']!,
      id: 'hidden' as never,
      ownerId: 'player-b' as never,
      x: 32,
      y: 0,
    };
    host.setInterest(client, [{ x: 2, y: 0 }]);
    const message = JSON.parse(client.messages.at(-1)!) as {
      type: string;
      state?: { buildings: Record<string, unknown>; terrain: Record<string, unknown> };
    };
    expect(message.type).toBe('chunkSnapshot');
    expect(message.state?.buildings.hidden).toBeDefined();
    expect(message.state?.terrain['32:0']).toBeDefined();

    host.setInterest(client, [{ x: 1, y: 0 }]);
    const narrowed = JSON.parse(client.messages.at(-1)!) as {
      state?: { buildings: Record<string, unknown>; terrain: Record<string, unknown> };
    };
    expect(narrowed.state?.buildings.hidden).toBeUndefined();
    expect(narrowed.state?.terrain['32:0']).toBeUndefined();
  });

  it('exposes only relevant settlement state and inventories to authorized logistics members', async () => {
    const host = new GlobalWorldHost();
    await host.restore();
    const owner = connection();
    const logistics = connection();
    await host.connect(owner, 'player-a');
    await host.connect(logistics, 'player-b');
    await host.command(owner, {
      id: 'invite',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    await host.command(logistics, {
      id: 'accept',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    await host.command(owner, {
      id: 'role',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'setSettlementRole',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
      role: 'logistics',
    });
    host.world.buildings['center-player-a']!.inventory.ore = 2;
    await host.tick();
    host.resync(logistics);
    const message = JSON.parse(logistics.messages.at(-1)!) as {
      state: {
        players: Record<string, unknown>;
        settlements: Record<string, unknown>;
        buildings: Record<string, { inventory: { ore: number } }>;
      };
    };
    expect(Object.keys(message.state.players)).toEqual(['player-b']);
    expect(Object.keys(message.state.settlements).sort()).toEqual([
      'settlement-player-a',
      'settlement-player-b',
    ]);
    expect(message.state.buildings['center-player-a']?.inventory.ore).toBe(2);
    await host.command(owner, {
      id: 'remove-logistics',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'removeSettlementMember',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    host.resync(logistics);
    const revoked = JSON.parse(logistics.messages.at(-1)!) as {
      state: {
        settlements: Record<string, unknown>;
        buildings: Record<string, { inventory: { ore: number; wood: number; ingot: number } }>;
      };
    };
    expect(Object.keys(revoked.state.settlements)).toEqual(['settlement-player-b']);
    expect(revoked.state.buildings['center-player-a']).toBeUndefined();
  });

  it('runs the two-player gather, produce, defend, reconnect, and restore loop', async () => {
    const persistence = new MemoryWorldPersistence();
    const host = new GlobalWorldHost(42, persistence);
    await host.restore();
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    await host.command(alice, {
      id: 'build-smelter',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'placeSmelter',
      x: 12,
      y: 0,
    });
    host.world.players['player-a']!.inventory.ingot = 1;
    await host.command(alice, {
      id: 'research-metallurgy',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'research',
      technologyId: 'metallurgy',
    });
    const smelter = Object.values(host.world.buildings).find(
      (building) => building.ownerId === 'player-a' && building.kind === 'smelter',
    )!;
    for (let index = 0; index < 10; index += 1) await host.tick();
    await host.command(alice, {
      id: 'build-tower',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'placeWatchtower',
      x: 13,
      y: 0,
    });
    await host.command(alice, {
      id: 'gather',
      playerId: 'player-a' as never,
      sequence: 4,
      type: 'gather',
      ...oreTileFor(host),
    });
    await host.command(alice, {
      id: 'load',
      playerId: 'player-a' as never,
      sequence: 5,
      type: 'transfer',
      buildingId: smelter.id,
      item: 'ore',
      amount: 1,
      direction: 'toBuilding',
    });
    for (let index = 0; index < 4; index += 1) await host.tick();
    await host.command(alice, {
      id: 'unload',
      playerId: 'player-a' as never,
      sequence: 6,
      type: 'transfer',
      buildingId: smelter.id,
      item: 'ingot',
      amount: 1,
      direction: 'toPlayer',
    });
    await host.command(alice, {
      id: 'gift',
      playerId: 'player-a' as never,
      sequence: 7,
      type: 'transferToPlayer',
      targetPlayerId: 'player-b' as never,
      item: 'ingot',
      amount: 1,
    });
    expect(host.world.players['player-b']?.inventory.ingot).toBe(1);
    expect(host.world.transfers).toHaveLength(1);
    for (let index = host.world.tick; index < 159; index += 1) await host.tick();
    expect(Object.keys(host.world.threats)).toHaveLength(0);
    host.disconnect(alice);
    const reconnect = connection();
    await host.connect(reconnect, 'player-a');
    expect(Object.keys(host.world.players)).toHaveLength(2);
    await host.checkpoint();
    const restored = new GlobalWorldHost(1, persistence);
    await restored.restore();
    expect(restored.world.players['player-b']?.inventory.ingot).toBe(1);
    expect(restored.world.transfers).toHaveLength(1);
    expect(restored.world.buildings[smelter.id]?.kind).toBe('smelter');
  });

  it('sends replacement deltas and restores a full state after a missed version', async () => {
    const host = new GlobalWorldHost();
    const client = connection();
    await host.connect(client, 'player-a');
    const welcome = JSON.parse(client.messages[0]!) as {
      type: string;
      version: number;
    };
    const bootstrap = JSON.parse(client.messages[1]!) as {
      type: string;
      stateVersion: number;
      state: { players: Record<string, unknown> };
    };
    expect(welcome.type).toBe('welcome');
    expect(welcome.version).toBe(2);
    expect(bootstrap.type).toBe('worldBootstrap');
    expect(bootstrap.stateVersion).toBe(0);
    expect(Object.keys(bootstrap.state.players)).toEqual(['player-a']);

    await host.tick();
    const delta = JSON.parse(client.messages.at(-1)!) as {
      type: string;
      version: number;
      baseVersion: number;
      delta: { tick?: number; terrain?: unknown };
    };
    expect(delta).toMatchObject({
      type: 'stateDelta',
      version: 2,
      baseVersion: 1,
      delta: { tick: 1 },
    });
    expect(delta.delta.terrain).toBeUndefined();

    host.resync(client);
    const resync = JSON.parse(client.messages.at(-1)!) as {
      type: string;
      stateVersion: number;
      state?: { tick: number; players: Record<string, unknown> };
    };
    expect(resync.type).toBe('worldBootstrap');
    expect(resync.stateVersion).toBe(2);
    expect(resync.state).toMatchObject({ tick: 1, players: { 'player-a': expect.anything() } });
    expect(host.metrics.fullStateMessages).toBe(2);
    expect(host.metrics.deltaStateMessages).toBe(2);
    expect(host.metrics.fullStateBytes).toBeGreaterThan(host.metrics.deltaStateBytes);
  });

  it('replaces an entity snapshot when an observed building crosses into a new chunk', async () => {
    const host = new GlobalWorldHost();
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    const building = host.world.buildings['center-player-a']!;
    const initialPosition = { x: building.x, y: building.y };
    const initialChunk = { x: Math.floor(building.x / 16), y: Math.floor(building.y / 16) };
    const nextChunk = { x: initialChunk.x + 1, y: initialChunk.y };
    host.world.players['player-b']!.exploredChunks[`${initialChunk.x}:${initialChunk.y}`] = true;
    host.world.players['player-b']!.exploredChunks[`${nextChunk.x}:${nextChunk.y}`] = true;

    host.setInterest(bob, [initialChunk]);
    const initialSnapshot = JSON.parse(bob.messages.at(-1)!) as {
      type: string;
      state: { buildings: Record<string, { x: number; y: number }> };
    };
    expect(initialSnapshot).toMatchObject({
      type: 'chunkSnapshot',
      state: { buildings: { [building.id]: { x: building.x, y: building.y } } },
    });

    building.x = nextChunk.x * 16;
    host.setInterest(bob, [nextChunk]);
    const movedSnapshot = JSON.parse(bob.messages.at(-1)!) as {
      type: string;
      chunks: Array<{ x: number; y: number }>;
      state: { buildings: Record<string, { x: number; y: number }> };
    };
    expect(movedSnapshot.chunks).toEqual([nextChunk]);
    expect(movedSnapshot.state.buildings[building.id]).toEqual(
      expect.objectContaining({ x: nextChunk.x * 16, y: building.y }),
    );
    expect(
      Object.values(movedSnapshot.state.buildings).filter(
        (candidate) => candidate.x === initialPosition.x && candidate.y === initialPosition.y,
      ),
    ).toHaveLength(0);
  });
});

describe('runtime environment', () => {
  it('requires explicit WebSocket origins in production', () => {
    expect(() => parseEnvironment({ NODE_ENV: 'production' })).toThrow('ALLOWED_ORIGINS');
    expect(
      parseEnvironment({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://game.example, https://admin.example',
      }).allowedOrigins,
    ).toEqual(['https://game.example', 'https://admin.example']);
  });
});
