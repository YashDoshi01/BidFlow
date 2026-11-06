import { useState } from 'react';
import { useAuctionList, useDebounced, type ListFilters } from '../hooks/useAuctionList.ts';
import type { Session } from '../session.ts';

const STATUS_OPTIONS: { value: ListFilters['status']; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'LIVE', label: 'Live now' },
  { value: 'SCHEDULED', label: 'Upcoming' },
  { value: 'ENDED', label: 'Ended' },
];

export function AuctionsPage({ session }: { session: Session | null }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ListFilters['status']>('');
  const q = useDebounced(text, 300);
  const list = useAuctionList({ q, status, mine: false });
  const filtered = q.trim() !== '' || status !== '';

  return (
    <>
      <section className="card">
        <h1>Auctions</h1>
        <form
          className="filters"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <label>
            Search titles
            <input
              type="search"
              maxLength={100}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              data-testid="search"
            />
          </label>
          <label>
            Show
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as ListFilters['status']);
              }}
              data-testid="status-filter"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </form>

        {list.error && (
          <div role="alert" className="error-box" data-testid="list-error">
            <p>{list.error}</p>
            <button type="button" onClick={list.reload}>
              Try again
            </button>
          </div>
        )}
        {list.loading && list.items === null && (
          <p aria-live="polite" data-testid="list-loading">
            Loading auctions…
          </p>
        )}
        {list.items?.length === 0 && !list.error && (
          <p data-testid="list-empty">
            {filtered
              ? 'No auction matches. Try a different search or filter.'
              : 'No auctions yet.'}
          </p>
        )}
        {list.items && list.items.length > 0 && (
          <p className="hint" aria-live="polite" data-testid="list-count">
            {String(list.items.length)} shown{list.hasMore ? ', more available' : ''}
          </p>
        )}
        <ul className="auction-list" aria-busy={list.loading}>
          {list.items?.map((a) => (
            <li key={a.id}>
              <a href={`#/auction/${a.id}`} data-testid="auction-link">
                <strong>{a.title}</strong>
                <span className={`badge ${a.status.toLowerCase()}`}>{a.status}</span>
                <span className="meta">
                  {a.bidSequence} {a.bidSequence === '1' ? 'bid' : 'bids'} · ends{' '}
                  {new Date(a.endsAt).toLocaleString()}
                </span>
                <span className="price">
                  {a.currentPrice} {a.currency}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {list.hasMore && (
          <button
            type="button"
            onClick={list.loadMore}
            disabled={list.loadingMore}
            data-testid="load-more"
          >
            {list.loadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
      </section>
      {!session && (
        <p>
          <a href="#/login">Sign in</a> to sell or to bid.
        </p>
      )}
      {session && (
        <p>
          <a href="#/sell">Sell something</a>
        </p>
      )}
    </>
  );
}
