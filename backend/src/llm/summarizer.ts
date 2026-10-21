import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ListingField } from '../db/schema.js';
import { errorMessage } from '../errors.js';
import type { Listing } from '../source/listing-source.js';
import { buildMessages, extractSummary } from './prompt.js';

export interface Summarizer {
  /**
   * Explains, in plain English, how `current` differs from `previous`. Throws a SummarizerError on
   * any failure. Implementations bound their own latency; `signal` is for cancellation (shutdown).
   */
  summarize(
    previous: Listing,
    current: Listing,
    changedFields: ListingField[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export type SummarizerErrorKind = 'timeout' | 'aborted' | 'network' | 'http' | 'empty';

/** The one error type the worker sees from any provider; `kind` and `status` drive the retry decision. */
export class SummarizerError extends Error {
  constructor(
    message: string,
    readonly kind: SummarizerErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SummarizerError';
  }
}

/**
 * Transient failures are worth another attempt. A rejected request (bad key, unknown model,
 * malformed prompt) will fail identically next time, so retrying it only spends money.
 */
export function isTransientSummarizerError(err: unknown): boolean {
  if (!(err instanceof SummarizerError)) return true; // something other than the LLM failed; assume transient
  if (err.kind !== 'http') return true;
  return err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500;
}

export interface OpenAiCompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * Works against anything that speaks the OpenAI Chat Completions shape: the provided mock
 * server, OpenAI itself, Ollama, and most hosted gateways. Which one is purely configuration.
 */
export class OpenAiCompatibleSummarizer implements Summarizer {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      // Retries live in the summary queue (persisted, visible, bounded by LLM_MAX_ATTEMPTS);
      // the SDK's own retries would multiply the timeout and the bill without showing up anywhere.
      maxRetries: 0,
    });
  }

  async summarize(
    previous: Listing,
    current: Listing,
    changedFields: ListingField[],
    signal?: AbortSignal,
  ): Promise<string> {
    let content: string | null | undefined;
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.options.model,
          messages: buildMessages(previous, current, changedFields),
          max_completion_tokens: this.options.maxOutputTokens,
        },
        { signal },
      );
      content = completion.choices[0]?.message.content;
    } catch (err) {
      throw this.translate(err);
    }
    try {
      return extractSummary(content);
    } catch (err) {
      throw new SummarizerError(errorMessage(err), 'empty');
    }
  }

  /** Maps the SDK's error classes onto SummarizerError; nothing outside this class knows the SDK. */
  private translate(err: unknown): SummarizerError {
    if (err instanceof APIConnectionTimeoutError) {
      return new SummarizerError(`LLM call timed out after ${this.options.timeoutMs} ms`, 'timeout');
    }
    if (err instanceof APIUserAbortError) return new SummarizerError('LLM call aborted', 'aborted');
    if (err instanceof APIConnectionError)
      return new SummarizerError(`LLM unreachable: ${err.message}`, 'network');
    if (err instanceof APIError) {
      const status = typeof err.status === 'number' ? err.status : undefined;
      return new SummarizerError(`LLM returned HTTP ${status ?? '?'}: ${err.message}`, 'http', status);
    }
    return new SummarizerError(errorMessage(err), 'network');
  }
}
