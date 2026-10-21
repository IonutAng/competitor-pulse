# CompetitorPulse

Tracks competitor product listings over time and uses an LLM to explain, in plain English,
what changed between consecutive snapshots.

- **Backend:** Node 22, TypeScript, Fastify 5, Postgres 16 (Drizzle ORM, SQL migrations)
- **Frontend:** React 19, Vite, TanStack Query, React Router
- **LLM:** the provided mock server by default; OpenAI or Ollama by changing three env vars
- **Packaging:** pnpm workspace, one Dockerfile, `docker compose up` for the whole system
- **Live instance:** <https://app-production-0c64.up.railway.app> (see [Deployment](#deployment))

## Quick start (one command)

Requires Docker with Compose.

```sh
docker compose up --build
```

Then open <http://localhost:3000>, add `acme-crm`, and watch its timeline fill in (a new
version of the listing arrives every poll — 10 s by default — and each change gets a summary).

What that starts:

| Service    | URL                     | Notes                                                                                |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `app`      | <http://localhost:3000> | API + built frontend; interactive API docs at `/docs`; applies migrations on startup |
| `mock-llm` | <http://localhost:4001> | the provided mock LLM server (`/control/*` endpoints exposed); loopback only         |
| `db`       | `localhost:5439`        | Postgres 16 (`app`/`app`, db `competitorpulse`); loopback only                       |

Override the poll interval or ports with `POLL_INTERVAL_MS=30000 APP_PORT=8080 POSTGRES_PORT=5440 docker compose up`.

## Local development

Requires Node ≥ 22.9, pnpm 10 (`npm i -g pnpm@10`), Docker.

```sh
docker compose up -d db mock-llm      # infrastructure only
pnpm install
cp backend/.env.example backend/.env  # defaults match the compose services
pnpm dev                              # backend on :3000 (tsx watch), Vite on :5173 (or the next free port)
```

Vite proxies `/api` to the backend, so the UI is at the Vite URL during development.

```sh
pnpm test                 # unit tests (pure logic: stub, diffing, retry policy, prompt, loop, config)
pnpm test:integration     # against the compose Postgres (database competitorpulse_test); one test spawns the mock LLM
pnpm typecheck
pnpm lint                 # type-aware ESLint; `pnpm format` runs Prettier
pnpm --filter backend db:generate   # regenerate SQL migrations after editing src/db/schema.ts
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, both test suites against a
Postgres service, the frontend build and both Docker builds on every push and pull request.

## How it works

```
   React UI ──▶ Fastify API ──▶ Postgres ◀── poll worker ──▶ ListingSource (fixture stub)
                                  ▲
                                  └── summary worker ──▶ LLM (mock / OpenAI / Ollama)
```

1. `POST /api/competitors` inserts a row that is **due immediately** (`next_poll_at = now()`).
2. The **poll worker** ticks every second. Each tick _claims_ the competitors that are due with a
   single `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` statement, which also schedules
   their next poll `POLL_INTERVAL_MS` from now. Claimed competitors are fetched from the
   `ListingSource` with bounded concurrency.
3. Each fetched listing is stored as a **snapshot** — always, even if nothing changed — inside a
   transaction holding a per-competitor advisory lock. The listing is compared with the latest
   stored snapshot by a hash of its canonical form (trimmed, whitespace collapsed); the fields
   that differ are recorded on the row.
4. A changed snapshot is created with `summary_status = 'pending'`. The **summary worker** claims
   pending rows (same `SKIP LOCKED` pattern, with a lease), calls the LLM with the previous
   snapshot, the new one and the computed list of changed fields, and stores the summary.
   Failures retry with exponential backoff up to `LLM_MAX_ATTEMPTS`; the snapshot row itself was
   committed long before, so a slow or dead LLM can only delay a summary, never lose data.
5. The UI polls the API every few seconds, so summaries appear as they are produced.

### Data source

No scraping: `backend/fixtures/listings.json` (the provided file) holds four versions of each of
`acme-crm`, `north-analytics` and `ferry-pay`. `FixtureListingSource` returns the next version
on every call and repeats the last one once the sequence is exhausted — to the poller it looks
like a page that changed three times and then went quiet. It is one implementation of a
two-method `ListingSource` interface; a real scraper or vendor API would replace it without
touching the workers.

## API

The required contract, exactly as specified:

```
GET    /api/competitors                      -> 200 [{ id, createdAt, lastPolledAt, lastError }]
POST   /api/competitors      { id }          -> 201 { id, ... }      400 invalid id · 409 already tracked
DELETE /api/competitors/:id                  -> 204                   404 not tracked
GET    /api/competitors/:id/snapshots        -> 200 [Snapshot, ...]   newest first · 404 not tracked
```

`Snapshot` carries the contract fields plus a few the UI uses:

```jsonc
{
  "fetchedAt": "2026-10-21T06:21:44.123Z",
  "title": "Acme CRM",
  "tagline": "…",
  "price": "$39/mo",
  "description": "…",
  "changed": true, // false if identical to the previous snapshot
  "summary": "Price rose …", // null if unchanged, pending or failed
  "id": 42, // ordering key; also the keyset cursor
  "isInitial": false, // first snapshot of this competitor (nothing to compare against)
  "previousSnapshotId": 41, // the snapshot this one was diffed against; null for the first
  "changedFields": ["price"], // computed in code, in a fixed order
  "summaryStatus": "done", // none | pending | done | failed
  "summaryError": null, // last LLM error, if any
}
```

Extras:

```
GET    /api/competitors/:id                  -> 200 Competitor · 404           (201 responses carry a Location header to it)
GET    /api/competitors/:id/snapshots?limit=50&before=<id>   keyset pagination; limit defaults to 1000 (the cap)
GET    /api/snapshots/:id                    -> 200 Snapshot · 404
POST   /api/competitors/:id/poll             -> 202 { id, nextPollAt }       "Poll now"
POST   /api/snapshots/:id/retry-summary      -> 202 { id, summaryStatus }    re-queue a failed summary; 202 if already pending · 409 otherwise · 404
GET    /health                               -> 200 { status, db, pool, workersEnabled, workers[] } · 503 if the DB is unreachable
GET    /docs                                 interactive OpenAPI reference (generated from the zod response schemas)
```

Pagination: more pages exist iff a response holds `limit` items; pass the last item's `id` as
`before`. A path id of the wrong type (`/api/snapshots/abc`) is `400 invalid_request`; a
well-formed id that is not tracked — including slugs that could never be valid — is
`404 not_found`.

Every error is `{ "error": { "code", "message" } }` with a stable `code`:

| Code                     | Status | When                                                                    |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `invalid_request`        | 400    | body, params or query failed validation (`issues: [{ path, message }]`) |
| `invalid_json`           | 400    | the JSON body could not be parsed                                       |
| `not_found`              | 404    | unknown route, competitor or snapshot                                   |
| `already_tracked`        | 409    | `POST /api/competitors` for a tracked id                                |
| `invalid_state`          | 409    | retry of a summary that is done or not applicable                       |
| `payload_too_large`      | 413    | body over 1 MiB                                                         |
| `unsupported_media_type` | 415    | a body in something other than JSON                                     |
| `internal`               | 500    | unexpected failure; `requestId` in the body matches the server log line |

Competitor ids are lowercase slugs (`^[a-z0-9][a-z0-9-]{0,62}$`), enforced both by validation
and by a database CHECK. API responses are `Cache-Control: no-store`; security headers come from
helmet (CSP, `nosniff`, `frame-ancestors 'none'`).

## Configuration

All settings are environment variables, validated with zod at startup
(`backend/src/config.ts`; `backend/.env.example` documents them).

| Variable                                             | Default                             | Meaning                                                                                                             |
| ---------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                       | —                                   | Postgres connection string                                                                                          |
| `PG_POOL_MAX`                                        | `10`                                | connection pool size; must be ≥ `POLL_CONCURRENCY + SUMMARY_CONCURRENCY + 2` so workers cannot starve the API       |
| `POLL_INTERVAL_MS`                                   | `10000`                             | how often each competitor is polled (production: `900000` = 15 min)                                                 |
| `SCHEDULER_TICK_MS`                                  | `1000`                              | how often the poll worker looks for due competitors                                                                 |
| `POLL_BATCH_SIZE` / `POLL_CONCURRENCY`               | `10` / `5`                          | competitors claimed per tick / fetched in parallel                                                                  |
| `SOURCE_TIMEOUT_MS`                                  | `10000`                             | timeout for one listing fetch                                                                                       |
| `MAX_LISTING_FIELD_CHARS`                            | `10000`                             | longest text stored per listing field (third-party input); longer values are truncated and logged                   |
| `SUMMARY_TICK_MS` / `SUMMARY_CONCURRENCY`            | `1000` / `3`                        | summary worker cadence / parallel LLM calls                                                                         |
| `SUMMARY_BACKOFF_BASE_MS` / `SUMMARY_BACKOFF_MAX_MS` | `2000` / `60000`                    | retry backoff `base × 2^(attempt−1)`, capped — demo values; production `10000` / `600000` with `LLM_MAX_ATTEMPTS=5` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`         | mock server                         | see below                                                                                                           |
| `LLM_TIMEOUT_MS` / `LLM_MAX_ATTEMPTS`                | `15000` / `3`                       | per-call timeout / attempts before a summary is marked failed                                                       |
| `LLM_MAX_OUTPUT_TOKENS`                              | `200`                               | cap on the model's answer (`max_completion_tokens`); stored summaries are also capped at 2000 characters            |
| `WORKERS_ENABLED`                                    | `true`                              | `false` runs an API-only instance                                                                                   |
| `SHUTDOWN_TIMEOUT_MS`                                | `max(10000, LLM_TIMEOUT_MS + 5000)` | how long a SIGTERM may take (listener closed, in-flight calls aborted, pool drained) before a forced exit           |
| `PORT` / `HOST` / `LOG_LEVEL`                        | `3000` / `0.0.0.0` / `info`         | `.env.example` sets `HOST=127.0.0.1` for local development                                                          |
| `NODE_ENV`                                           | `development`                       | `development` pretty-prints logs; anything else logs JSON                                                           |
| `FIXTURES_PATH` / `STATIC_DIR`                       | bundled fixtures / unset            | the canned listings file / directory of the built frontend to serve (set in the Docker image)                       |

### Which LLM

| Option                                                                                   | `LLM_BASE_URL`              | `LLM_API_KEY` | `LLM_MODEL`        |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------- | ------------------ |
| **Mock server (default)** — `python3 mock-llm/mock-llm-server.py` or the compose service | `http://localhost:4001/v1`  | `mock`        | `mock-llm`         |
| OpenAI                                                                                   | `https://api.openai.com/v1` | your key      | e.g. `gpt-4o-mini` |
| Ollama                                                                                   | `http://localhost:11434/v1` | `ollama`      | e.g. `llama3.2`    |

One client (`backend/src/llm/summarizer.ts`, the official `openai` SDK with a custom base URL)
covers all three. The mock does not summarize: it echoes the first 160 characters of what it was
sent, which is why the prompt _starts_ with the computed diff (`price: "$29/mo" -> "$39/mo"`) —
the echo stays readable, and with a real model the diff is what it should phrase.

## Design decisions

- **Scheduling lives in the database.** `competitors.next_poll_at` plus one atomic claim
  statement gives per-competitor intervals, natural spreading of load, no catch-up storm after
  downtime (next poll is always scheduled from _now_), and horizontal scaling for free: several
  instances can run the worker and `SKIP LOCKED` guarantees no competitor is claimed twice.
  A boot-time clamp pulls far-future rows in when `POLL_INTERVAL_MS` is lowered.
- **Polling is at-most-once per interval; summaries are at-least-once.** If the process dies
  between claim and insert, that poll is skipped and the next one still detects the change
  (polling samples a level, nothing is lost). A summary is an event that must not be dropped,
  so its job survives crashes (the queue _is_ the table), is retried with backoff, and every
  completion or failure write is **fenced** on the attempt number so a worker that lost its
  lease cannot overwrite a newer claim.
- **Diffing is deterministic and happens before the LLM.** Snapshots are compared by a content
  hash of the canonical listing; `changedFields` is computed in code. The LLM is called only on
  a real change — never for the baseline snapshot, never for unchanged polls — and it receives the
  diff rather than having to find it. At 300 competitors every 15 min that is 28 800 fetches/day
  and exactly as many LLM calls as there were changes (times at most `LLM_MAX_ATTEMPTS`).
- **A per-competitor advisory lock around the snapshot insert** serializes overlapping polls of
  the same competitor ("Poll now" during a scheduled poll, or two instances), so two polls can
  never both see the same "previous" row and both report the same change.
- **The schema enforces the summary state machine**: `changed ⇔ summary_status ≠ 'none'`,
  `pending ⇔ summary_next_attempt_at IS NOT NULL`, `done ⇒ summary IS NOT NULL`.
- **`id` is the timeline order**, not `fetched_at`: rows are inserted under the lock, so ids are
  the true linearization; `fetched_at` (set by `clock_timestamp()` at insert) is for display.
- **Migrations run at startup** for one-command startup. With more than one replica this would
  become a release step; the deployed instance runs a single replica.
- **The LLM is behind a typed boundary.** The OpenAI-compatible adapter translates the SDK's
  errors into one `SummarizerError` with a `kind` (timeout, aborted, network, http, empty) and
  decides which are transient (408/429/5xx, timeouts, network) and which are not (a bad key or
  model fails identically next time). The retry policy in `domain/retry.ts` is pure and knows
  nothing about any provider.
- **Response schemas are the wire contract.** Every route serializes through a zod schema
  (`routes/schemas.ts`); undeclared fields never leak, the tests type responses with the same
  schemas, and `/docs` is generated from them.

### Operational robustness

Things that only show up in production, each with a test or a verified run behind it:

- The Postgres pool has an `error` listener (an idle client dropped by a failover used to be an
  uncaught exception that took the whole process down), connect/statement timeouts, and a size
  validated against worker concurrency so the API can never be starved of connections.
- Shutdown is ordered and bounded: the listener closes first (health probes start failing), the
  worker loops stop and abort any LLM or source call in flight through an `AbortSignal`, then the
  pool drains — all within `SHUTDOWN_TIMEOUT_MS`, which compose's `stop_grace_period` exceeds.
- During a dependency outage the worker loops back off exponentially (one stack trace, then one
  short line per attempt) instead of logging a stack trace every second, and `/health` shows
  each loop's last tick, last success and consecutive failures.
- Unhandled rejections and exceptions are logged as structured lines before the process exits
  for the orchestrator to restart (compose: `restart: unless-stopped`).
- Request logging is one line per request, at `info` only for mutations, errors and slow
  requests; `/health` probes and the UI's polling stay at `debug`.

### Scaling further

Not needed for this exercise, but the natural next steps: unchanged snapshots (the vast
majority at scale, ~29 k rows/day for 300 competitors) could store a pointer to the previous
content instead of repeating it, plus a retention policy; a metrics endpoint (claims/tick, LLM
latency, failures) and alerting on `failed` summaries; a real queue (pg-boss) if more job types
appear; a minimum gap for "Poll now" if it were exposed to untrusted users.

## Demo script

`scripts/demo.sh` wraps the curl calls (`APP`/`MOCK` env vars override the URLs).

```sh
scripts/demo.sh reset                     # mock LLM counters back to zero
scripts/demo.sh add acme-crm
sleep 35; scripts/demo.sh show acme-crm   # initial, 3 changed (with summaries), then "no change"
scripts/demo.sh stats                     # {"callCount": 3} — and it stays 3 while polling continues

scripts/demo.sh fail-next 1               # next LLM call returns HTTP 500
scripts/demo.sh add north-analytics       # first change fails once, retry succeeds (callCount +3)

scripts/demo.sh latency 20000             # slower than LLM_TIMEOUT_MS
scripts/demo.sh add ferry-pay             # polling continues; summaries time out, retry with backoff, end "failed"
scripts/demo.sh reset                     # (the mock counts a timed-out call once it finishes serving it)
```

Other things worth showing: `POST /api/competitors/acme-crm/poll` ("Poll now" in the UI);
the "Retry summary" button on a failed snapshot (re-queues it with a fresh attempt budget);
killing the app while a summary is pending and restarting it — the summary still arrives;
removing a competitor while its summary is in flight — nothing crashes; `/docs` for the API
reference; `/health` while the database is stopped.

## Assumptions

- The first snapshot of a competitor is the baseline: `changed: false`, no summary, no LLM call
  (there is nothing to compare against). The UI labels it "Initial snapshot".
- Ids unknown to the data source are accepted (`201`): the tracker cannot know what the outside
  world knows. The first poll records `lastError`, shown in the UI. Rejecting them up front
  would need a source with a cheap existence check.
- Removing a competitor hard-deletes its history (cascade) and resets the stub's sequence for
  that id, so re-adding replays the four versions. A product would soft-delete or retain.
- The stub's cursor is in memory: a backend restart replays the sequence; with several replicas
  each would have its own. That is the stub standing in for the outside world, not system state.
- Whitespace-only edits are not changes. Raw text is stored; comparison uses the canonical form.
- Listing text is third-party data: fields are length-capped in the prompt and the system prompt
  tells the model not to follow instructions found in them. No further hardening.
- Single internal user, no auth. All timestamps are UTC (`Z`).
- The poll interval defaults to 10 s so a demo is watchable; 15 min is the production value.

## Tests

Unit (`backend/test/unit`, 30 tests): the stub's sequencing and repeat-last behaviour against
the real fixtures; diffing (whitespace-insensitive hash, `changedFields` order, no field
bleeding); the retry policy; the prompt (diff first, clipping, empty answers rejected); the
worker loop under fake timers (no overlap, drain, exponential backoff and recovery, prompt stop
with abort); configuration parsing and its cross-field rules.

Integration (`backend/test/integration`, 44 tests, real Postgres): the API contract, error codes
and envelope, `Location`, item endpoints, pagination; two concurrent claimers get disjoint
sets; initial → changed → unchanged snapshot semantics; fetch failures land in `lastError`;
deletion mid-poll; overlapping polls of one competitor are serialized; the summary worker
stores summaries, retries with backoff, gives up after `LLM_MAX_ATTEMPTS`, fails 4xx
immediately, reaps crashed jobs, rejects stale writes, never calls the LLM for unchanged or
initial snapshots, and re-queues on request; the real summarizer against the provided mock
server (spawned by the test: success, 500, timeout, unreachable); app plumbing (stable error
codes, tolerant JSON parsing, `no-store`, security headers, SPA fallback on the decoded path,
`/docs`).

## Deployment

Live at **<https://app-production-0c64.up.railway.app>**. It runs a single replica with a 5-minute
poll interval, so use **Poll now** to advance a competitor's listing instantly when trying it out.

It is deployed on [Railway](https://railway.com) as one project with three services, created and
deployed entirely from the CLI:

```sh
npm i -g @railway/cli && railway login
railway init --name competitor-pulse
railway add --database postgres                              # managed Postgres, service "Postgres"
railway add --service mock-llm --variables PORT=4001
railway add --service app \
  --variables LLM_BASE_URL=http://mock-llm.railway.internal:4001/v1 \
  --variables LLM_API_KEY=mock --variables LLM_MODEL=mock-llm \
  --variables POLL_INTERVAL_MS=300000 --variables PORT=3000 --variables HOST=:: \
  --variables SUMMARY_BACKOFF_BASE_MS=10000 --variables LLM_MAX_ATTEMPTS=5
railway variable set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --service app
railway up --service app --detach                            # uploads the repo, builds the root Dockerfile
(cd mock-llm && railway link -s mock-llm && railway up --detach)   # uploads only mock-llm/, builds its Dockerfile
railway domain --service app --port 3000
```

`railway up` uploads the directory it runs in, so the mock LLM is deployed from inside
`mock-llm/` (linked to its own service) to keep its Dockerfile at the root of the upload.

How the pieces fit:

- **app** is the same image `docker compose` builds (root `Dockerfile`): API, workers and the
  built frontend in one container. It applies migrations on start and owns the public domain.
- **mock-llm** has no public domain. The app reaches it over Railway's private network at
  `http://mock-llm.railway.internal:4001` — plain HTTP, service name as hostname.
- **Postgres** is Railway's managed database. `DATABASE_URL` is a _reference variable_ to its
  private connection string, so no credentials are copied anywhere.
- `HOST=::` makes the app listen on IPv6 as well as IPv4 (Railway's private network is IPv6-first).
- The retry budget is production-sized here (`10 s → 20 s → 40 s → 80 s`, five attempts) rather than
  the demo defaults. Lesson from the first deploy: the app came up two minutes before the mock LLM,
  and with the 2 s/4 s demo backoff the summaries queued in that window burned all three attempts
  in six seconds. Snapshots were intact, as designed, and the "Retry summary" button exists for
  exactly that case — but a dependency outage should be survivable without a human.
- Redeploy with `railway up` again, or connect the GitHub repo in the dashboard for
  push-to-deploy.
- Switching the live instance to a real model is three variables, set without the key ever
  touching a shell history or a chat window:

  ```sh
  railway variable set LLM_BASE_URL=https://api.openai.com/v1 LLM_MODEL=gpt-4o-mini --service app --skip-deploys
  read -rs KEY && printf '%s' "$KEY" | railway variable set LLM_API_KEY --stdin --service app; unset KEY
  ```

  (or add `LLM_API_KEY` as a _sealed_ variable in the dashboard). The last command triggers the
  redeploy. Cost stays negligible: the model is called only on real changes.

Known limits of this deployment: one replica (the fixture stub's cursor is per process, and
startup migrations are not replica-safe — a release step is the production answer), and no
retention, so a tracked competitor adds one row every five minutes forever.

## AI tools used

Claude Code (Anthropic) was used throughout — for planning, scaffolding, writing most of the
code and tests, and as a sparring partner on the design trade-offs above. Every decision was
reviewed, and the resulting system was verified end to end (tests, a scripted run against the
mock LLM, and the UI in a browser) before being committed.

## Project layout

```
backend/
  src/
    main.ts               boot: config → migrate → HTTP → workers; ordered, bounded shutdown
    config.ts             zod-validated environment with cross-field rules
    app.ts                Fastify app: error envelope, helmet, no-store, tolerant JSON, OpenAPI, static frontend
    routes/               the API routes; schemas.ts holds the zod response schemas (wire contract + docs)
    db/schema.ts          tables, indexes and CHECK constraints (drizzle/ holds the generated SQL)
    repo/                 competitors (incl. the claim query), snapshots (locked insert, summary queue)
    source/               ListingSource interface + fixture stub
    domain/               pure logic: diffing/hashing/clipping, retry policy
    llm/                  prompt builder, OpenAI-compatible summarizer with a typed error boundary
    workers/              backing-off loop with abort + status, poll worker, summary worker
  test/unit, test/integration
frontend/src/             api.ts (typed client), components/ui, pages/CompetitorList, pages/CompetitorTimeline
mock-llm/                 the provided mock server + Dockerfile
scripts/demo.sh           curl helpers for demos
.github/workflows/ci.yml  typecheck, lint, format, tests (Postgres service), builds
Dockerfile, docker-compose.yml, eslint.config.js, .prettierrc
```
