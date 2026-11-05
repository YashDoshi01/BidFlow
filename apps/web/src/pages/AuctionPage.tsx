import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { useAuctionRoom } from '../room/useAuctionRoom.ts';
import type { BidView } from '../room/roomState.ts';
import type { Session } from '../session.ts';

interface PlaceBidReply {
  bid: BidView;
  auction: {
    currentPrice: string;
    bidSequence: string;
    endsAt: string;
    minimumNextBid: string | null;
  };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

function countdown(endsAt: string, now: number): string {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${String(h)}h ${String(m)}m` : `${String(m)}m ${String(s % 60)}s`;
}

function bidErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong';
  switch (error.code) {
    case 'BID_TOO_LOW':
      return `Too low. The minimum bid is ${error.data?.['minimumAcceptableBid'] ?? 'higher'}.`;
    case 'AUCTION_ENDED':
      return 'This auction has ended.';
    case 'AUCTION_NOT_LIVE':
      return 'This auction is not accepting bids.';
    case 'BIDDER_IS_SELLER':
      return 'You cannot bid on your own auction.';
    case 'UNAUTHENTICATED':
      return 'Your session has expired. Please sign in again.';
    case 'NETWORK':
      return 'Network problem. You can press the button again: the same request is safe to repeat.';
    default:
      return error.message;
  }
}

export function AuctionPage({
  auctionId,
  session,
  onSignOut,
}: {
  auctionId: string;
  session: Session | null;
  onSignOut: () => void;
}) {
  const { state, dispatch, authFailed, joinError } = useAuctionRoom(auctionId, session?.token);
  const now = useNow(1000);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The key identifies ONE bid command. It is reused if the user repeats the same amount
  // after a network failure (so a retry can never buy twice) and dropped otherwise.
  const keyRef = useRef<{ amount: string; key: string } | null>(null);

  useEffect(() => {
    if (authFailed) onSignOut();
  }, [authFailed, onSignOut]);

  const { auction } = state;

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!session) return;
    setPending(true);
    setError(null);
    if (keyRef.current?.amount !== amount) {
      keyRef.current = { amount, key: crypto.randomUUID() };
    }
    try {
      const reply = await api<PlaceBidReply>('POST', `/auctions/${auctionId}/bids`, {
        token: session.token,
        body: { amount },
        headers: { 'Idempotency-Key': keyRef.current.key },
      });
      // The server confirmed (201). Only now does the bid appear; it goes through the
      // same sequence rules as live events, so the later live event is a no-op.
      dispatch({
        type: 'bid',
        accepted: {
          sequence: Number(reply.bid.bidSequence),
          bid: reply.bid,
          currentPrice: reply.auction.currentPrice,
          endsAt: reply.auction.endsAt,
          minimumNextBid: reply.auction.minimumNextBid,
        },
      });
      keyRef.current = null;
      setAmount('');
    } catch (e) {
      setError(bidErrorMessage(e));
      // A definitive answer from the server ends this command; a network error does not.
      if (!(e instanceof ApiError) || e.code !== 'NETWORK') keyRef.current = null;
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') onSignOut();
    } finally {
      setPending(false);
    }
  }

  if (joinError === 'NOT_FOUND') {
    return (
      <section className="card">
        <h1>Auction not found</h1>
        <p>
          <a href="#/">Back to auctions</a>
        </p>
      </section>
    );
  }

  if (!auction) {
    return (
      <section className="card">
        <p aria-live="polite">
          {joinError ? `Could not open the auction (${joinError}).` : 'Connecting to the auction…'}
        </p>
        <ConnectionBadge status={state.connection} />
      </section>
    );
  }

  const canBid =
    session !== null && auction.status === 'LIVE' && session.userId !== auction.sellerId;
  const isSeller = session !== null && session.userId === auction.sellerId;

  return (
    <>
      <p>
        <a href="#/">← All auctions</a>
      </p>
      <section className="card">
        <div className="title-row">
          <h1>{auction.title}</h1>
          <span className={`badge ${auction.status.toLowerCase()}`} data-testid="status">
            {auction.status}
          </span>
        </div>
        {auction.description && <p>{auction.description}</p>}
        <dl className="facts">
          <div>
            <dt>Current price</dt>
            <dd className="big" data-testid="price">
              {auction.currentPrice} <small>{auction.currency}</small>
            </dd>
          </div>
          <div>
            <dt>Next bid at least</dt>
            <dd data-testid="min-next">{auction.minimumNextBid ?? 'none possible'}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd data-testid="countdown">{countdown(auction.endsAt, now)}</dd>
          </div>
          <div>
            <dt>Bids</dt>
            <dd data-testid="bid-count">{auction.bidSequence}</dd>
          </div>
        </dl>
        <p className="status-row">
          <ConnectionBadge status={state.connection} />
          <span data-testid="participants">
            {state.participants === null ? '' : `${String(state.participants)} watching`}
          </span>
        </p>
      </section>

      <section className="card">
        <h2>Place a bid</h2>
        {canBid && (
          <form
            onSubmit={(e) => {
              void submit(e);
            }}
          >
            <label>
              Your bid ({auction.currency})
              <input
                inputMode="decimal"
                pattern="\d{1,10}(\.\d{1,2})?"
                required
                value={amount}
                placeholder={auction.minimumNextBid ?? ''}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
                data-testid="bid-input"
              />
            </label>
            {error && (
              <p role="alert" className="error" data-testid="bid-error">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={pending} data-testid="bid-submit">
              {pending ? 'Waiting for the server…' : 'Place bid'}
            </button>
            <p className="hint">Your bid is shown only after the server accepts it.</p>
          </form>
        )}
        {!session && (
          <p>
            <a href="#/login">Sign in</a> to place a bid.
          </p>
        )}
        {isSeller && <p>You are the seller of this auction.</p>}
        {session && !isSeller && auction.status !== 'LIVE' && <p>This auction is not live.</p>}
      </section>

      <section className="card">
        <h2>Bids</h2>
        {state.bids.length === 0 && <p>No bids yet.</p>}
        <ol className="bids" aria-live="polite" data-testid="bids">
          {state.bids.map((b) => (
            <li key={b.id} data-testid="bid-row">
              <span className="seq">#{b.bidSequence}</span>
              <span className="who">{b.bidderDisplayName}</span>
              <span className="amount">{b.amount}</span>
              <time dateTime={b.acceptedAt}>{new Date(b.acceptedAt).toLocaleTimeString()}</time>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function ConnectionBadge({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const label =
    status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <span className={`conn ${status}`} data-testid="connection" role="status">
      {label}
    </span>
  );
}
