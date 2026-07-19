import { createServer } from 'node:http';
import { createPostgresWorldPersistence, GlobalWorldHost, MemoryWorldPersistence, parseEnvironment } from '@kings/server-runtime';
import { MAX_MESSAGE_BYTES, parseClientMessage, PROTOCOL_VERSION } from '@kings/protocol';
import { WebSocketServer } from 'ws';

const env = parseEnvironment(process.env);
const persistence = env.persistence === 'postgres' ? createPostgresWorldPersistence(env.databaseUrl!) : new MemoryWorldPersistence();
const host = new GlobalWorldHost(env.worldSeed, persistence);
await host.restore();
const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', worldReady: true, tick: host.world.tick }));
    return;
  }
  response.writeHead(404); response.end();
});
const sockets = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: env.logLevel, event, ...fields }));

sockets.on('connection', (socket) => {
  let connected = false;
  socket.on('message', (data) => {
    const raw = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (raw.byteLength > MAX_MESSAGE_BYTES) { socket.send(JSON.stringify({ type: 'error', code: 'message-too-large', message: 'Message exceeds 64 KiB.' })); socket.close(1009); return; }
    const message = parseClientMessage(raw.toString());
    if (!message) { socket.send(JSON.stringify({ type: 'error', code: 'bad-message', message: 'Invalid protocol message.' })); return; }
    if (message.type === 'hello') {
      if (message.version !== PROTOCOL_VERSION) { socket.send(JSON.stringify({ type: 'error', code: 'version-mismatch', message: 'Client upgrade required.' })); socket.close(1002); return; }
      host.connect(socket, message.playerId); connected = true; log('player.connected', { playerId: message.playerId }); return;
    }
    if (!connected) { socket.close(1008, 'Handshake required'); return; }
    if (message.type === 'command') void host.command(socket, message.command);
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', nonce: message.nonce }));
  });
  socket.on('close', () => { host.disconnect(socket); log('player.disconnected'); });
});

const tickTimer = setInterval(() => { void host.tick().catch((error: unknown) => log('world.tick_failed', { error: error instanceof Error ? error.message : String(error) })); }, 100);
tickTimer.unref();
httpServer.listen(env.port, () => log('server.started', { port: env.port, worldSeed: env.worldSeed }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true; clearInterval(tickTimer); log('server.stopping');
  for (const socket of sockets.clients) socket.close(1012, 'Server maintenance');
  try { await host.checkpoint(); await host.close(); } finally { httpServer.close(() => process.exit(0)); }
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
