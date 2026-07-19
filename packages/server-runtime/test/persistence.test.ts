import { describe, expect, it } from 'vitest';
import { type Connection, GlobalWorldHost, MemoryWorldPersistence } from '../src/index.js';

const connection = (): Connection & { messages: string[] } => ({ messages: [], send(message) { this.messages.push(message); }, close() {} });

describe('durable world recovery', () => {
  it('restores a completed checkpoint and replays later journaled commands', async () => {
    const persistence = new MemoryWorldPersistence();
    const initial = new GlobalWorldHost(77, persistence);
    await initial.restore();
    const client = connection();
    initial.connect(client, 'player-a');
    await initial.checkpoint();
    await initial.command(client, { id: 'gather-1', playerId: 'player-a' as never, sequence: 1, type: 'gather', x: 12, y: 0 });

    const restored = new GlobalWorldHost(1, persistence);
    await restored.restore();
    expect(restored.world.seed).toBe(77);
    expect(restored.world.players['player-a']?.inventory.ore).toBe(1);
  });

  it('does not mutate the active world when journaling fails', async () => {
    const persistence = new MemoryWorldPersistence();
    const append = persistence.appendAcceptedCommand.bind(persistence);
    persistence.appendAcceptedCommand = async () => { throw new Error('database unavailable'); };
    const host = new GlobalWorldHost(1, persistence); await host.restore();
    const client = connection(); host.connect(client, 'player-a');
    await host.command(client, { id: 'gather-1', playerId: 'player-a' as never, sequence: 1, type: 'gather', x: 12, y: 0 });
    expect(host.world.players['player-a']?.inventory.ore).toBe(0);
    expect(client.messages.at(-1)).toContain('persistence-failed');
    persistence.appendAcceptedCommand = append;
  });
});
