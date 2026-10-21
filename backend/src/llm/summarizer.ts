import OpenAI from 'openai';
import type { ListingField } from '../db/schema.js';
import type { Listing } from '../source/listing-source.js';
import { buildMessages, extractSummary } from './prompt.js';

export interface Summarizer {
  /** Explains, in plain English, how `current` differs from `previous`. Throws on any failure. */
  summarize(
    previous: Listing,
    current: Listing,
    changedFields: ListingField[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface OpenAiCompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
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
    const completion = await this.client.chat.completions.create(
      { model: this.options.model, messages: buildMessages(previous, current, changedFields) },
      { signal },
    );
    return extractSummary(completion.choices[0]?.message.content);
  }
}
