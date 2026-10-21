import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { HttpError } from './http-error.js';
import { healthRoutes } from './routes/health.js';

export interface AppDeps {
  config: Config;
  db: Db;
}

export function buildApp(deps: AppDeps, serverOptions: FastifyServerOptions = {}) {
  const app = Fastify(serverOptions).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Every error leaves as { error: { code, message } } so the frontend has one shape to handle.
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request validation failed',
          issues: error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message })),
        },
      });
    }
    const fastifyError = error as Partial<FastifyError>;
    const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.status(status).send({ error: { code: 'internal', message: 'Internal server error' } });
    }
    // Fastify's own client errors (malformed JSON body, unsupported media type, ...).
    return reply.status(status).send({
      error: { code: fastifyError.code ?? 'bad_request', message: fastifyError.message ?? 'Bad request' },
    });
  });

  // In production the backend also serves the built frontend; API 404s stay JSON, everything
  // else falls back to index.html so client-side routes survive a refresh.
  const staticDir = deps.config.STATIC_DIR;
  const serveFrontend = staticDir !== undefined && existsSync(staticDir);
  if (serveFrontend) {
    app.register(fastifyStatic, { root: staticDir, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (serveFrontend && request.method === 'GET' && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply
      .status(404)
      .send({ error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` } });
  });

  app.register(healthRoutes, deps);

  return app;
}

export type App = ReturnType<typeof buildApp>;
