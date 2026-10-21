import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OpenAiCompatibleSummarizer,
  SummarizerError,
  isTransientSummarizerError,
} from '../../src/llm/summarizer.js';
import { v1, v2 } from '../helpers/listings.js';

// The provided mock server, started by this test on a port of its own.
const SCRIPT = fileURLToPath(new URL('../../../mock-llm/mock-llm-server.py', import.meta.url));
const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

async function configure(body: { latencyMs?: number; failNext?: number }) {
  const res = await fetch(`${BASE}/control/configure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
}

function summarizer(timeoutMs = 2000, baseURL = `${BASE}/v1`) {
  return new OpenAiCompatibleSummarizer({
    baseURL,
    apiKey: 'mock',
    model: 'mock-llm',
    timeoutMs,
    maxOutputTokens: 200,
  });
}

const failure = (promise: Promise<unknown>) => promise.then(() => undefined).catch((err: unknown) => err);

describe('OpenAiCompatibleSummarizer against the provided mock server', () => {
  let child: ChildProcess;

  beforeAll(async () => {
    child = spawn('python3', ['-I', SCRIPT], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('mock LLM server did not start');
  });
  afterAll(() => {
    child.kill();
  });

  it('sends the diff and returns the model text', async () => {
    await configure({ latencyMs: 0, failNext: 0 });
    const text = await summarizer().summarize(v1, v2, ['price']);
    expect(text).toContain('price: "$29/mo" -> "$39/mo"');
  });

  it('turns an HTTP 500 into a transient SummarizerError', async () => {
    await configure({ failNext: 1 });
    const err = await failure(summarizer().summarize(v1, v2, ['price']));
    expect(err).toBeInstanceOf(SummarizerError);
    expect(err).toMatchObject({ kind: 'http', status: 500 });
    expect(isTransientSummarizerError(err)).toBe(true);
  });

  it('turns a server slower than LLM_TIMEOUT_MS into a timeout error', async () => {
    await configure({ latencyMs: 1500 });
    const err = await failure(summarizer(300).summarize(v1, v2, ['price']));
    await configure({ latencyMs: 0 });
    expect(err).toBeInstanceOf(SummarizerError);
    expect(err).toMatchObject({ kind: 'timeout' });
    expect((err as Error).message).toMatch(/timed out after 300 ms/);
  });

  it('turns an unreachable server into a network error', async () => {
    const err = await failure(summarizer(2000, 'http://127.0.0.1:1/v1').summarize(v1, v2, ['price']));
    expect(err).toMatchObject({ kind: 'network' });
    expect(isTransientSummarizerError(err)).toBe(true);
  });

  it('classifies HTTP statuses: 4xx permanent except 408/429', () => {
    expect(isTransientSummarizerError(new SummarizerError('bad key', 'http', 401))).toBe(false);
    expect(isTransientSummarizerError(new SummarizerError('unknown model', 'http', 404))).toBe(false);
    expect(isTransientSummarizerError(new SummarizerError('rate limited', 'http', 429))).toBe(true);
    expect(isTransientSummarizerError(new SummarizerError('overloaded', 'http', 503))).toBe(true);
    expect(isTransientSummarizerError(new Error('database down'))).toBe(true);
  });
});
