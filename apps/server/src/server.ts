import Fastify, { type FastifyInstance } from 'fastify';
import { VERSION } from './config.ts';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  return app;
}
