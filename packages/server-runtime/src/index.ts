import { PROTOCOL_VERSION, type ServerMessage } from '@kings/protocol';
import { advanceTick, applyCommand, createWorld, joinPlayer, snapshot, type WorldState } from '@kings/simulation';
import { MemoryWorldPersistence, type WorldPersistence } from './persistence.js';

export interface Connection {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export class GlobalWorldHost {
  #world: WorldState;
  #connections = new Map<Connection, string>();
  #version = 0;
  #checkpointInProgress = false;

  constructor(seed = 1, private readonly persistence: WorldPersistence = new MemoryWorldPersistence(), private readonly checkpointIntervalTicks = 300) { this.#world = createWorld(seed); }

  get world(): WorldState { return this.#world; }

  async restore(): Promise<void> {
    await this.persistence.migrate();
    const checkpoint = await this.persistence.loadLatestCheckpoint();
    if (!checkpoint) return;
    this.#world = snapshot(checkpoint.state);
    for (const entry of await this.persistence.loadJournalAfter(this.#world.tick)) {
      while (this.#world.tick < entry.targetTick) advanceTick(this.#world);
      applyCommand(this.#world, entry.command);
    }
  }

  connect(connection: Connection, playerId: string): void {
    joinPlayer(this.#world, playerId);
    this.#connections.set(connection, playerId);
    this.send(connection, { type: 'welcome', version: PROTOCOL_VERSION, playerId, state: snapshot(this.#world) });
    this.broadcastState();
  }

  disconnect(connection: Connection): void { this.#connections.delete(connection); }

  async command(connection: Connection, command: Parameters<typeof applyCommand>[1]): Promise<void> {
    const playerId = this.#connections.get(connection);
    if (!playerId || playerId !== command.playerId) return;
    const candidate = snapshot(this.#world);
    const outcome = applyCommand(candidate, command);
    if (outcome.result.accepted) {
      try { await this.persistence.appendAcceptedCommand({ command, targetTick: candidate.tick }); }
      catch { this.send(connection, { type: 'commandResult', result: { accepted: false, commandId: command.id, code: 'persistence-failed' } }); return; }
      this.#world = candidate;
    }
    this.send(connection, { type: 'commandResult', result: outcome.result });
    if (outcome.result.accepted) this.broadcastState();
  }

  async tick(): Promise<void> {
    advanceTick(this.#world);
    this.broadcastState();
    if (this.#world.tick % this.checkpointIntervalTicks === 0 && !this.#checkpointInProgress) {
      this.#checkpointInProgress = true;
      try { await this.persistence.saveCheckpoint(this.#world); } finally { this.#checkpointInProgress = false; }
    }
  }

  async checkpoint(): Promise<void> { await this.persistence.saveCheckpoint(this.#world); }
  async close(): Promise<void> { await this.persistence.close(); }

  private broadcastState(): void {
    this.#version += 1;
    const message: ServerMessage = { type: 'state', version: this.#version, state: snapshot(this.#world) };
    for (const connection of this.#connections.keys()) this.send(connection, message);
  }

  private send(connection: Connection, message: ServerMessage): void { connection.send(JSON.stringify(message)); }
}

export { parseEnvironment, type ServerEnvironment } from './env.js';
export { createPostgresWorldPersistence, MemoryWorldPersistence, PostgresWorldPersistence, type CompletedCheckpoint, type JournalEntry, type WorldPersistence } from './persistence.js';
