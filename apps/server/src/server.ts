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
import { issueSession, sessionCookie, sessionTokenFromCookie, verifySession } from './auth.js';
import { createStructuredLogger } from './logger.js';

const HEARTBEAT_TIMEOUT_MS = 45_000;
export const MAX_PENDING_COMMANDS = 256;
export const MAX_OUTBOUND_BUFFERED_BYTES = 1_000_000;
export const MAX_ACCOUNT_MESSAGES_PER_SECOND = 60;

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
  await host.restore({ migrate: environment.migrateOnStartup ?? !environment.production });
  let stopping = false;
  let lastTickDurationMs = 0;
  let tickFailures = 0;
  const pendingCommands = new Set<Promise<void>>();
  let pendingTick: Promise<void> | undefined;
  const sessionSecret =
    environment.sessionSecret ?? 'development-only-session-secret-do-not-deploy';
  const verifyConfiguredSession = (token: string | undefined) =>
    verifySession(token, sessionSecret) ??
    (environment.previousSessionSecret
      ? verifySession(token, environment.previousSessionSecret)
      : undefined);
  const accountMessageWindows = new Map<string, { startedAt: number; count: number }>();
  const log = createStructuredLogger(environment.logLevel);
  const httpServer: Server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (environment.production)
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const requireReadMethod = () => {
      if (request.method === 'GET' || request.method === 'HEAD') return true;
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return false;
    };
    if (request.url === '/session') {
      const origin = request.headers.origin;
      const originAllowed =
        !origin ||
        (!environment.production && environment.allowedOrigins.length === 0) ||
        environment.allowedOrigins.includes(origin);
      if (!originAllowed) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (
        environment.production &&
        (!environment.trustProxy || request.headers['x-forwarded-proto'] !== 'https')
      ) {
        response.writeHead(426, { Upgrade: 'TLS/1.2' });
        response.end();
        return;
      }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' });
        response.end();
        return;
      }
      const existingToken = sessionTokenFromCookie(request.headers.cookie);
      const current = verifySession(existingToken, sessionSecret);
      const existing = current ?? verifyConfiguredSession(existingToken);
      const token = current
        ? existingToken!
        : issueSession(sessionSecret, Date.now(), existing?.playerId);
      const session = existing ?? verifySession(token, sessionSecret)!;
      if (!current) response.setHeader('Set-Cookie', sessionCookie(token, environment.production));
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ playerId: session.playerId }));
      return;
    }
    if (request.url === '/' && !environment.production) {
      if (!requireReadMethod()) return;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><title>Kings of Glory server</title><main style="font-family:system-ui;max-width:42rem;margin:4rem auto"><h1>Kings of Glory server is running</h1><p>The browser client is served by Vite at <a href="http://localhost:5173/">http://localhost:5173/</a>.</p><p>Start both development services with <code>npm run dev</code>.</p></main>',
      );
      return;
    }
    if (request.url === '/health') {
      if (!requireReadMethod()) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', processHealthy: true }));
      return;
    }
    if (request.url === '/ready') {
      if (!requireReadMethod()) return;
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
      if (!requireReadMethod()) return;
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
      const tickPhaseMetrics = Object.entries(metrics.tickPhaseDurationsMs)
        .map(([phase, duration]) => `kings_tick_phase_duration_ms{phase="${phase}"} ${duration}`)
        .join('\n');
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(
        `kings_world_tick ${host.world.tick}\nkings_connected_players ${host.connectedPlayerCount}\nkings_tick_duration_ms ${lastTickDurationMs}\n${tickPhaseMetrics}\nkings_tick_failures_total ${tickFailures}\nkings_entities ${Object.keys(host.world.buildings).length}\nkings_active_chunks ${activeChunks}\nkings_active_threats ${Object.keys(host.world.threats).length}\nkings_path_queue_length ${metrics.pathQueueLength}\nkings_commands_pending ${pendingCommands.size}\nkings_outbound_buffered_bytes ${outboundBufferedBytes}\nkings_commands_accepted_total ${metrics.acceptedCommands}\nkings_commands_rejected_total ${metrics.rejectedCommands}\nkings_command_persistence_failures_total ${metrics.persistenceFailures}\nkings_command_duration_ms ${metrics.lastCommandDurationMs}\nkings_checkpoint_failures_total ${metrics.checkpointFailures}\nkings_checkpoint_duration_ms ${metrics.lastCheckpointDurationMs}\nkings_checkpoint_tick ${metrics.lastCheckpointTick}\nkings_recovery_duration_ms ${metrics.lastRecoveryDurationMs}\nkings_journal_lag_ticks ${Math.max(0, host.world.tick - metrics.lastCheckpointTick)}\nkings_state_full_messages_total ${metrics.fullStateMessages}\nkings_state_full_bytes_total ${metrics.fullStateBytes}\nkings_state_delta_messages_total ${metrics.deltaStateMessages}\nkings_state_delta_bytes_total ${metrics.deltaStateBytes}\nkings_state_build_duration_ms ${metrics.lastStateBuildDurationMs}\nkings_process_resident_memory_bytes ${memory.rss}\nkings_process_heap_used_bytes ${memory.heapUsed}\n`,
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
    if (
      environment.production &&
      (!environment.trustProxy || request.headers['x-forwarded-proto'] !== 'https')
    ) {
      socket.close(1008, 'TLS required');
      return;
    }
    const authenticatedPlayerId = verifyConfiguredSession(
      sessionTokenFromCookie(request.headers.cookie),
    )?.playerId;
    if (environment.production && !authenticatedPlayerId) {
      socket.close(1008, 'Authentication required');
      return;
    }
    const connection: Connection = {
      send(message) {
        if (socket.bufferedAmount > MAX_OUTBOUND_BUFFERED_BYTES)
          socket.close(1013, 'Client too slow');
        else socket.send(message);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };
    let connected = false;
    let handshakeStarted = false;
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
        if (handshakeStarted) {
          socket.close(1008, 'Handshake already started');
          return;
        }
        handshakeStarted = true;
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
        if (authenticatedPlayerId && message.playerId !== authenticatedPlayerId) {
          socket.close(1008, 'Authenticated identity mismatch');
          return;
        }
        const playerId = authenticatedPlayerId ?? message.playerId;
        void host
          .connect(connection, playerId)
          .then(() => {
            connected = true;
            connectedPlayerId = playerId;
            log.info('player.connected', { connectionId, playerId });
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
      const accountWindow = accountMessageWindows.get(connectedPlayerId!);
      if (!accountWindow || now - accountWindow.startedAt >= 1_000) {
        accountMessageWindows.set(connectedPlayerId!, { startedAt: now, count: 1 });
        if (accountMessageWindows.size > 10_000)
          for (const [playerId, window] of accountMessageWindows)
            if (now - window.startedAt >= 1_000) accountMessageWindows.delete(playerId);
      } else {
        accountWindow.count += 1;
        if (accountWindow.count > MAX_ACCOUNT_MESSAGES_PER_SECOND) {
          socket.close(1008, 'Account message rate exceeded');
          return;
        }
      }
      if (message.type === 'command') {
        if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
          socket.send(
            JSON.stringify({
              type: 'error',
              code: 'server-busy',
              message: 'The command queue is full. Reconnect and try again.',
            }),
          );
          socket.close(1013, 'Command queue full');
          return;
        }
        const pending = host.command(connection, message.command);
        pendingCommands.add(pending);
        void pending
          .catch((error: unknown) => {
            log.error('world.command_failed', {
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
      if (message.type === 'worldMap')
        host.worldMap(connection, message.requestId, message.after, message.limit);
      if (message.type === 'directorySearch')
        host.directory(connection, message.requestId, message.query, message.after, message.limit);
      if (message.type === 'resync') host.resync(connection);
      if (message.type === 'ping')
        socket.send(JSON.stringify({ type: 'pong', nonce: message.nonce }));
    });
    socket.on('close', (code, reason) => {
      clearInterval(heartbeatTimer);
      host.disconnect(connection);
      log.info('player.disconnected', {
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
        log.error('world.tick_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pendingTick = undefined;
      });
  }, environment.tickIntervalMs);
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
          log.info('server.started', {
            port: address.port,
            worldSeed: environment.worldSeed,
            tickIntervalMs: environment.tickIntervalMs,
          });
          resolve(address.port);
        });
      });
    },
    async shutdown() {
      if (stopping) return;
      stopping = true;
      clearInterval(tickTimer);
      log.info('server.stopping');
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
