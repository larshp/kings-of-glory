import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { validateContent } from '@kings/content';
import { MAX_MESSAGE_BYTES, parseClientMessage, PROTOCOL_VERSION } from '@kings/protocol';
import {
  createPostgresWorldPersistence,
  type Connection,
  GlobalWorldHost,
  MemoryWorldPersistence,
  parseEnvironment,
  type ServerEnvironment,
  type WorldPersistence,
} from '@kings/server-runtime';
import { WebSocketServer } from 'ws';

const HEARTBEAT_TIMEOUT_MS = 45_000;

export interface GameServer {
  readonly host: GlobalWorldHost;
  listen(port?: number): Promise<number>;
  shutdown(): Promise<void>;
}

const createPersistence = (environment: ServerEnvironment): WorldPersistence =>
  environment.persistence === 'postgres'
    ? createPostgresWorldPersistence(environment.databaseUrl!)
    : new MemoryWorldPersistence();

/** Builds the HTTP and WebSocket boundary without binding a port, so it is testable in-process. */
export const createGameServer = async (
  environment = parseEnvironment(process.env),
  persistence = createPersistence(environment),
): Promise<GameServer> => {
  const contentErrors = validateContent();
  if (contentErrors.length > 0)
    throw new Error(`Invalid game content: ${contentErrors.join('; ')}`);

  const host = new GlobalWorldHost(
    environment.worldSeed,
    persistence,
    undefined,
    environment.peaceful,
  );
  await host.restore();
  let stopping = false;
  let lastTickDurationMs = 0;
  let tickFailures = 0;
  const pendingCommands = new Set<Promise<void>>();
  let pendingTick: Promise<void> | undefined;
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ level: environment.logLevel, event, ...fields }));
  const httpServer: Server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (environment.production)
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (request.url === '/' && !environment.production) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><title>Kings of Glory server</title><main style="font-family:system-ui;max-width:42rem;margin:4rem auto"><h1>Kings of Glory server is running</h1><p>The browser client is served by Vite at <a href="http://localhost:5173/">http://localhost:5173/</a>.</p><p>Start both development services with <code>npm run dev</code>.</p></main>',
      );
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', processHealthy: true }));
      return;
    }
    if (request.url === '/ready') {
      const ready = !stopping;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: ready ? 'ok' : 'maintenance',
          worldReady: ready,
          tick: host.world.tick,
          connectedPlayers: host.connectedPlayerCount,
        }),
      );
      return;
    }
    if (request.url === '/metrics') {
      const metrics = host.metrics;
      const activeChunks = new Set(
        Object.values(host.world.buildings).map(
          (building) => `${Math.floor(building.x / 16)}:${Math.floor(building.y / 16)}`,
        ),
      ).size;
      const memory = process.memoryUsage();
      const outboundBufferedBytes = [...sockets.clients].reduce(
        (total, socket) => total + socket.bufferedAmount,
        0,
      );
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(
        `kings_world_tick ${host.world.tick}\nkings_connected_players ${host.connectedPlayerCount}\nkings_tick_duration_ms ${lastTickDurationMs}\nkings_tick_failures_total ${tickFailures}\nkings_entities ${Object.keys(host.world.buildings).length}\nkings_active_chunks ${activeChunks}\nkings_active_threats ${Object.keys(host.world.threats).length}\nkings_commands_pending ${pendingCommands.size}\nkings_outbound_buffered_bytes ${outboundBufferedBytes}\nkings_commands_accepted_total ${metrics.acceptedCommands}\nkings_commands_rejected_total ${metrics.rejectedCommands}\nkings_command_persistence_failures_total ${metrics.persistenceFailures}\nkings_command_duration_ms ${metrics.lastCommandDurationMs}\nkings_checkpoint_failures_total ${metrics.checkpointFailures}\nkings_checkpoint_duration_ms ${metrics.lastCheckpointDurationMs}\nkings_checkpoint_tick ${metrics.lastCheckpointTick}\nkings_recovery_duration_ms ${metrics.lastRecoveryDurationMs}\nkings_journal_lag_ticks ${Math.max(0, host.world.tick - metrics.lastCheckpointTick)}\nkings_state_full_messages_total ${metrics.fullStateMessages}\nkings_state_full_bytes_total ${metrics.fullStateBytes}\nkings_state_delta_messages_total ${metrics.deltaStateMessages}\nkings_state_delta_bytes_total ${metrics.deltaStateBytes}\nkings_state_build_duration_ms ${metrics.lastStateBuildDurationMs}\nkings_process_resident_memory_bytes ${memory.rss}\nkings_process_heap_used_bytes ${memory.heapUsed}\n`,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  sockets.on('connection', (socket, request) => {
    const connectionId = randomUUID();
    const origin = request.headers.origin;
    if (
      environment.allowedOrigins.length > 0 &&
      (!origin || !environment.allowedOrigins.includes(origin))
    ) {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    const connection: Connection = {
      send(message) {
        if (socket.bufferedAmount > 1_000_000) socket.close(1013, 'Client too slow');
        else socket.send(message);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };
    let connected = false;
    let connectedPlayerId: string | undefined;
    let windowStartedAt = Date.now();
    let messagesInWindow = 0;
    let lastActivityAt = Date.now();
    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastActivityAt > HEARTBEAT_TIMEOUT_MS)
        socket.close(1001, 'Heartbeat timed out');
    }, HEARTBEAT_TIMEOUT_MS / 3);
    socket.on('message', (data) => {
      lastActivityAt = Date.now();
      if (stopping) {
        socket.close(1012, 'Server maintenance');
        return;
      }
      const now = Date.now();
      if (now - windowStartedAt >= 1_000) {
        windowStartedAt = now;
        messagesInWindow = 0;
      }
      messagesInWindow += 1;
      if (messagesInWindow > 30) {
        socket.close(1008, 'Message rate exceeded');
        return;
      }
      const raw = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      if (raw.byteLength > MAX_MESSAGE_BYTES) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'message-too-large',
            message: 'Message exceeds 64 KiB.',
          }),
        );
        socket.close(1009);
        return;
      }
      const message = parseClientMessage(raw.toString());
      if (!message) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'bad-message',
            message: 'Invalid protocol message.',
          }),
        );
        return;
      }
      if (message.type === 'hello') {
        if (message.version !== PROTOCOL_VERSION) {
          socket.send(
            JSON.stringify({
              type: 'error',
              code: 'version-mismatch',
              message: 'Client upgrade required.',
            }),
          );
          socket.close(1002, 'Client upgrade required');
          return;
        }
        void host
          .connect(connection, message.playerId)
          .then(() => {
            connected = true;
            connectedPlayerId = message.playerId;
            log('player.connected', { connectionId, playerId: message.playerId });
          })
          .catch((error: unknown) => {
            socket.send(
              JSON.stringify({
                type: 'error',
                code: 'bad-message',
                message: error instanceof Error ? error.message : 'Unable to restore player.',
              }),
            );
            socket.close(1011);
          });
        return;
      }
      if (!connected) {
        socket.close(1008, 'Handshake required');
        return;
      }
      if (message.type === 'command') {
        const pending = host.command(connection, message.command);
        pendingCommands.add(pending);
        void pending
          .catch((error: unknown) => {
            log('world.command_failed', {
              connectionId,
              playerId: connectedPlayerId,
              commandId: message.command.id,
              error: error instanceof Error ? error.message : String(error),
            });
            socket.close(1011, 'Command processing failed');
          })
          .finally(() => pendingCommands.delete(pending));
      }
      if (message.type === 'interest') host.setInterest(connection, message.chunks);
      if (message.type === 'resync') host.resync(connection);
      if (message.type === 'ping')
        socket.send(JSON.stringify({ type: 'pong', nonce: message.nonce }));
    });
    socket.on('close', (code, reason) => {
      clearInterval(heartbeatTimer);
      host.disconnect(connection);
      log('player.disconnected', {
        connectionId,
        playerId: connectedPlayerId,
        code,
        reason: reason.toString(),
      });
    });
  });

  const tickTimer = setInterval(() => {
    if (stopping || pendingTick) return;
    const startedAt = performance.now();
    pendingTick = host
      .tick()
      .then(() => {
        lastTickDurationMs = performance.now() - startedAt;
      })
      .catch((error: unknown) => {
        tickFailures += 1;
        log('world.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        pendingTick = undefined;
      });
  }, 100);
  tickTimer.unref();

  return {
    host,
    listen(port = environment.port) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          httpServer.off('error', reject);
          const address = httpServer.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Server did not bind a TCP port.'));
            return;
          }
          log('server.started', { port: address.port, worldSeed: environment.worldSeed });
          resolve(address.port);
        });
      });
    },
    async shutdown() {
      if (stopping) return;
      stopping = true;
      clearInterval(tickTimer);
      log('server.stopping');
      for (const socket of sockets.clients) {
        socket.send(
          JSON.stringify({ type: 'maintenance', message: 'Server maintenance in progress.' }),
        );
        socket.close(1012, 'Server maintenance');
      }
      try {
        if (pendingTick) await pendingTick;
        await Promise.allSettled(pendingCommands);
        await host.checkpoint();
      } finally {
        try {
          await host.close();
        } finally {
          await new Promise<void>((resolve, reject) =>
            httpServer.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    },
  };
};
