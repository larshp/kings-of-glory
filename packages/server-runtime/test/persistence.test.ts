import { describe, expect, it } from 'vitest';
import {
  type Connection,
  directoryPageFor,
  GlobalWorldHost,
  INITIAL_MIGRATION_SQL,
  MemoryWorldPersistence,
  PostgresWorldPersistence,
  snapshotDirtyChunk,
  worldMapPageFor,
  type WorldPersistence,
} from '../src/index.js';
import {
  advanceTick,
  chunkKeyFor,
  createWorld,
  joinPlayer,
  nearestOreTile,
  terrainAt,
} from '@kings/simulation';
import { parseEnvironment } from '../src/env.js';
import { PROTOCOL_VERSION } from '@kings/protocol';

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

  it('upgrades the oldest supported database schema with only later forward migrations', async () => {
    const statements: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        statements.push({ sql, parameters });
        return sql === 'SELECT version FROM schema_migrations ORDER BY version'
          ? { rows: [{ version: 1 }] }
          : { rows: [] };
      },
      release() {},
    };
    const persistence = new PostgresWorldPersistence({
      async connect() {
        return client;
      },
    } as never);
    await persistence.migrate();
    expect(statements.some(({ sql }) => sql.includes('backup_restore_drills'))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS sessions'))).toBe(
      false,
    );
    expect(statements).toContainEqual({
      sql: 'INSERT INTO schema_migrations(version) VALUES ($1)',
      parameters: [2],
    });
    expect(statements).toContainEqual({
      sql: 'INSERT INTO schema_migrations(version) VALUES ($1)',
      parameters: [3],
    });
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('rejects a database schema newer than this server before accepting the world', async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        return sql === 'SELECT version FROM schema_migrations ORDER BY version'
          ? { rows: [{ version: 99 }] }
          : { rows: [] };
      },
      release() {},
    };
    const persistence = new PostgresWorldPersistence({
      async connect() {
        return client;
      },
    } as never);
    await expect(persistence.migrate()).rejects.toThrow('newer than supported');
    expect(statements.at(-1)).toBe('ROLLBACK');
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
        playerActivity: Record<string, unknown>;
        onboardingReservations: Record<string, unknown>;
      };
    };
    expect(Object.keys(message.state.players)).toEqual(['player-a']);
    expect(Object.keys(message.state.playerActivity)).toEqual(['player-a']);
    expect(Object.keys(message.state.onboardingReservations)).toEqual(['player-a']);
    for (const building of Object.values(message.state.buildings))
      if (building.ownerId === 'player-b')
        expect(building.inventory).toEqual({ ore: 0, wood: 0, ingot: 0, tool: 0 });
    expect(Object.values(message.state.territory)).toContain('player-b');
    expect(message.state.processedCommands).toEqual([]);
  });

  it('exposes a paginated public directory without world or private player state', () => {
    const world = createWorld(17);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    world.players['player-b']!.inventory.ingot = 91;
    world.social.playerNames['player-a'] = 'River Warden';
    world.social.settlementNames['settlement-player-a'] = 'Iron Vale';
    const named = directoryPageFor(world, 'iron vale', undefined, 2);
    expect(named.entries).toEqual([
      expect.objectContaining({
        type: 'settlement',
        settlementId: 'settlement-player-a',
        displayName: 'Iron Vale',
      }),
    ]);
    const first = directoryPageFor(world, 'PLAYER', undefined, 2);
    expect(first.query).toBe('player');
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = directoryPageFor(world, 'player', first.nextCursor, 2);
    expect(second.after).toBe(first.nextCursor);
    const encoded = JSON.stringify([...first.entries, ...second.entries]);
    expect(encoded).toContain('player-a');
    expect(encoded).toContain('settlement-player-a');
    expect(encoded).not.toContain('inventory');
    expect(encoded).not.toContain('territory');
    expect(encoded).not.toContain('plot');
    expect(encoded).not.toContain('91');
  });

  it('filters blocked and settlement chat while withholding reports and rate-limit metadata', async () => {
    const host = new GlobalWorldHost(21);
    const alice = connection();
    const bob = connection();
    const carol = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    await host.connect(carol, 'player-c');
    await host.command(alice, {
      id: 'name-chat-a',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'setPlayerName',
      name: 'River Warden',
    });
    await host.command(alice, {
      id: 'global-chat-a',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'sendChatMessage',
      channel: 'global',
      text: 'Need wood',
    });
    host.resync(bob);
    const visibleGlobal = JSON.parse(bob.messages.at(-1)!) as {
      state: { social: { messages: Array<{ id: string; senderName: string }> } };
    };
    expect(visibleGlobal.state.social.messages).toContainEqual(
      expect.objectContaining({ id: 'global-chat-a', senderName: 'River Warden' }),
    );
    await host.command(bob, {
      id: 'report-global-chat',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'reportChatMessage',
      messageId: 'global-chat-a',
      reason: 'Harassment',
    });
    await host.command(bob, {
      id: 'block-global-chat',
      playerId: 'player-b' as never,
      sequence: 2,
      type: 'setPlayerBlocked',
      targetPlayerId: 'player-a' as never,
      blocked: true,
    });
    host.resync(bob);
    const blocked = JSON.parse(bob.messages.at(-1)!) as {
      state: {
        social: {
          messages: Array<{ id: string }>;
          reports: unknown[];
          lastChatTick: Record<string, number>;
          blockedPlayers: Record<string, Record<string, true>>;
        };
      };
    };
    expect(blocked.state.social.messages.map(({ id }) => id)).not.toContain('global-chat-a');
    expect(blocked.state.social.reports).toEqual([]);
    expect(blocked.state.social.lastChatTick).toEqual({});
    expect(blocked.state.social.blockedPlayers).toEqual({
      'player-b': { 'player-a': true },
    });
    expect(host.world.social.reports).toHaveLength(1);
    await host.command(bob, {
      id: 'unblock-global-chat',
      playerId: 'player-b' as never,
      sequence: 3,
      type: 'setPlayerBlocked',
      targetPlayerId: 'player-a' as never,
      blocked: false,
    });
    for (let index = 0; index < 5; index += 1) await host.tick();
    await host.command(alice, {
      id: 'private-before-membership',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'sendChatMessage',
      channel: 'settlement',
      settlementId: 'settlement-player-a',
      text: 'Private plans',
    });
    host.resync(bob);
    expect(bob.messages.at(-1)).not.toContain('private-before-membership');
    await host.command(alice, {
      id: 'invite-chat-b',
      playerId: 'player-a' as never,
      sequence: 4,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    await host.command(bob, {
      id: 'accept-chat-b',
      playerId: 'player-b' as never,
      sequence: 4,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    for (let index = 0; index < 5; index += 1) await host.tick();
    await host.command(alice, {
      id: 'private-after-membership',
      playerId: 'player-a' as never,
      sequence: 5,
      type: 'sendChatMessage',
      channel: 'settlement',
      settlementId: 'settlement-player-a',
      text: 'Members only',
    });
    host.resync(bob);
    expect(bob.messages.at(-1)).toContain('private-after-membership');
    host.resync(carol);
    expect(carol.messages.at(-1)).not.toContain('private-after-membership');
  });

  it('keeps deleted-player tombstones server-side and prevents identity resurrection', async () => {
    const host = new GlobalWorldHost(41);
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    await host.command(alice, {
      id: 'invite-owner-successor',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    await host.command(bob, {
      id: 'accept-owner-successor',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    await host.command(alice, {
      id: 'transfer-before-delete',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'transferSettlementOwnership',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    await host.command(alice, {
      id: 'delete-account',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'deleteAccount',
      confirmation: 'DELETE',
    });
    expect(host.world.players['player-a']).toBeUndefined();
    expect(host.world.deletedPlayers['player-a']).toMatchObject({ id: 'player-a' });
    host.resync(bob);
    const bobBootstrap = JSON.parse(bob.messages.at(-1)!) as { state: Record<string, unknown> };
    expect(bobBootstrap.state).not.toHaveProperty('deletedPlayers');

    const returning = connection();
    await host.connect(returning, 'player-a');
    expect(host.world.players['player-a']).toBeUndefined();
    const bootstrap = returning.messages
      .map((message) => JSON.parse(message) as { type: string; state?: { players: unknown } })
      .find(({ type }) => type === 'worldBootstrap');
    expect(bootstrap?.state?.players).toEqual({});
    await host.command(returning, {
      id: 'deleted-command',
      playerId: 'player-a' as never,
      sequence: 4,
      type: 'gather',
      x: 0,
      y: 0,
    });
    expect(returning.messages.at(-1)).toContain('account-deleted');
  });

  it('reveals shared-project coordinates and history only to relevant settlement members', async () => {
    const host = new GlobalWorldHost(31);
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    const player = host.world.players['player-a']!;
    const center = host.world.buildings['center-player-a']!;
    const tile = Array.from({ length: player.plot.size }, (_, offsetX) =>
      Array.from({ length: player.plot.size }, (_, offsetY) => ({
        x: player.plot.x + offsetX,
        y: player.plot.y + offsetY,
      })),
    )
      .flat()
      .find(
        ({ x, y }) =>
          terrainAt(host.world.seed, x, y) !== 'water' &&
          !(y === center.y && x < center.x) &&
          !(x === center.x && y === center.y) &&
          !Object.values(host.world.buildings).some(
            (building) => building.x === x && building.y === y,
          ),
      )!;
    await host.command(alice, {
      id: 'private-project',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'createSharedConstructionProject',
      settlementId: 'settlement-player-a',
      buildingKind: 'storage',
      ...tile,
    });
    await host.command(alice, {
      id: 'private-project-funding',
      playerId: 'player-a' as never,
      sequence: 2,
      type: 'contributeToSharedConstructionProject',
      projectId: 'private-project',
      item: 'wood',
      amount: 1,
    });
    host.resync(bob);
    const hidden = JSON.parse(bob.messages.at(-1)!) as {
      state: { sharedConstructionProjects: Record<string, unknown> };
    };
    expect(hidden.state.sharedConstructionProjects).toEqual({});

    await host.command(alice, {
      id: 'invite-project-member',
      playerId: 'player-a' as never,
      sequence: 3,
      type: 'inviteToSettlement',
      settlementId: 'settlement-player-a',
      targetPlayerId: 'player-b' as never,
    });
    host.resync(bob);
    const invited = JSON.parse(bob.messages.at(-1)!) as {
      state: { sharedConstructionProjects: Record<string, unknown> };
    };
    expect(invited.state.sharedConstructionProjects).toEqual({});
    await host.command(bob, {
      id: 'accept-project-member',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'acceptSettlementInvite',
      settlementId: 'settlement-player-a',
    });
    host.resync(bob);
    const visible = JSON.parse(bob.messages.at(-1)!) as {
      state: {
        sharedConstructionProjects: Record<
          string,
          { x: number; contributionHistory: Array<{ playerId: string }> }
        >;
      };
    };
    expect(visible.state.sharedConstructionProjects['private-project']).toMatchObject({
      x: tile.x,
      contributionHistory: [{ playerId: 'player-a' }],
    });
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

  it('aggregates explored strategic chunks without leaking entities hidden by fog', () => {
    const world = createWorld(42);
    joinPlayer(world, 'player-a');
    joinPlayer(world, 'player-b');
    const player = world.players['player-a']!;
    player.exploredChunks['2:0'] = true;
    player.visibleChunks = { ...player.visibleChunks };
    world.players['player-b']!.territoryCells['4:0'] = true;
    const foreign = {
      ...world.buildings['center-player-b']!,
      id: 'foreign-hidden' as never,
      x: 32,
      y: 0,
    };
    world.buildings[foreign.id] = foreign;
    world.threats.hidden = {
      id: 'hidden',
      targetBuildingId: foreign.id,
      health: 2,
      damage: 1,
      spawnedTick: 0,
      x: 33,
      y: 0,
    };

    const hidden = worldMapPageFor(world, 'player-a', undefined, 256);
    const hiddenChunk = hidden.chunks.find((chunk) => chunk.x === 2 && chunk.y === 0)!;
    expect(Object.values(hiddenChunk.terrain).reduce((total, count) => total + count, 0)).toBe(256);
    expect(hiddenChunk).toMatchObject({
      currentlyVisible: false,
      visibleForeignBuildingCount: 0,
      visibleThreatCount: 0,
      claimedSectors: [{ ownerId: 'player-b', count: 1 }],
    });

    player.visibleChunks['2:0'] = true;
    const visibleChunk = worldMapPageFor(world, 'player-a', undefined, 256).chunks.find(
      (chunk) => chunk.x === 2 && chunk.y === 0,
    )!;
    expect(visibleChunk.visibleForeignBuildingCount).toBe(1);
    expect(visibleChunk.visibleThreatCount).toBe(1);
  });

  it('paginates strategic-map summaries with stable chunk cursors', () => {
    const world = createWorld();
    joinPlayer(world, 'player-a');
    world.players['player-a']!.exploredChunks = { '0:0': true, '1:0': true, '2:0': true };
    const first = worldMapPageFor(world, 'player-a', undefined, 2);
    expect(first.chunks.map(({ x, y }) => `${x}:${y}`)).toEqual(['0:0', '1:0']);
    expect(first.nextCursor).toBe('1:0');
    const second = worldMapPageFor(world, 'player-a', first.nextCursor, 2);
    expect(second.chunks.map(({ x, y }) => `${x}:${y}`)).toEqual(['2:0']);
    expect(second.nextCursor).toBeUndefined();
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

  it('publishes global objective totals without exposing other contributor identities', async () => {
    const host = new GlobalWorldHost();
    const alice = connection();
    const bob = connection();
    await host.connect(alice, 'player-a');
    await host.connect(bob, 'player-b');
    host.world.players['player-a']!.inventory.tool = 10;
    host.world.players['player-b']!.inventory.tool = 10;
    await host.command(alice, {
      id: 'objective-a',
      playerId: 'player-a' as never,
      sequence: 1,
      type: 'contributeToObjective',
      objectiveId: 'frontier-beacon',
      settlementId: 'settlement-player-a',
      amount: 10,
    });
    await host.command(bob, {
      id: 'objective-b',
      playerId: 'player-b' as never,
      sequence: 1,
      type: 'contributeToObjective',
      objectiveId: 'frontier-beacon',
      settlementId: 'settlement-player-b',
      amount: 10,
    });
    host.resync(alice);
    const message = JSON.parse(alice.messages.at(-1)!) as {
      state: {
        cooperativeObjectives: {
          'frontier-beacon': {
            totalContributed: number;
            contributionsByPlayer: Record<string, number>;
            contributionsBySettlement: Record<string, number>;
            contributionHistory: Array<{ playerId: string }>;
          };
        };
      };
    };
    const objective = message.state.cooperativeObjectives['frontier-beacon'];
    expect(objective.totalContributed).toBe(20);
    expect(objective.contributionsByPlayer).toEqual({ 'player-a': 10 });
    expect(objective.contributionsBySettlement).toEqual({ 'settlement-player-a': 10 });
    expect(objective.contributionHistory.map(({ playerId }) => playerId)).toEqual(['player-a']);
    expect(JSON.stringify(message)).not.toContain('objective-b');
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
    expect(welcome.version).toBe(PROTOCOL_VERSION);
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
        TRUST_PROXY: 'true',
        ALLOWED_ORIGINS: 'https://game.example, https://admin.example',
        SESSION_SECRET: 'a-production-strength-session-secret-value',
      }).allowedOrigins,
    ).toEqual(['https://game.example', 'https://admin.example']);
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        TRUST_PROXY: 'true',
        ALLOWED_ORIGINS: 'https://game.example',
      }),
    ).toThrow('SESSION_SECRET');
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        ALLOWED_ORIGINS: 'https://game.example',
        SESSION_SECRET: 'a-production-strength-session-secret-value',
      }),
    ).toThrow('TRUST_PROXY');
  });

  it('runs migrations on startup only outside production', () => {
    expect(parseEnvironment({}).migrateOnStartup).toBe(true);
    expect(
      parseEnvironment({
        NODE_ENV: 'production',
        TRUST_PROXY: 'true',
        ALLOWED_ORIGINS: 'https://game.example',
        SESSION_SECRET: 'a-production-strength-session-secret-value',
      }).migrateOnStartup,
    ).toBe(false);
    expect(() =>
      parseEnvironment({
        NODE_ENV: 'production',
        TRUST_PROXY: 'true',
        ALLOWED_ORIGINS: 'https://game.example',
        SESSION_SECRET: 'a-production-strength-session-secret-value',
        MIGRATE_ON_STARTUP: 'true',
      }),
    ).toThrow('run the migration job separately');
    expect(() => parseEnvironment({ MIGRATE_ON_STARTUP: 'sometimes' })).toThrow(
      'MIGRATE_ON_STARTUP must be true or false',
    );
  });
});
