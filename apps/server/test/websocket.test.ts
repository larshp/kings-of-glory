import { type ServerEnvironment, MemoryWorldPersistence } from '@kings/server-runtime';
import { PROTOCOL_VERSION } from '@kings/protocol';
import { nearestOreTile } from '@kings/simulation';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { issueSession, SESSION_COOKIE, verifySession } from '../src/auth.js';
import { createGameServer, type GameServer } from '../src/server.js';

const environment: ServerEnvironment = {
  port: 3001,
  worldSeed: 91,
  logLevel: 'error',
  persistence: 'memory',
  production: false,
  trustProxy: false,
  allowedOrigins: [],
};
const productionEnvironment: ServerEnvironment = {
  ...environment,
  production: true,
  trustProxy: true,
  allowedOrigins: ['https://game.example'],
  sessionSecret: 'a-production-strength-session-secret-value',
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

    const directory = receive<{
      type: 'directoryPage';
      requestId: string;
      page: { entries: Array<{ type: string; playerId?: string; displayName: string }> };
    }>(socket, 'directoryPage');
    socket.send(
      JSON.stringify({
        type: 'directorySearch',
        requestId: 'directory-1',
        query: 'socket-player',
        limit: 20,
      }),
    );
    await expect(directory).resolves.toMatchObject({
      requestId: 'directory-1',
      page: {
        entries: expect.arrayContaining([
          { type: 'player', playerId: 'socket-player', displayName: 'Settler 1' },
        ]),
      },
    });

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
    const mapPage = receive<{
      type: 'worldMapPage';
      requestId: string;
      page: { chunks: unknown[]; totalExploredChunks: number };
    }>(socket, 'worldMapPage');
    socket.send(JSON.stringify({ type: 'worldMap', requestId: 'map-test', limit: 64 }));
    await expect(mapPage).resolves.toMatchObject({
      type: 'worldMapPage',
      requestId: 'map-test',
      page: { totalExploredChunks: expect.any(Number) },
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
    ).resolves.toContain('kings_tick_phase_duration_ms{phase="advance-clock"}');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_path_queue_length');
    await expect(
      fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text()),
    ).resolves.toContain('kings_checkpoint_tick 0');
    socket.terminate();
  });

  it('derives production identity from an HTTP-only signed session', async () => {
    game = await createGameServer(productionEnvironment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { Origin: 'https://game.example', 'X-Forwarded-Proto': 'https' },
    });
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get('access-control-allow-credentials')).toBe('true');
    const cookie = sessionResponse.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    const { playerId } = (await sessionResponse.json()) as { playerId: string };

    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'https://game.example',
      headers: { Cookie: cookie!.split(';')[0]!, 'X-Forwarded-Proto': 'https' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const welcome = receive<{ type: 'welcome'; playerId: string }>(socket, 'welcome');
    socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId }));
    await expect(welcome).resolves.toMatchObject({ playerId });
    socket.close();
  });

  it('rejects missing sessions and client-selected production identities', async () => {
    game = await createGameServer(productionEnvironment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'https://game.example',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    const unauthenticatedClosed = new Promise<{ code: number; reason: string }>((resolve) =>
      unauthenticated.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    await expect(unauthenticatedClosed).resolves.toEqual({
      code: 1008,
      reason: 'Authentication required',
    });

    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { Origin: 'https://game.example', 'X-Forwarded-Proto': 'https' },
    });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'https://game.example',
      headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    socket.send(
      JSON.stringify({
        type: 'hello',
        version: PROTOCOL_VERSION,
        playerId: 'player-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      }),
    );
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: 'Authenticated identity mismatch',
    });
  });

  it('refreshes a session signed by the previous rotation key', async () => {
    const previousSecret = 'the-previous-production-session-secret-value';
    game = await createGameServer(
      { ...productionEnvironment, previousSessionSecret: previousSecret },
      new MemoryWorldPersistence(),
    );
    const port = await game.listen(0);
    const playerId = 'player-12345678-1234-1234-1234-123456789abc';
    const previousToken = issueSession(previousSecret, Date.now(), playerId);
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: {
        Origin: 'https://game.example',
        'X-Forwarded-Proto': 'https',
        Cookie: `${SESSION_COOKIE}=${previousToken}`,
      },
    });
    await expect(response.json()).resolves.toEqual({ playerId });
    const refreshedToken = response.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    expect(verifySession(refreshedToken, productionEnvironment.sessionSecret!)).toMatchObject({
      playerId,
    });
  });

  it('shares an account message quota across concurrent authenticated connections', async () => {
    game = await createGameServer(productionEnvironment, new MemoryWorldPersistence());
    const port = await game.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      headers: { Origin: 'https://game.example', 'X-Forwarded-Proto': 'https' },
    });
    const { playerId } = (await response.json()) as { playerId: string };
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
          origin: 'https://game.example',
          headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' },
        });
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        const welcome = receive<{ type: 'welcome' }>(socket, 'welcome');
        socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, playerId }));
        await welcome;
        return socket;
      }),
    );
    const rateLimited = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Expected an account rate-limit close.')),
        1_000,
      );
      for (const socket of clients)
        socket.once('close', (code, reason) => {
          if (reason.toString() !== 'Account message rate exceeded') return;
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
    });
    for (const socket of clients)
      for (let index = 0; index < 21; index += 1)
        socket.send(JSON.stringify({ type: 'ping', nonce: `rate-${index}` }));
    await expect(rateLimited).resolves.toEqual({
      code: 1008,
      reason: 'Account message rate exceeded',
    });
    for (const socket of clients) socket.close();
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
