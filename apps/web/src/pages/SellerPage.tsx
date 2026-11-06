import { useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { useAuctionList, type ListFilters } from '../hooks/useAuctionList.ts';
import { fromLocalInputValue, toLocalInputValue } from '../lib/datetime.ts';
import type { AuctionView } from '../room/roomState.ts';
import type { Session } from '../session.ts';

// "Hide a button" is a hint, not a check. Every action here is checked again by the API:
// create/edit/publish use the seller from the session, and someone else's draft is a 404.

function problemText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong';
  if (e.code === 'UNAUTHENTICATED') return 'Your session has expired. Please sign in again.';
  if (e.code === 'NETWORK')
    return 'Network problem: nothing was changed that you can rely on. Check the list and try again.';
  if (e.details.length > 0) return e.details.map((d) => `${d.path}: ${d.message}`).join('; ');
  return e.message;
}

export function SellerPage({
  session,
  onSignOut,
}: {
  session: Session | null;
  onSignOut: () => void;
}) {
  const [status, setStatus] = useState<ListFilters['status']>('');
  const [editing, setEditing] = useState<AuctionView | 'new' | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const list = useAuctionList({ q: '', status, mine: true, token: session?.token });

  if (!session) {
    return (
      <section className="card">
        <h1>Your auctions</h1>
        <p>
          <a href="#/login">Sign in</a> to create and manage auctions.
        </p>
      </section>
    );
  }
  const token = session.token;

  async function publish(a: AuctionView): Promise<void> {
    setPublishing(a.id);
    setRowError(null);
    try {
      await api('POST', `/auctions/${a.id}/publish`, { token });
      list.reload();
    } catch (e) {
      setRowError({ id: a.id, message: problemText(e) });
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') onSignOut();
    } finally {
      setPublishing(null);
    }
  }

  return (
    <>
      <section className="card">
        <div className="title-row">
          <h1>Your auctions</h1>
          {editing === null && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setEditing('new');
              }}
              data-testid="new-auction"
            >
              New auction
            </button>
          )}
        </div>
        <p className="hint">
          Drafts can be edited. Once published, an auction can no longer be changed.
        </p>
      </section>

      {editing !== null && (
        <AuctionForm
          key={editing === 'new' ? 'new' : editing.id}
          token={token}
          existing={editing === 'new' ? null : editing}
          onCancel={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
          onSignOut={onSignOut}
        />
      )}

      <section className="card">
        <label className="inline">
          Show
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ListFilters['status']);
            }}
            data-testid="mine-status-filter"
          >
            <option value="">All</option>
            <option value="DRAFT">Drafts</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="LIVE">Live</option>
            <option value="ENDED">Ended</option>
          </select>
        </label>
        {list.error && (
          <div role="alert" className="error-box">
            <p>{list.error}</p>
            <button type="button" onClick={list.reload}>
              Try again
            </button>
          </div>
        )}
        {list.loading && list.items === null && <p aria-live="polite">Loading your auctions…</p>}
        {list.items?.length === 0 && !list.error && (
          <p data-testid="mine-empty">
            {status === '' ? 'You have not created an auction yet.' : 'None with that status.'}
          </p>
        )}
        <ul className="auction-list" data-testid="mine-list">
          {list.items?.map((a) => (
            <li key={a.id} className="seller-row" data-testid="mine-row">
              <div className="seller-main">
                <a href={`#/auction/${a.id}`}>
                  <strong>{a.title}</strong>
                </a>
                <span className={`badge ${a.status.toLowerCase()}`}>{a.status}</span>
                <span className="meta">
                  {a.status === 'DRAFT' ? 'starts' : 'ends'}{' '}
                  {new Date(a.status === 'DRAFT' ? a.startsAt : a.endsAt).toLocaleString()} ·{' '}
                  {a.bidSequence} {a.bidSequence === '1' ? 'bid' : 'bids'} · {a.currentPrice}{' '}
                  {a.currency}
                </span>
              </div>
              {a.status === 'DRAFT' && (
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(a);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={publishing === a.id}
                    onClick={() => {
                      void publish(a);
                    }}
                  >
                    {publishing === a.id ? 'Publishing…' : 'Publish'}
                  </button>
                </div>
              )}
              {rowError?.id === a.id && (
                <p role="alert" className="error">
                  {rowError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
        {list.hasMore && (
          <button type="button" onClick={list.loadMore} disabled={list.loadingMore}>
            {list.loadingMore ? 'Loading…' : 'Show more'}
          </button>
        )}
      </section>
    </>
  );
}

function AuctionForm({
  token,
  existing,
  onCancel,
  onSaved,
  onSignOut,
}: {
  token: string;
  existing: AuctionView | null;
  onCancel: () => void;
  onSaved: () => void;
  onSignOut: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [price, setPrice] = useState(existing?.startingPrice ?? '10.00');
  const [increment, setIncrement] = useState(existing?.minimumIncrement ?? '1.00');
  const [currency, setCurrency] = useState(existing?.currency ?? 'USD');
  const [startsAt, setStartsAt] = useState(existing ? toLocalInputValue(existing.startsAt) : '');
  const [endsAt, setEndsAt] = useState(
    existing
      ? toLocalInputValue(existing.endsAt)
      : toLocalInputValue(new Date(Date.now() + 3_600_000).toISOString()),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);

  async function submit(event: SyntheticEvent, thenPublish: boolean): Promise<void> {
    event.preventDefault();
    setError(null);
    const endIso = fromLocalInputValue(endsAt);
    if (endIso === null) {
      setError('endsAt: choose an end date and time');
      return;
    }
    // Blank start = "as soon as I publish": a moment in the past, so publishing makes it LIVE.
    const startIso = fromLocalInputValue(startsAt) ?? new Date(Date.now() - 1000).toISOString();
    const body = {
      title,
      description,
      startingPrice: price,
      minimumIncrement: increment,
      currency: currency.toUpperCase(),
      startsAt: startIso,
      endsAt: endIso,
    };
    setBusy(thenPublish ? 'publish' : 'save');
    let savedId: string | null = null;
    try {
      const saved = existing
        ? await api<{ auction: AuctionView }>('PATCH', `/auctions/${existing.id}`, { token, body })
        : await api<{ auction: AuctionView }>('POST', '/auctions', { token, body });
      savedId = saved.auction.id;
      if (thenPublish) {
        await api('POST', `/auctions/${savedId}/publish`, { token });
        window.location.hash = `#/auction/${savedId}`;
        return;
      }
      onSaved();
    } catch (e) {
      // If saving worked but publishing failed, say so: the draft exists.
      const prefix = savedId !== null && thenPublish ? 'Saved as a draft, but not published. ' : '';
      setError(prefix + problemText(e));
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') onSignOut();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="form-title">
      <h2 id="form-title">{existing ? 'Edit draft' : 'New auction'}</h2>
      <form
        onSubmit={(e) => {
          void submit(e, false);
        }}
      >
        <label>
          Title
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            data-testid="f-title"
          />
        </label>
        <label>
          Description
          <textarea
            maxLength={5000}
            rows={4}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            data-testid="f-description"
          />
        </label>
        <div className="grid3">
          <label>
            Starting price
            <input
              required
              inputMode="decimal"
              pattern="\d{1,10}(\.\d{1,2})?"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
              data-testid="f-price"
            />
          </label>
          <label>
            Minimum increment
            <input
              required
              inputMode="decimal"
              pattern="\d{1,10}(\.\d{1,2})?"
              value={increment}
              onChange={(e) => {
                setIncrement(e.target.value);
              }}
              data-testid="f-increment"
            />
          </label>
          <label>
            Currency
            <input
              required
              maxLength={3}
              pattern="[A-Za-z]{3}"
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
              }}
              data-testid="f-currency"
            />
          </label>
        </div>
        <div className="grid2">
          <label>
            Starts <small>(leave empty to start when published)</small>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => {
                setStartsAt(e.target.value);
              }}
              data-testid="f-starts"
            />
          </label>
          <label>
            Ends <small>(1 minute to 30 days after the start)</small>
            <input
              required
              type="datetime-local"
              value={endsAt}
              onChange={(e) => {
                setEndsAt(e.target.value);
              }}
              data-testid="f-ends"
            />
          </label>
        </div>
        <p className="hint">
          Late bids can extend the end (anti-sniping): the last two minutes, up to 10 times, at most
          one hour past the end you set here.
        </p>
        {error && (
          <p role="alert" className="error" data-testid="form-error">
            {error}
          </p>
        )}
        <div className="row-actions">
          <button type="submit" disabled={busy !== null} data-testid="f-save">
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={(e) => {
              const form = e.currentTarget.form;
              if (form && !form.reportValidity()) return;
              void submit(e, true);
            }}
            data-testid="f-publish"
          >
            {busy === 'publish' ? 'Publishing…' : 'Save and publish'}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
