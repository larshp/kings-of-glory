import {
  PROTOCOL_VERSION,
  type ClientWorldDelta,
  type ClientWorldState,
  type ServerMessage,
} from '@kings/protocol';
import {
  advanceTick,
  applyCommand,
  createWorld,
  deserializeWorld,
  joinPlayer,
  snapshot,
  terrainAt,
  type WorldState,
} from '@kings/simulation';
import { MemoryWorldPersistence, type WorldPersistence } from './persistence.js';

export interface Connection {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface WorldHostMetrics {
  readonly acceptedCommands: number;
  readonly rejectedCommands: number;
  readonly persistenceFailures: number;
  readonly lastCommandDurationMs: number;
  readonly checkpointFailures: number;
  readonly lastCheckpointDurationMs: number;
  readonly fullStateMessages: number;
  readonly fullStateBytes: number;
  readonly deltaStateMessages: number;
  readonly deltaStateBytes: number;
  readonly lastStateBuildDurationMs: number;
}

const deltaFrom = (previous: ClientWorldState, next: ClientWorldState): ClientWorldDelta => {
  const delta: ClientWorldDelta = {};
  for (const key of Object.keys(next) as Array<keyof ClientWorldState>)
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
      Object.assign(delta, { [key]: next[key] });
  return delta;
};

export class GlobalWorldHost {
  #world: WorldState;
  #connections = new Map<Connection, string>();
  #clientStates = new Map<Connection, { version: number; state: ClientWorldState }>();
  #version = 0;
  #checkpointInProgress = false;
  #acceptedCommands = 0;
  #rejectedCommands = 0;
  #persistenceFailures = 0;
  #lastCommandDurationMs = 0;
  #checkpointFailures = 0;
  #lastCheckpointDurationMs = 0;
  #fullStateMessages = 0;
  #fullStateBytes = 0;
  #deltaStateMessages = 0;
  #deltaStateBytes = 0;
  #lastStateBuildDurationMs = 0;

  constructor(
    seed = 1,
    private readonly persistence: WorldPersistence = new MemoryWorldPersistence(),
    private readonly checkpointIntervalTicks = 300,
  ) {
    this.#world = createWorld(seed);
  }

  get world(): WorldState {
    return this.#world;
  }
  get connectedPlayerCount(): number {
    return this.#connections.size;
  }
  get metrics(): WorldHostMetrics {
    return {
      acceptedCommands: this.#acceptedCommands,
      rejectedCommands: this.#rejectedCommands,
      persistenceFailures: this.#persistenceFailures,
      lastCommandDurationMs: this.#lastCommandDurationMs,
      checkpointFailures: this.#checkpointFailures,
      lastCheckpointDurationMs: this.#lastCheckpointDurationMs,
      fullStateMessages: this.#fullStateMessages,
      fullStateBytes: this.#fullStateBytes,
      deltaStateMessages: this.#deltaStateMessages,
      deltaStateBytes: this.#deltaStateBytes,
      lastStateBuildDurationMs: this.#lastStateBuildDurationMs,
    };
  }

  async restore(): Promise<void> {
    await this.persistence.migrate();
    const checkpoint = await this.persistence.loadLatestCheckpoint();
    if (!checkpoint) return;
    this.#world = deserializeWorld(checkpoint.state);
    for (const entry of await this.persistence.loadJournalAfter(this.#world.tick)) {
      while (this.#world.tick < entry.targetTick) advanceTick(this.#world);
      applyCommand(this.#world, entry.command);
    }
  }

  async connect(connection: Connection, playerId: string): Promise<void> {
    const candidate = snapshot(this.#world);
    const joined = joinPlayer(candidate, playerId);
    if (joined.length > 0) await this.saveCheckpoint(candidate);
    this.#world = candidate;
    this.#connections.set(connection, playerId);
    const state = this.clientStateFor(playerId);
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, {
      type: 'welcome',
      version: PROTOCOL_VERSION,
      playerId,
      stateVersion: this.#version,
      state,
    });
    this.broadcastState();
  }

  disconnect(connection: Connection): void {
    this.#connections.delete(connection);
    this.#clientStates.delete(connection);
  }

  resync(connection: Connection): void {
    const playerId = this.#connections.get(connection);
    if (!playerId) return;
    this.sendFullState(connection, playerId);
  }

  async command(
    connection: Connection,
    command: Parameters<typeof applyCommand>[1],
  ): Promise<void> {
    const startedAt = performance.now();
    const playerId = this.#connections.get(connection);
    try {
      if (!playerId || playerId !== command.playerId) {
        this.#rejectedCommands += 1;
        this.send(connection, {
          type: 'commandResult',
          result: { accepted: false, commandId: command.id, code: 'unauthorized' },
        });
        return;
      }
      const candidate = snapshot(this.#world);
      const outcome = applyCommand(candidate, command);
      if (outcome.result.accepted) {
        try {
          await this.persistence.appendAcceptedCommand({ command, targetTick: candidate.tick });
        } catch {
          this.#persistenceFailures += 1;
          this.#rejectedCommands += 1;
          this.send(connection, {
            type: 'commandResult',
            result: { accepted: false, commandId: command.id, code: 'persistence-failed' },
          });
          return;
        }
        this.#world = candidate;
        this.#acceptedCommands += 1;
      } else {
        this.#rejectedCommands += 1;
      }
      this.send(connection, { type: 'commandResult', result: outcome.result });
      if (outcome.result.accepted) this.broadcastState();
    } finally {
      this.#lastCommandDurationMs = performance.now() - startedAt;
    }
  }

  async tick(): Promise<void> {
    advanceTick(this.#world);
    this.broadcastState();
    if (this.#world.tick % this.checkpointIntervalTicks === 0 && !this.#checkpointInProgress) {
      this.#checkpointInProgress = true;
      try {
        await this.saveCheckpoint();
      } finally {
        this.#checkpointInProgress = false;
      }
    }
  }

  async checkpoint(): Promise<void> {
    await this.saveCheckpoint();
  }
  async close(): Promise<void> {
    await this.persistence.close();
  }

  private broadcastState(): void {
    this.#version += 1;
    for (const [connection, playerId] of this.#connections)
      this.sendDeltaState(connection, playerId);
  }

  private sendDeltaState(connection: Connection, playerId: string): void {
    const state = this.clientStateFor(playerId);
    const previous = this.#clientStates.get(connection);
    if (!previous || previous.version !== this.#version - 1) {
      this.#clientStates.set(connection, { version: this.#version, state });
      this.sendState(connection, { type: 'state', version: this.#version, state });
      return;
    }
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, {
      type: 'state',
      version: this.#version,
      baseVersion: previous.version,
      delta: deltaFrom(previous.state, state),
    });
  }

  private sendFullState(connection: Connection, playerId: string): void {
    const state = this.clientStateFor(playerId);
    this.#clientStates.set(connection, { version: this.#version, state });
    this.sendState(connection, { type: 'state', version: this.#version, state });
  }

  private clientStateFor(playerId: string): ClientWorldState {
    const startedAt = performance.now();
    try {
      return this.stateFor(playerId);
    } finally {
      this.#lastStateBuildDurationMs = performance.now() - startedAt;
    }
  }

  private stateFor(playerId: string): ClientWorldState {
    const state = snapshot(this.#world);
    const player = state.players[playerId];
    if (!player) {
      const { seed, ...visibleState } = state;
      void seed;
      return { ...visibleState, terrain: {} };
    }
    state.players = { [playerId]: player };
    state.processedCommands = [];
    state.minedTiles = Object.fromEntries(
      Object.entries(state.minedTiles).filter(([tile]) => {
        const [xText, yText] = tile.split(':');
        const x = Number(xText);
        const y = Number(yText);
        return player.exploredChunks[`${Math.floor(x / 16)}:${Math.floor(y / 16)}`];
      }),
    );
    state.transfers = state.transfers.filter(
      (transfer) => transfer.fromPlayerId === playerId || transfer.toPlayerId === playerId,
    );
    state.settlements = Object.fromEntries(
      Object.entries(state.settlements).filter(
        ([, settlement]) => settlement.members[playerId] || settlement.invitations[playerId],
      ),
    );
    for (const [id, building] of Object.entries(state.buildings)) {
      const chunk = `${Math.floor(building.x / 16)}:${Math.floor(building.y / 16)}`;
      const sharedRoles = Object.values(state.settlements)
        .filter((settlement) => settlement.members[building.ownerId])
        .map((settlement) => settlement.members[playerId])
        .filter((role): role is 'owner' | 'builder' | 'logistics' | 'member' => Boolean(role));
      const isShared = sharedRoles.length > 0;
      const canViewInventory = sharedRoles.some((role) => role === 'owner' || role === 'logistics');
      if (building.ownerId !== playerId && !isShared && !player.exploredChunks[chunk])
        delete state.buildings[id];
      else if (building.ownerId !== playerId && !canViewInventory)
        building.inventory = { ore: 0, wood: 0, ingot: 0 };
    }
    for (const [id, threat] of Object.entries(state.threats))
      if (!state.buildings[threat.targetBuildingId]) delete state.threats[id];
    state.logisticsLinks = Object.fromEntries(
      Object.entries(state.logisticsLinks).filter(
        ([, link]) =>
          state.buildings[link.sourceBuildingId] && state.buildings[link.targetBuildingId],
      ),
    );
    const terrain: Record<string, 'grass' | 'water' | 'ore'> = {};
    for (const chunk of Object.keys(player.exploredChunks)) {
      const [xText, yText] = chunk.split(':');
      const chunkX = Number(xText);
      const chunkY = Number(yText);
      for (let localX = 0; localX < 16; localX += 1)
        for (let localY = 0; localY < 16; localY += 1) {
          const x = chunkX * 16 + localX;
          const y = chunkY * 16 + localY;
          terrain[`${x}:${y}`] = terrainAt(this.#world.seed, x, y);
        }
    }
    const { seed, ...visibleState } = state;
    void seed;
    return { ...visibleState, terrain };
  }

  private send(connection: Connection, message: ServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private sendState(
    connection: Connection,
    message: Extract<ServerMessage, { type: 'welcome' | 'state' }>,
  ): void {
    const encoded = JSON.stringify(message);
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (message.type === 'welcome' || message.state) {
      this.#fullStateMessages += 1;
      this.#fullStateBytes += bytes;
    } else {
      this.#deltaStateMessages += 1;
      this.#deltaStateBytes += bytes;
    }
    connection.send(encoded);
  }

  private async saveCheckpoint(state = this.#world): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.persistence.saveCheckpoint(state);
    } catch (error) {
      this.#checkpointFailures += 1;
      throw error;
    } finally {
      this.#lastCheckpointDurationMs = performance.now() - startedAt;
    }
  }
}

export { parseEnvironment, type ServerEnvironment } from './env.js';
export {
  createPostgresWorldPersistence,
  MemoryWorldPersistence,
  PostgresWorldPersistence,
  type CompletedCheckpoint,
  type JournalEntry,
  type WorldPersistence,
} from './persistence.js';
