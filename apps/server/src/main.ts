import { LISTEN_HOST, LISTEN_PORT } from './config.ts';
import { buildServer } from './server.ts';

const app = buildServer();

try {
  await app.listen({ host: LISTEN_HOST, port: LISTEN_PORT });
  console.log(`Mabari server listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
} catch (error) {
  console.error('Mabari server failed to start:', error);
  process.exit(1);
}
