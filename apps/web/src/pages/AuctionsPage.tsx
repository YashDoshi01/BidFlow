import { useEffect, useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import type { AuctionView } from '../room/roomState.ts';
import type { Session } from '../session.ts';

interface ListResponse {
  items: AuctionView[];
  nextCursor: string | null;
}

export function AuctionsPage({ session }: { session: Session | null }) {
  const [items, setItems] = useState<AuctionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ListResponse>('GET', '/auctions?limit=20')
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load auctions');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <section className="card">
        <h1>Auctions</h1>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {items === null && !error && <p>Loading…</p>}
        {items?.length === 0 && <p>No auctions yet.</p>}
        <ul className="auction-list">
          {items?.map((a) => (
            <li key={a.id}>
              <a href={`#/auction/${a.id}`}>
                <strong>{a.title}</strong>
                <span className={`badge ${a.status.toLowerCase()}`}>{a.status}</span>
                <span className="price">
                  {a.currentPrice} {a.currency}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      {session ? <QuickCreate session={session} /> : <p>Sign in to create an auction or bid.</p>}
    </>
  );
}

/** A deliberately small form: creates and publishes an auction that starts now. */
function QuickCreate({ session }: { session: Session }) {
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('10.00');
  const [minutes, setMinutes] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const startsAt = new Date(Date.now() - 1000).toISOString();
      const endsAt = new Date(Date.now() + Number(minutes) * 60_000).toISOString();
      const created = await api<{ auction: AuctionView }>('POST', '/auctions', {
        token: session.token,
        body: { title, startingPrice: price, startsAt, endsAt },
      });
      await api('POST', `/auctions/${created.auction.id}/publish`, { token: session.token });
      window.location.hash = `#/auction/${created.auction.id}`;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the auction');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Start an auction now</h2>
      <form
        onSubmit={(e) => {
          void submit(e);
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
          />
        </label>
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
          />
        </label>
        <label>
          Duration in minutes
          <input
            required
            type="number"
            min={1}
            max={43200}
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value);
            }}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          Create and start
        </button>
      </form>
    </section>
  );
}
