// Typed client for the backend API. In dev Vite proxies /api to the backend; in production the
// backend serves this app, so paths are relative either way.

export interface Competitor {
  id: string;
  createdAt: string;
  lastPolledAt: string | null;
  lastError: string | null;
}

export type ListingField = 'title' | 'tagline' | 'price' | 'description';
export const LISTING_FIELDS: ListingField[] = ['title', 'tagline', 'price', 'description'];

export type SummaryStatus = 'none' | 'pending' | 'done' | 'failed';

export interface Snapshot {
  id: number;
  fetchedAt: string;
  title: string;
  tagline: string;
  price: string;
  description: string;
  changed: boolean;
  summary: string | null;
  isInitial: boolean;
  /** null for a competitor's first snapshot; otherwise the snapshot this one was diffed against. */
  previousSnapshotId: number | null;
  changedFields: ListingField[];
  summaryStatus: SummaryStatus;
  summaryError: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'error', error?.message ?? res.statusText);
  }
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  listCompetitors: () => request<Competitor[]>('/api/competitors'),
  addCompetitor: (id: string) =>
    request<Competitor>('/api/competitors', { method: 'POST', body: JSON.stringify({ id }) }),
  removeCompetitor: (id: string) => request<void>(`/api/competitors/${enc(id)}`, { method: 'DELETE' }),
  pollNow: (id: string) =>
    request<{ id: string; nextPollAt: string }>(`/api/competitors/${enc(id)}/poll`, { method: 'POST' }),
  retrySummary: (snapshotId: number) =>
    request<{ id: number; summaryStatus: SummaryStatus }>(`/api/snapshots/${snapshotId}/retry-summary`, {
      method: 'POST',
    }),
  listSnapshots: (id: string, options: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.before !== undefined) query.set('before', String(options.before));
    const suffix = query.size > 0 ? `?${query}` : '';
    return request<Snapshot[]>(`/api/competitors/${enc(id)}/snapshots${suffix}`);
  },
};

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
