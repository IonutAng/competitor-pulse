import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, LISTING_FIELDS, api, errorText, type Snapshot } from '../api';
import { Button, Chip, Notice, Skeleton, SparkIcon } from '../components/ui';
import { formatDateTime, timeAgo } from '../time';

const PAGE_SIZE = 50;

type SnapshotState = 'initial' | 'unchanged' | 'pending' | 'failed' | 'changed';

function stateOf(snapshot: Snapshot): SnapshotState {
  if (snapshot.isInitial) return 'initial';
  if (!snapshot.changed) return 'unchanged';
  if (snapshot.summaryStatus === 'pending') return 'pending';
  if (snapshot.summaryStatus === 'failed') return 'failed';
  return 'changed';
}

export function CompetitorTimeline() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const timeline = useInfiniteQuery({
    queryKey: ['snapshots', id],
    queryFn: ({ pageParam }) => api.listSnapshots(id, { limit: PAGE_SIZE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.id : undefined,
    // Pending summaries fill in without a reload.
    refetchInterval: 3000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  // The list endpoint carries the competitor's fetch status; reuse its cache.
  const competitors = useQuery({
    queryKey: ['competitors'],
    queryFn: api.listCompetitors,
    refetchInterval: 5000,
  });
  const competitor = competitors.data?.find((c) => c.id === id);

  const pollNow = useMutation({ mutationFn: api.pollNow });
  const retrySummary = useMutation({
    mutationFn: api.retrySummary,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['snapshots', id] }),
  });

  if (timeline.isError && timeline.error instanceof ApiError && timeline.error.status === 404) {
    return (
      <div className="card">
        <h2>
          <code>{id}</code> is not tracked
        </h2>
        <p className="muted">
          <Link to="/">Back to the tracked competitors</Link>
        </p>
      </div>
    );
  }

  const snapshots = timeline.data?.pages.flat() ?? [];
  // Lets a card show "old → new" for its changed fields when its predecessor is loaded.
  const byId = new Map(snapshots.map((s) => [s.id, s]));

  return (
    <>
      <p className="small">
        <Link to="/">← All competitors</Link>
      </p>
      <div className="tl-head">
        <h1>{id}</h1>
        {competitor?.lastError ? (
          <Chip tone="danger" title={competitor.lastError}>
            Fetch error
          </Chip>
        ) : competitor?.lastPolledAt ? (
          <Chip tone="ok">Healthy</Chip>
        ) : null}
        <Button variant="primary" size="sm" onClick={() => pollNow.mutate(id)} disabled={pollNow.isPending}>
          Poll now
        </Button>
        {pollNow.isSuccess && (
          <span className="muted small">queued — the next snapshot appears within a few seconds</span>
        )}
        {pollNow.isError && (
          <span className="small" style={{ color: 'var(--danger)' }}>
            {errorText(pollNow.error)}
          </span>
        )}
      </div>
      {competitor?.lastError && (
        <Notice>
          Last fetch failed: {competitor.lastError}
          {competitor.lastPolledAt && <span> ({timeAgo(competitor.lastPolledAt)})</span>}
        </Notice>
      )}

      {timeline.isPending ? (
        <div className="card">
          <Skeleton width="35%" />
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </div>
      ) : timeline.isError ? (
        <Notice>Could not load snapshots: {errorText(timeline.error)}</Notice>
      ) : snapshots.length === 0 ? (
        <div className="empty">
          <strong>No snapshots yet.</strong>
          <br />
          The first poll runs within a few seconds of adding a competitor.
        </div>
      ) : (
        <ol className="timeline">
          {snapshots.map((snapshot) => {
            const state = stateOf(snapshot);
            return (
              <li key={snapshot.id} className={`tl-item tl-${state}`}>
                <span className="tl-dot" aria-hidden="true" />
                <SnapshotCard
                  snapshot={snapshot}
                  state={state}
                  previous={
                    snapshot.previousSnapshotId === null ? undefined : byId.get(snapshot.previousSnapshotId)
                  }
                  onRetry={() => retrySummary.mutate(snapshot.id)}
                  retrying={retrySummary.isPending && retrySummary.variables === snapshot.id}
                />
              </li>
            );
          })}
        </ol>
      )}

      {timeline.hasNextPage && (
        <div className="load-more">
          <Button onClick={() => timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage}>
            {timeline.isFetchingNextPage ? 'Loading…' : 'Load older snapshots'}
          </Button>
        </div>
      )}
    </>
  );
}

function SnapshotCard({
  snapshot,
  state,
  previous,
  onRetry,
  retrying,
}: {
  snapshot: Snapshot;
  state: SnapshotState;
  previous: Snapshot | undefined;
  onRetry: () => void;
  retrying: boolean;
}) {
  const showDiff = snapshot.changed && previous !== undefined && snapshot.changedFields.length > 0;
  return (
    <article className="card snapshot">
      <header className="snapshot-head">
        <span className="snapshot-time">
          <time dateTime={snapshot.fetchedAt} title={snapshot.fetchedAt}>
            {formatDateTime(snapshot.fetchedAt)}
          </time>
          <span className="muted">{timeAgo(snapshot.fetchedAt)}</span>
        </span>
        <StateChip state={state} />
      </header>

      {showDiff && (
        <ul className="diff">
          {snapshot.changedFields.map((field) => (
            <li key={field}>
              <span className="diff-field">{field}</span>
              <span>
                <span className="diff-old">{previous[field]}</span>
                <span className="diff-arrow">→</span>
                <span className="diff-new">{snapshot[field]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <dl className={`fields${state === 'unchanged' ? ' fields-compact' : ''}`}>
        {LISTING_FIELDS.map((field) => (
          // The diff above already points at what changed; highlight rows only when it could not be shown.
          <div
            key={field}
            className={!showDiff && snapshot.changedFields.includes(field) ? 'changed' : undefined}
          >
            <dt>{field}</dt>
            <dd>{snapshot[field]}</dd>
          </div>
        ))}
      </dl>

      {snapshot.changed && (
        <div className={`summary summary-${snapshot.summaryStatus}`}>
          <div className="summary-label">
            <SparkIcon />
            AI summary
          </div>
          {snapshot.summaryStatus === 'done' && <p>{snapshot.summary}</p>}
          {snapshot.summaryStatus === 'pending' && (
            <>
              <Skeleton width="92%" />
              <Skeleton width="68%" />
              <p className="muted small">Waiting for the model…</p>
            </>
          )}
          {snapshot.summaryStatus === 'failed' && (
            <>
              <p>{snapshot.summaryError ?? 'Unknown error'}</p>
              <Button size="sm" onClick={onRetry} disabled={retrying}>
                {retrying ? 'Queuing…' : 'Retry summary'}
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function StateChip({ state }: { state: SnapshotState }) {
  switch (state) {
    case 'initial':
      return <Chip tone="ok">Initial snapshot</Chip>;
    case 'unchanged':
      return <Chip>No change</Chip>;
    case 'pending':
      return <Chip tone="warn">Changed · summarizing…</Chip>;
    case 'failed':
      return <Chip tone="danger">Changed · summary failed</Chip>;
    case 'changed':
      return <Chip tone="accent">Changed</Chip>;
  }
}
