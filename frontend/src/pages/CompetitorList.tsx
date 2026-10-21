import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api';
import { formatDateTime, timeAgo } from '../time';

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

  return (
    <section>
      <h2>Tracked competitors</h2>

      <form
        className="add-form"
        onSubmit={(event) => {
          event.preventDefault();
          const id = newId.trim();
          if (id) add.mutate(id);
        }}
      >
        <input
          aria-label="Competitor id"
          placeholder="competitor id, e.g. acme-crm"
          value={newId}
          onChange={(event) => setNewId(event.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={add.isPending || newId.trim() === ''}>
          Add
        </button>
      </form>
      {add.isError && <p className="error">{errorText(add.error)}</p>}
      <p className="muted">
        The bundled data source knows <code>acme-crm</code>, <code>north-analytics</code> and <code>ferry-pay</code>. Other
        ids are accepted but will report a fetch error.
      </p>

      {competitors.isPending ? (
        <p>Loading…</p>
      ) : competitors.isError ? (
        <p className="error">Could not load competitors: {errorText(competitors.error)}</p>
      ) : competitors.data.length === 0 ? (
        <p>No competitors tracked yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Competitor</th>
              <th>Last polled</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {competitors.data.map((competitor) => (
              <tr key={competitor.id}>
                <td>
                  <Link to={`/competitors/${encodeURIComponent(competitor.id)}`}>{competitor.id}</Link>
                </td>
                <td>
                  {competitor.lastPolledAt ? (
                    <span title={formatDateTime(competitor.lastPolledAt)}>{timeAgo(competitor.lastPolledAt)}</span>
                  ) : (
                    <span className="muted">not yet</span>
                  )}
                </td>
                <td>
                  {competitor.lastError ? (
                    <span className="badge badge-error" title={competitor.lastError}>
                      fetch error
                    </span>
                  ) : competitor.lastPolledAt ? (
                    <span className="badge badge-ok">ok</span>
                  ) : (
                    <span className="badge">queued</span>
                  )}
                </td>
                <td className="actions">
                  <button type="button" onClick={() => pollNow.mutate(competitor.id)} disabled={pollNow.isPending}>
                    Poll now
                  </button>
                  <button type="button" onClick={() => remove.mutate(competitor.id)} disabled={remove.isPending}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remove.isError && <p className="error">Could not remove: {errorText(remove.error)}</p>}
      {pollNow.isError && <p className="error">Could not schedule a poll: {errorText(pollNow.error)}</p>}
    </section>
  );
}
