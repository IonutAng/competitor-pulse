import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../app.js';

export const healthRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db, config }) => {
  app.get('/health', async (request, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok', workers: config.WORKERS_ENABLED };
    } catch (err) {
      request.log.error({ err }, 'health check: database unreachable');
      return reply.status(503).send({ status: 'degraded', db: 'error', workers: config.WORKERS_ENABLED });
    }
  });
};
