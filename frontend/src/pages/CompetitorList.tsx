import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorText, type Competitor } from '../api';
import { Button, Chip, Notice, Skeleton } from '../components/ui';
import { formatDateTime, timeAgo } from '../time';

/** Ids the bundled data source knows; anything else is accepted but reports a fetch error. */
const KNOWN_IDS = ['acme-crm', 'north-analytics', 'ferry-pay'];

export function CompetitorList() {
  const queryClient = useQueryClient();
  const [newId, setNewId] = useState('');

  const competitors = useQuery({
    queryKey: ['competitors'],
    queryFn: api.listCompetitors,
    refetchInterval: 5000,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['competitors'] });

  const add = useMutation({
    mutationFn: api.addCompetitor,
    onSuccess: () => {
      setNewId('');
      return invalidate();
    },
  });
  const remove = useMutation({ mutationFn: api.removeCompetitor, onSuccess: invalidate });
  const pollNow = useMutation({ mutationFn: api.pollNow, onSuccess: invalidate });

  const tracked = new Set(competitors.data?.map((c) => c.id) ?? []);

  return (
    <>
      <div className="section-head">
        <div>
          <h1>Tracked competitors</h1>
          <p className="lede">Each competitor is polled on a schedule; every change to its listing gets a plain-English summary.</p>
        </div>
      </div>

      <section className="card">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const id = newId.trim();
            if (id) add.mutate(id);
          }}
        >
          <label className="form-field">
            <span className="form-label">Competitor id</span>
            <div className="form-row">
              <input
                className="input"
                placeholder="e.g. acme-crm"
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="primary" type="submit" disabled={add.isPending || newId.trim() === ''}>
                {add.isPending ? 'Adding…' : 'Add competitor'}
              </Button>
            </div>
          </label>
        </form>
        {add.isError && <Notice>{errorText(add.error)}</Notice>}
        <p className="hint">
          <span>Lowercase slug. The bundled data source knows</span>
          {KNOWN_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="chip chip-button"
              onClick={() => add.mutate(id)}
              disabled={tracked.has(id) || add.isPending}
              title={tracked.has(id) ? 'Already tracked' : `Track ${id}`}
            >
              {id}
              {tracked.has(id) ? ' ✓' : ''}
            </button>
          ))}
          <span>— other ids are accepted and will report a fetch error.</span>
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            Tracking
            {competitors.data && <Chip>{competitors.data.length}</Chip>}
          </h2>
        </div>

        {competitors.isPending ? (
          <>
            <Skeleton width="55%" />
            <Skeleton width="40%" />
          </>
        ) : competitors.isError ? (
          <Notice>Could not load competitors: {errorText(competitors.error)}</Notice>
        ) : competitors.data.length === 0 ? (
          <div className="empty">
            <strong>Nothing tracked yet.</strong>
            <br />
            Add an id above — <code>acme-crm</code> is a good first one.
          </div>
        ) : (
          <ul className="rows">
            {competitors.data.map((competitor) => (
              <li className="row" key={competitor.id}>
                <div>
                  <Link to={`/competitors/${encodeURIComponent(competitor.id)}`} className="row-title">
                    {competitor.id}
                  </Link>
                  <div className="row-meta">
                    <FetchStatus competitor={competitor} />
                    {competitor.lastPolledAt ? (
                      <span>
                        polled{' '}
                        <time dateTime={competitor.lastPolledAt} title={formatDateTime(competitor.lastPolledAt)}>
                          {timeAgo(competitor.lastPolledAt)}
                        </time>
                      </span>
                    ) : (
                      <span>waiting for the first poll</span>
                    )}
                  </div>
                </div>
                <div className="row-actions">
                  <Button size="sm" onClick={() => pollNow.mutate(competitor.id)} disabled={pollNow.isPending}>
                    Poll now
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => remove.mutate(competitor.id)} disabled={remove.isPending}>
                    Remove
                  </Button>
                  <Link to={`/competitors/${encodeURIComponent(competitor.id)}`} className="btn btn-ghost btn-sm">
                    Timeline →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        {remove.isError && <Notice>Could not remove: {errorText(remove.error)}</Notice>}
        {pollNow.isError && <Notice>Could not schedule a poll: {errorText(pollNow.error)}</Notice>}
      </section>
    </>
  );
}

function FetchStatus({ competitor }: { competitor: Competitor }) {
  if (competitor.lastError) {
    return (
      <Chip tone="danger" title={competitor.lastError}>
        Fetch error
      </Chip>
    );
  }
  if (competitor.lastPolledAt) return <Chip tone="ok">Healthy</Chip>;
  return <Chip>Queued</Chip>;
}
