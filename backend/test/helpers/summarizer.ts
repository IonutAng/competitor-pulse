import type { ListingField } from '../../src/db/schema.js';
import type { Summarizer } from '../../src/llm/summarizer.js';
import type { Listing } from '../../src/source/listing-source.js';

type Outcome = () => Promise<string>;

/** A scriptable Summarizer: queue outcomes with next(); unscripted calls use the fallback. */
export class FakeSummarizer implements Summarizer {
  readonly calls: Array<{ previous: Listing; current: Listing; changedFields: ListingField[] }> = [];
  private readonly script: Outcome[] = [];

  constructor(private readonly fallback: Outcome = async () => 'summary') {}

  next(outcome: Outcome): this {
    this.script.push(outcome);
    return this;
  }

  async summarize(previous: Listing, current: Listing, changedFields: ListingField[]): Promise<string> {
    this.calls.push({ previous, current, changedFields });
    const outcome = this.script.shift() ?? this.fallback;
    return outcome();
  }
}

/** An error shaped like the OpenAI SDK's APIError for a given HTTP status. */
export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}
