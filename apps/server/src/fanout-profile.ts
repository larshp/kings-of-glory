import { performance } from 'node:perf_hooks';
import { GlobalWorldHost, MemoryWorldPersistence, type Connection } from '@kings/server-runtime';
import { runBotScenario } from '@kings/simulation';

const players = Number(process.argv[2] ?? '20');
const buildingsPerPlayer = Number(process.argv[3] ?? '50');
const ticks = Number(process.argv[4] ?? '20');
if (
  !Number.isSafeInteger(players) ||
  players < 1 ||
  !Number.isSafeInteger(buildingsPerPlayer) ||
  buildingsPerPlayer < 5 ||
  !Number.isSafeInteger(ticks) ||
  ticks < 1
)
  throw new Error(
    'Usage: npm --prefix apps/server run profile:fanout -- [players] [buildings-per-player] [ticks]',
  );

const scenario = runBotScenario(players, 200, buildingsPerPlayer);
if (scenario.invariantErrors.length > 0) throw new Error(scenario.invariantErrors.join('; '));
const persistence = new MemoryWorldPersistence();
await persistence.saveCheckpoint(scenario.state);
const host = new GlobalWorldHost(1, persistence);
await host.restore();

const connections: Array<Connection & { bytes: number; messages: number }> = [];
for (let index = 0; index < players; index += 1) {
  const connection: Connection & { bytes: number; messages: number } = {
    bytes: 0,
    messages: 0,
    send(message) {
      this.bytes += Buffer.byteLength(message, 'utf8');
      this.messages += 1;
    },
    close() {},
  };
  connections.push(connection);
  await host.connect(connection, `bot-${index}`);
}

const baseline = host.metrics;
for (const connection of connections) {
  connection.bytes = 0;
  connection.messages = 0;
}
const startedAt = performance.now();
for (let tick = 0; tick < ticks; tick += 1) await host.tick();
const durationMs = performance.now() - startedAt;
const metrics = host.metrics;
const deltaBytes = metrics.deltaStateBytes - baseline.deltaStateBytes;
const deltaMessages = metrics.deltaStateMessages - baseline.deltaStateMessages;
const bytesPerPlayerPerTick = deltaBytes / players / ticks;

console.log(
  JSON.stringify(
    {
      players,
      buildingsPerPlayer,
      entities: Object.keys(host.world.buildings).length,
      ticks,
      durationMs,
      tickDurationMs: durationMs / ticks,
      deltaMessages,
      deltaBytes,
      bytesPerPlayerPerTick,
      projectedBytesPerSecondPerPlayerAt10Hz: bytesPerPlayerPerTick * 10,
      lastStateBuildDurationMs: metrics.lastStateBuildDurationMs,
      deliveredBytes: connections.reduce((total, connection) => total + connection.bytes, 0),
      deliveredMessages: connections.reduce((total, connection) => total + connection.messages, 0),
    },
    null,
    2,
  ),
);
await host.close();
