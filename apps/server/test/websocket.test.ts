import { type ServerEnvironment, MemoryWorldPersistence } from '@kings/server-runtime';
import { terrainAt } from '@kings/simulation';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServer } from '../src/server.js';

const environment: ServerEnvironment = {
  port: 3001,
  worldSeed: 91,
  logLevel: 'error',
  persistence: 'memory',
  production: false,
  allowedOrigins: [],
};

const receive = <T extends { type: string }>(socket: WebSocket, type: T['type']) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 1_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });

const receiveFullState = (socket: WebSocket) =>
  new Promise<{ type: 'state'; version: number; state: { players: Record<string, unknown> } }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('Timed out waiting for a full state.'));
      }, 1_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          version?: number;
          state?: { players: Record<string, unknown> };
        };
        if (message.type !== 'state' || !message.state || message.version === undefined) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve({ type: 'state', version: message.version, state: message.state });
      };
      socket.on('message', onMessage);
    },
  );

const connectedSocket = async (port: number) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
};

describe('WebSocket game boundary', () => {
  let game: GameServer | undefined;

  afterEach(async () => {
    await game?.shutdown();
  });

  it('handshakes, acknowledges authoritative commands, and rejects duplicate retries', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const socket = await connectedSocket(port);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(health.json()).resolves.toEqual({ status: 'ok', processHealthy: true });
    await expect(
      fetch(`http://127.0.0.1:${port}/ready`).then((response) => response.status),
    ).resolves.toBe(200);

    const welcome = receive<{ type: 'welcome'; playerId: string; stateVersion: number }>(
      socket,
      'welcome',
    );
    socket.send(JSON.stringify({ type: 'hello', version: 1, playerId: 'socket-player' }));
    await expect(welcome).resolves.toMatchObject({ playerId: 'socket-player', stateVersion: 0 });

    const fullState = receiveFullState(socket);
    socket.send(JSON.stringify({ type: 'resync', version: 99 }));
    await expect(fullState).resolves.toMatchObject({
      state: { players: { 'socket-player': expect.anything() } },
    });

    const pong = receive<{ type: 'pong'; nonce: string }>(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping', nonce: 'keepalive-1' }));
    await expect(pong).resolves.toEqual({ type: 'pong', nonce: 'keepalive-1' });

    const unauthorized = receive<{
      type: 'commandResult';
      result: { accepted: boolean; code?: string };
    }>(socket, 'commandResult');
    socket.send(
      JSON.stringify({
        type: 'command',
        command: {
          id: 'forged-gather-1',
          playerId: 'another-player',
          sequence: 1,
          type: 'gather',
          x: 12,
          y: 0,
        },
      }),
    );
    await expect(unauthorized).resolves.toMatchObject({
      result: { accepted: false, code: 'unauthorized' },
    });

    const x = 12;
    const y = terrainAt(environment.worldSeed, x, 0) === 'water' ? 1 : 0;
    const command = {
      id: 'socket-gather-1',
      playerId: 'socket-player',
      sequence: 1,
      type: 'gather' as const,
      x,
      y,
    };
    const accepted = receive<{
      type: 'commandResult';
      result: { accepted: boolean; commandId: string };
    }>(socket, 'commandResult');
    socket.send(JSON.stringify({ type: 'command', command }));
    await expect(accepted).resolves.toMatchObject({
      result: { accepted: true, commandId: command.id },
    });
    expect(game.host.world.players['socket-player']?.inventory.ore).toBe(1);

    const duplicate = receive<{
      type: 'commandResult';
      result: { accepted: boolean; code?: string };
    }>(socket, 'commandResult');
    socket.send(JSON.stringify({ type: 'command', command }));
    await expect(duplicate).resolves.toMatchObject({
      result: { accepted: false, code: 'duplicate-command' },
    });
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_commands_accepted_total 1');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_checkpoint_duration_ms');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_state_delta_messages_total');
    socket.terminate();
  });

  it('rejects incompatible protocol versions before assigning a player', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const socket = await connectedSocket(port);
    const error = receive<{ type: 'error'; code: string }>(socket, 'error');
    socket.send(JSON.stringify({ type: 'hello', version: 999, playerId: 'outdated-player' }));
    await expect(error).resolves.toEqual({
      type: 'error',
      code: 'version-mismatch',
      message: 'Client upgrade required.',
    });
    socket.terminate();
  });
});
