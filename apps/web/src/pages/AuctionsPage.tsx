import { useState } from 'react';
import { Countdown } from '../components/Countdown.tsx';
import { IconBolt, IconSearch, IconShield, IconTimerPlus } from '../components/Icons.tsx';
import { Cover, StatusBadge } from '../components/ui.tsx';
import { useAuctionList, useDebounced, type ListFilters } from '../hooks/useAuctionList.ts';
import { groupThousands } from '../lib/money.ts';
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
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="live-dot" aria-hidden="true" /> Real-time bidding
          </p>
          <h1 className="hero-title">
            Bid live. <span className="gradient-text">Win fair.</span>
          </h1>
          <p className="hero-lead">
            Every bid is checked by the server and shown to everyone in the room the moment it is
            accepted. No refresh, no guessing.
          </p>
          <div className="hero-actions">
            {session ? (
              <a className="button primary" href="#/sell">
                Start selling
              </a>
            ) : (
              <a className="button primary" href="#/login">
                Create a free account
              </a>
            )}
            {/* A button, not href="#browse": the hash is the router, so an anchor would change the route. */}
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                document.getElementById('browse')?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              Browse what is on
            </button>
          </div>
        </div>
        <ul className="feature-list">
          <li>
            <span className="feature-icon">
              <IconBolt />
            </span>
            <div>
              <strong>Live updates</strong>
              <span>Prices and bids arrive over WebSockets in order.</span>
            </div>
          </li>
          <li>
            <span className="feature-icon">
              <IconTimerPlus />
            </span>
            <div>
              <strong>No sniping</strong>
              <span>A bid in the last two minutes extends the clock.</span>
            </div>
          </li>
          <li>
            <span className="feature-icon">
              <IconShield />
            </span>
            <div>
              <strong>One winner, always</strong>
              <span>The database decides; a retried bid never counts twice.</span>
            </div>
          </li>
        </ul>
      </section>

      <section className="section" id="browse" aria-labelledby="browse-title">
        <div className="section-head">
          <h2 id="browse-title">Auctions</h2>
          {list.items && list.items.length > 0 && (
            <p className="hint" aria-live="polite" data-testid="list-count">
              {String(list.items.length)} shown{list.hasMore ? ', more available' : ''}
            </p>
          )}
        </div>
        <form
          className="toolbar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <label className="search-field">
            <span className="visually-hidden">Search titles</span>
            <IconSearch />
            <input
              type="search"
              maxLength={100}
              placeholder="Search titles"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
              }}
              data-testid="search"
            />
          </label>
          <label className="select-field">
            <span className="visually-hidden">Show</span>
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
            <button type="button" className="button" onClick={list.reload}>
              Try again
            </button>
          </div>
        )}
        {list.loading && list.items === null && (
          <>
            <p aria-live="polite" className="visually-hidden" data-testid="list-loading">
              Loading auctions…
            </p>
            <div className="auction-grid" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="auction-card skeleton">
                  <div className="cover cover-card" />
                  <div className="card-body">
                    <span className="skeleton-line wide" />
                    <span className="skeleton-line" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {list.items?.length === 0 && !list.error && (
          <div className="empty-state" data-testid="list-empty">
            <p className="empty-title">
              {filtered
                ? 'No auction matches. Try a different search or filter.'
                : 'No auctions yet.'}
            </p>
            {!filtered && session && (
              <a className="button primary" href="#/sell">
                Create the first one
              </a>
            )}
          </div>
        )}
        <ul className="auction-grid" aria-busy={list.loading}>
          {list.items?.map((a) => (
            <li key={a.id}>
              <a href={`#/auction/${a.id}`} className="auction-card" data-testid="auction-link">
                <div className="cover-wrap">
                  <Cover auction={a} />
                  <StatusBadge status={a.status} />
                </div>
                <div className="card-body">
                  <strong className="card-title">{a.title}</strong>
                  <div className="card-price-row">
                    <span className="price">
                      <span className="price-label">
                        {a.status === 'ENDED'
                          ? 'Final'
                          : a.bidSequence === '0'
                            ? 'Starts at'
                            : 'Current'}
                      </span>
                      <span className="price-value">
                        {groupThousands(a.currentPrice)} <small>{a.currency}</small>
                      </span>
                    </span>
                    <span className="bid-pill">
                      {a.bidSequence} {a.bidSequence === '1' ? 'bid' : 'bids'}
                    </span>
                  </div>
                  <span className="meta">
                    {a.status === 'LIVE' || a.status === 'SCHEDULED' ? (
                      <Countdown auction={a} variant="inline" testId="card-countdown" />
                    ) : (
                      <>ends {new Date(a.endsAt).toLocaleString()}</>
                    )}
                  </span>
                </div>
              </a>
            </li>
          ))}
        </ul>
        {list.hasMore && (
          <div className="center">
            <button
              type="button"
              className="button"
              onClick={list.loadMore}
              disabled={list.loadingMore}
              data-testid="load-more"
            >
              {list.loadingMore ? 'Loading…' : 'Show more'}
            </button>
          </div>
        )}
      </section>

      {!session && (
        <section className="cta-band">
          <div>
            <h2>Have something to sell?</h2>
            <p>Create an account, list it in a minute, and watch the bids come in live.</p>
          </div>
          <a className="button primary" href="#/login">
            Sign in to sell or to bid
          </a>
        </section>
      )}
    </>
  );
}
