import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../deps.js';
import { healthSchema } from './schemas.js';

export const healthRoutes: FastifyPluginAsyncZod<Deps> = async (app, { db, pool, config, runtime }) => {
  app.get(
    '/health',
    {
      // Probed every few seconds by Docker and load balancers; only problems deserve a log line.
      logLevel: 'warn',
      schema: {
        tags: ['system'],
        summary: 'Liveness of the database connection, pool pressure and the background workers',
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (request, reply) => {
      const report = {
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        workersEnabled: config.WORKERS_ENABLED,
        workers: runtime.loops.map((loop) => loop.status()),
      };
      try {
        await db.execute(sql`select 1`);
        return { status: 'ok' as const, db: 'ok' as const, ...report };
      } catch (err) {
        request.log.error({ err }, 'health check: database unreachable');
        return reply.status(503).send({ status: 'degraded', db: 'error', ...report });
      }
    },
  );
};
