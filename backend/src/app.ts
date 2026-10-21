import { existsSync } from 'node:fs';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Deps } from './deps.js';
import { HttpError } from './http-error.js';
import { competitorRoutes } from './routes/competitors.js';
import { healthRoutes } from './routes/health.js';
import { snapshotRoutes } from './routes/snapshots.js';

/** Fastify's own client-error codes, mapped to this API's stable vocabulary. */
const FASTIFY_ERROR_CODES: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
};

/** True for /api and anything under it, judged on the decoded path (never the raw URL). */
function isApiPath(url: string): boolean {
  const rawPath = url.split('?', 1)[0] ?? '';
  try {
    const pathname = decodeURIComponent(rawPath);
    return pathname === '/api' || pathname.startsWith('/api/');
  } catch {
    return true; // malformed percent-encoding: answer with a JSON 404, not the SPA
  }
}

export function buildApp(deps: Deps, serverOptions: FastifyServerOptions = {}) {
  const { config } = deps;
  const app = Fastify({
    // Requests are logged by the onResponse hook below, at a level that depends on the outcome.
    disableRequestLogging: true,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    ...serverOptions,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Security headers. Swagger UI relies on inline scripts, so it is left on Fastify's defaults.
  app.register(helmet, {
    global: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: config.NODE_ENV === 'production',
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/docs')) reply.helmet();
    // The UI polls the API; no intermediary may ever serve any of it stale.
    if (isApiPath(request.url)) void reply.header('cache-control', 'no-store');
  });

  // One line per request: info for anything that changed state, failed or was slow; debug otherwise.
  app.addHook('onResponse', (request, reply, done) => {
    const status = reply.statusCode;
    const level =
      status >= 500
        ? 'error'
        : status >= 400 || request.method !== 'GET' || reply.elapsedTime > 1000
          ? 'info'
          : 'debug';
    request.log[level](
      { method: request.method, url: request.url, statusCode: status, ms: Math.round(reply.elapsedTime) },
      'request',
    );
    done();
  });

  // A body-less POST that still carries content-type: application/json (Postman, fetch wrappers)
  // must not die in the JSON parser; the route's schema decides whether a body was required.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '') {
      done(null, undefined);
      return;
    }
    void app.getDefaultJsonParser('error', 'error')(request, text, done);
  });

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
      return reply
        .status(status)
        .send({ error: { code: 'internal', message: 'Internal server error', requestId: request.id } });
    }
    // Fastify's own client errors (malformed JSON body, unsupported media type, ...).
    return reply.status(status).send({
      error: {
        code: FASTIFY_ERROR_CODES[fastifyError.code ?? ''] ?? 'bad_request',
        message: fastifyError.message ?? 'Bad request',
      },
    });
  });

  // Interactive API reference, generated from the zod schemas on each route.
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'CompetitorPulse API',
        version: '0.1.0',
        description:
          'Tracks competitor product listings over time and summarizes changes. Every error is `{ error: { code, message } }`.',
      },
      tags: [
        { name: 'competitors', description: 'Which competitors are tracked' },
        { name: 'snapshots', description: 'A competitor’s listing history and its AI summaries' },
        { name: 'system' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  // In production the backend also serves the built frontend; API 404s stay JSON, everything
  // else falls back to index.html so client-side routes survive a refresh.
  const staticDir = config.STATIC_DIR;
  const serveFrontend = staticDir !== undefined && existsSync(staticDir);
  if (staticDir !== undefined && !serveFrontend) {
    app.log.warn({ staticDir }, 'STATIC_DIR does not exist; the frontend will not be served');
  }
  if (serveFrontend) {
    app.register(fastifyStatic, { root: staticDir, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    if (serveFrontend && request.method === 'GET' && !isApiPath(request.url)) {
      return reply.sendFile('index.html');
    }
    return reply
      .status(404)
      .send({ error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` } });
  });

  app.register(healthRoutes, deps);
  app.register(competitorRoutes, deps);
  app.register(snapshotRoutes, deps);

  return app;
}
