import { type ServerEnvironment, MemoryWorldPersistence } from '@kings/server-runtime';
import { PROTOCOL_VERSION } from '@kings/protocol';
import { nearestOreTile } from '@kings/simulation';
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
  new Promise<{
    type: 'worldBootstrap';
    stateVersion: number;
    state: { players: Record<string, unknown> };
  }>((resolve, reject) => {
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
      if (message.type !== 'worldBootstrap' || !message.state || message.stateVersion === undefined)
        return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve({ type: 'worldBootstrap', stateVersion: message.stateVersion, state: message.state });
    };
    socket.on('message', onMessage);
  });

const receiveDeltaState = (socket: WebSocket, minimumTick: number) =>
  new Promise<{ type: 'stateDelta'; version: number; delta: { tick?: number } }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('Timed out waiting for a state delta.'));
      }, 1_000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          version?: number;
          delta?: { tick?: number };
        };
        if (
          message.type !== 'stateDelta' ||
          !message.delta ||
          message.version === undefined ||
          typeof message.delta.tick !== 'number' ||
          message.delta.tick < minimumTick
        )
          return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve({ type: 'stateDelta', version: message.version, delta: message.delta });
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

    const welcome = receive<{ type: 'welcome'; playerId: string; version: number }>(
      socket,
      'welcome',
    );
    const bootstrap = receive<{
      type: 'worldBootstrap';
      playerId: string;
      stateVersion: number;
    }>(socket, 'worldBootstrap');
    socket.send(
      JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'socket-player' }),
    );
    await expect(welcome).resolves.toMatchObject({
      playerId: 'socket-player',
      version: PROTOCOL_VERSION,
    });
    await expect(bootstrap).resolves.toMatchObject({
      playerId: 'socket-player',
      stateVersion: expect.any(Number),
    });

    const fullState = receiveFullState(socket);
    socket.send(JSON.stringify({ type: 'resync', version: 99 }));
    await expect(fullState).resolves.toMatchObject({
      state: { players: { 'socket-player': expect.anything() } },
    });

    const pong = receive<{ type: 'pong'; nonce: string }>(socket, 'pong');
    socket.send(JSON.stringify({ type: 'ping', nonce: 'keepalive-1' }));
    await expect(pong).resolves.toEqual({ type: 'pong', nonce: 'keepalive-1' });

    const unauthorized = receive<{
      type: 'commandRejected';
      result: { accepted: boolean; code?: string };
    }>(socket, 'commandRejected');
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

    const player = game.host.world.players['socket-player']!;
    const oreTile = nearestOreTile(
      environment.worldSeed,
      player.plot.x + Math.floor(player.plot.size / 2),
      player.plot.y + Math.floor(player.plot.size / 2),
      8,
    )!;
    const command = {
      id: 'socket-gather-1',
      playerId: 'socket-player',
      sequence: 1,
      type: 'gather' as const,
      ...oreTile,
    };
    const accepted = receive<{
      type: 'commandAcknowledged';
      result: { accepted: boolean; commandId: string };
    }>(socket, 'commandAcknowledged');
    socket.send(JSON.stringify({ type: 'command', command }));
    await expect(accepted).resolves.toMatchObject({
      result: { accepted: true, commandId: command.id },
    });
    expect(game.host.world.players['socket-player']?.inventory.ore).toBe(1);

    const duplicate = receive<{
      type: 'commandRejected';
      result: { accepted: boolean; code?: string };
    }>(socket, 'commandRejected');
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
    ).resolves.toContain('kings_recovery_duration_ms');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_state_delta_messages_total');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_journal_lag_ticks');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_outbound_buffered_bytes');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_checkpoint_tick 0');
    socket.terminate();
  });

  it('rejects incompatible protocol versions before assigning a player', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const socket = await connectedSocket(port);
    const error = receive<{ type: 'error'; code: string }>(socket, 'error');
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    socket.send(JSON.stringify({ type: 'hello', version: 999, playerId: 'outdated-player' }));
    await expect(error).resolves.toEqual({
      type: 'error',
      code: 'version-mismatch',
      message: 'Client upgrade required.',
    });
    await expect(closed).resolves.toEqual({ code: 1002, reason: 'Client upgrade required' });
  });

  it('notifies connected clients about planned maintenance during shutdown', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const socket = await connectedSocket(port);
    const welcome = receive<{ type: 'welcome' }>(socket, 'welcome');
    socket.send(
      JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'maintenance-player' }),
    );
    await welcome;
    const maintenance = receive<{ type: 'maintenance'; message: string }>(socket, 'maintenance');
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    await game.shutdown();
    game = undefined;
    await expect(maintenance).resolves.toEqual({
      type: 'maintenance',
      message: 'Server maintenance in progress.',
    });
    await expect(closed).resolves.toEqual({ code: 1012, reason: 'Server maintenance' });
  });

  it('restores the same authoritative player state after a WebSocket reconnect', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const firstSocket = await connectedSocket(port);
    const firstWelcome = receive<{ type: 'welcome'; playerId: string }>(firstSocket, 'welcome');
    firstSocket.send(
      JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'reconnect-player' }),
    );
    await expect(firstWelcome).resolves.toMatchObject({ playerId: 'reconnect-player' });
    const player = game.host.world.players['reconnect-player']!;
    const oreTile = nearestOreTile(
      environment.worldSeed,
      player.plot.x + Math.floor(player.plot.size / 2),
      player.plot.y + Math.floor(player.plot.size / 2),
      8,
    )!;
    const gathered = receive<{
      type: 'commandAcknowledged';
      result: { accepted: boolean; commandId: string };
    }>(firstSocket, 'commandAcknowledged');
    firstSocket.send(
      JSON.stringify({
        type: 'command',
        command: {
          id: 'reconnect-gather-1',
          playerId: 'reconnect-player',
          sequence: 1,
          type: 'gather',
          ...oreTile,
        },
      }),
    );
    await expect(gathered).resolves.toMatchObject({
      result: { accepted: true, commandId: 'reconnect-gather-1' },
    });
    const firstClosed = new Promise<void>((resolve) => firstSocket.once('close', resolve));
    firstSocket.close(1000, 'reconnecting');
    await firstClosed;

    const reconnectedSocket = await connectedSocket(port);
    const reconnectedWelcome = receive<{
      type: 'worldBootstrap';
      playerId: string;
      state: { players: Record<string, { inventory: { ore: number } }> };
    }>(reconnectedSocket, 'worldBootstrap');
    reconnectedSocket.send(
      JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId: 'reconnect-player' }),
    );
    await expect(reconnectedWelcome).resolves.toMatchObject({
      playerId: 'reconnect-player',
      state: { players: { 'reconnect-player': { inventory: { ore: 1 } } } },
    });
    reconnectedSocket.terminate();
  });

  it('closes persistence even when the final checkpoint fails', async () => {
    const persistence = new MemoryWorldPersistence();
    let closed = false;
    persistence.saveCheckpoint = async () => {
      throw new Error('checkpoint unavailable');
    };
    persistence.close = async () => {
      closed = true;
    };
    game = await createGameServer(environment, persistence);
    await game.listen(0);
    await expect(game.shutdown()).rejects.toThrow('checkpoint unavailable');
    game = undefined;
    expect(closed).toBe(true);
  });

  it('fans out one shared world tick to twenty connected clients', async () => {
    game = await createGameServer(environment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 20; index += 1) {
      const socket = await connectedSocket(port);
      const welcome = receive<{ type: 'welcome'; playerId: string }>(socket, 'welcome');
      const playerId = `observer-${index}`;
      socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId }));
      await expect(welcome).resolves.toMatchObject({ playerId });
      sockets.push(socket);
    }
    const nextTick = game.host.world.tick + 1;
    const deltas = sockets.map((socket) => receiveDeltaState(socket, nextTick));
    await game.host.tick();
    const received = await Promise.all(deltas);
    expect(received).toHaveLength(20);
    expect(received.every((message) => message.delta.tick >= nextTick)).toBe(true);
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_connected_players 20');
    for (const socket of sockets) socket.terminate();
  });
});
