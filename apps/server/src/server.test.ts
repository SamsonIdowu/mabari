import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LISTEN_HOST, VERSION } from './config.ts';
import { buildServer } from './server.ts';

describe('server', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports health', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: VERSION });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
  });

  it('only listens on this computer', () => {
    expect(LISTEN_HOST).toBe('127.0.0.1');
  });
});
