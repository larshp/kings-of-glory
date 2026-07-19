import { createGameServer } from './server.js';

const server = await createGameServer();
await server.listen();

const shutdown = () => {
  void server.shutdown().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
