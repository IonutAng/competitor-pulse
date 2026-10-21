import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';

/** A logger that discards everything, for unit tests of code that expects one. */
export const silentLog = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
