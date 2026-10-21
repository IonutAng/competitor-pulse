import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiError, LISTING_FIELDS, api, errorText, type Snapshot } from '../api';
import { formatDateTime, timeAgo } from '../time';

const PAGE_SIZE = 50;

export function CompetitorTimeline() {
  const { id = '' } = useParams();

  const timeline = useInfiniteQuery({
    queryKey: ['snapshots', id],
    queryFn: ({ pageParam }) => api.listSnapshots(id, { limit: PAGE_SIZE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.id : undefined),
    // Pending summaries fill in without a reload.
    refetchInterval: 3000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  // The list endpoint carries the competitor's fetch status; reuse its cache.
  const competitors = useQuery({ queryKey: ['competitors'], queryFn: api.listCompetitors, refetchInterval: 5000 });
  const competitor = competitors.data?.find((c) => c.id === id);

  const pollNow = useMutation({ mutationFn: api.pollNow });

  const queryClient = useQueryClient();
  const retrySummary = useMutation({
    mutationFn: api.retrySummary,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['snapshots', id] }),
  });

  if (timeline.isError && timeline.error instanceof ApiError && timeline.error.status === 404) {
    return (
      <p>
        <code>{id}</code> is not tracked. <Link to="/">Back to the list</Link>
      </p>
    );
  }

  const snapshots = timeline.data?.pages.flat() ?? [];

  return (
    <section>
      <p>
        <Link to="/">← All competitors</Link>
      </p>
      <div className="title-row">
        <h2>{id}</h2>
        <button type="button" onClick={() => pollNow.mutate(id)} disabled={pollNow.isPending}>
          Poll now
        </button>
        {pollNow.isSuccess && <span className="muted">queued — the next snapshot appears within a few seconds</span>}
        {pollNow.isError && <span className="error">{errorText(pollNow.error)}</span>}
      </div>
      {competitor?.lastError && (
        <p className="error">
          Last fetch failed: {competitor.lastError}
          {competitor.lastPolledAt && <span className="muted"> ({timeAgo(competitor.lastPolledAt)})</span>}
        </p>
      )}

      {timeline.isPending ? (
        <p>Loading…</p>
      ) : timeline.isError ? (
        <p className="error">Could not load snapshots: {errorText(timeline.error)}</p>
      ) : snapshots.length === 0 ? (
        <p>No snapshots yet — the first poll runs within a few seconds of adding a competitor.</p>
      ) : (
        <ol className="timeline">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id}>
              <SnapshotCard
                snapshot={snapshot}
                onRetry={() => retrySummary.mutate(snapshot.id)}
                retrying={retrySummary.isPending && retrySummary.variables === snapshot.id}
              />
            </li>
          ))}
        </ol>
      )}

      {timeline.hasNextPage && (
        <button type="button" onClick={() => timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage}>
          {timeline.isFetchingNextPage ? 'Loading…' : 'Load older snapshots'}
        </button>
      )}
    </section>
  );
}

function SnapshotCard({ snapshot, onRetry, retrying }: { snapshot: Snapshot; onRetry: () => void; retrying: boolean }) {
  return (
    <article className={`snapshot${snapshot.changed ? ' snapshot-changed' : ''}`}>
      <header>
        <time dateTime={snapshot.fetchedAt} title={snapshot.fetchedAt}>
          {formatDateTime(snapshot.fetchedAt)}
        </time>
        <SummaryBadge snapshot={snapshot} />
      </header>
      <table className="fields">
        <tbody>
          {LISTING_FIELDS.map((field) => (
            <tr key={field} className={snapshot.changedFields.includes(field) ? 'changed' : undefined}>
              <th>{field}</th>
              <td>{snapshot[field]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {snapshot.summaryStatus === 'done' && snapshot.summary && <p className="summary">{snapshot.summary}</p>}
      {snapshot.summaryStatus === 'failed' && (
        <p className="error">
          Summary failed: {snapshot.summaryError ?? 'unknown error'}{' '}
          <button type="button" onClick={onRetry} disabled={retrying}>
            Retry summary
          </button>
        </p>
      )}
    </article>
  );
}

function SummaryBadge({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.isInitial) return <span className="badge">Initial snapshot</span>;
  if (!snapshot.changed) return <span className="badge">No change</span>;
  switch (snapshot.summaryStatus) {
    case 'pending':
      return <span className="badge badge-pending">Changed · summary pending…</span>;
    case 'failed':
      return <span className="badge badge-error">Changed · summary failed</span>;
    case 'done':
      return <span className="badge badge-changed">Changed</span>;
    default:
      return <span className="badge badge-changed">Changed</span>;
  }
}
