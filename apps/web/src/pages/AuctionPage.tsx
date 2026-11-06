import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { Countdown } from '../components/Countdown.tsx';
import { markNotificationsStale } from '../hooks/useNotifications.ts';
import { useOnline } from '../hooks/useOnline.ts';
import { myBidStatus, type MyBidStatus } from '../lib/bidStatus.ts';
import { useAuctionRoom } from '../room/useAuctionRoom.ts';
import { MAX_BIDS_KEPT, type BidView, type ConnectionStatus } from '../room/roomState.ts';
import type { Session } from '../session.ts';

interface PlaceBidReply {
  bid: BidView;
  auction: {
    currentPrice: string;
    bidSequence: string;
    eventSequence: string;
    endsAt: string;
    minimumNextBid: string | null;
  };
}

function bidErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong';
  switch (error.code) {
    case 'BID_TOO_LOW':
      return `Rejected: too low. The minimum bid is ${error.data?.['minimumAcceptableBid'] ?? 'higher'}.`;
    case 'AUCTION_ENDED':
      return 'Rejected: this auction has ended.';
    case 'AUCTION_NOT_LIVE':
      return 'Rejected: this auction is not accepting bids.';
    case 'BIDDER_IS_SELLER':
      return 'Rejected: you cannot bid on your own auction.';
    case 'UNAUTHENTICATED':
      return 'Your session has expired. Please sign in again.';
    case 'NETWORK':
      return 'Network problem: we do not know whether the bid arrived. You can press the button again: the same request is safe to repeat.';
    case 'VALIDATION_FAILED':
      return 'Rejected: enter an amount like 125.50.';
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
  const { state, dispatch, authFailed, joinError, refresh } = useAuctionRoom(
    auctionId,
    session?.token,
  );
  const online = useOnline();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The key identifies ONE bid command. It is reused if the user repeats the same amount
  // after a network failure (so a retry can never buy twice) and dropped otherwise.
  const keyRef = useRef<{ amount: string; key: string } | null>(null);

  useEffect(() => {
    if (authFailed) onSignOut();
  }, [authFailed, onSignOut]);

  const { auction } = state;
  const mine: MyBidStatus = auction
    ? myBidStatus(auction, state.bids, session?.userId)
    : { kind: 'none' };

  // When my standing changes because of something that happened in the room, a notification row
  // was written on the server in the same transaction. Ask for the list again (REST, not pushed).
  const lastKind = useRef<MyBidStatus['kind']>('none');
  useEffect(() => {
    if (
      lastKind.current !== mine.kind &&
      (mine.kind === 'outbid' || mine.kind === 'won' || mine.kind === 'lost')
    ) {
      markNotificationsStale();
    }
    lastKind.current = mine.kind;
  }, [mine.kind]);

  // The auction ended while we watched: the seller and every bidder got a notification row in the
  // same transaction. (A page that opens an already-ended auction does not need to ask again.)
  const lastStatus = useRef<string | null>(null);
  const status = auction?.status ?? null;
  useEffect(() => {
    if (lastStatus.current !== null && lastStatus.current !== 'ENDED' && status === 'ENDED') {
      markNotificationsStale();
    }
    lastStatus.current = status;
  }, [status]);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!session) return;
    setPending(true);
    setError(null);
    setAccepted(null);
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
          // The live events are ordered by the EVENT sequence, so the confirmed reply is too.
          sequence: Number(reply.auction.eventSequence),
          bid: reply.bid,
          currentPrice: reply.auction.currentPrice,
          endsAt: reply.auction.endsAt,
          minimumNextBid: reply.auction.minimumNextBid,
        },
      });
      setAccepted(`Accepted: your bid of ${reply.bid.amount} is now the highest.`);
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
        <p>It may not exist, or it may be a draft that is not yours.</p>
        <p>
          <a href="#/">Back to auctions</a>
        </p>
      </section>
    );
  }

  if (!auction) {
    return (
      <section className="card">
        <p aria-live="polite" data-testid="room-loading">
          {joinError ? `Could not open the auction (${joinError}).` : 'Connecting to the auction…'}
        </p>
        <ConnectionBadge status={state.connection} />
        {(joinError !== null || state.connection === 'disconnected') && (
          <p>
            <button type="button" onClick={refresh} data-testid="refresh">
              Try again
            </button>
          </p>
        )}
      </section>
    );
  }

  const canBid =
    session !== null && auction.status === 'LIVE' && session.userId !== auction.sellerId;
  const isSeller = session !== null && session.userId === auction.sellerId;
  const stale = state.connection !== 'connected';
  const winnerBid = auction.winningBidId
    ? state.bids.find((b) => b.id === auction.winningBidId)
    : undefined;

  return (
    <>
      <p>
        <a href="#/">← All auctions</a>
      </p>
      {stale && (
        <div role="status" className="warn-box" data-testid="stale-banner">
          <p>
            {state.connection === 'connecting' ? 'Connecting…' : 'Live updates are paused.'} The
            price and time below were correct at event #{auction.eventSequence}, and may be out of
            date.
            {online ? '' : ' You are offline.'} The server still checks every bid against the real
            state.
          </p>
          <button type="button" onClick={refresh} data-testid="refresh">
            Refresh from the server
          </button>
        </div>
      )}
      <section className="card">
        <div className="title-row">
          <h1>{auction.title}</h1>
          <span className={`badge ${auction.status.toLowerCase()}`} data-testid="status">
            {auction.status}
          </span>
        </div>
        {auction.description && <p className="description">{auction.description}</p>}
        <dl className="facts">
          <div>
            <dt>{auction.status === 'ENDED' ? 'Final price' : 'Current price'}</dt>
            <dd className="big" data-testid="price">
              {auction.currentPrice} <small>{auction.currency}</small>
            </dd>
          </div>
          <div>
            <dt>Next bid at least</dt>
            <dd data-testid="min-next">
              {auction.status === 'ENDED' ? '—' : (auction.minimumNextBid ?? 'none possible')}
            </dd>
          </div>
          <Countdown auction={auction} />
          <div>
            <dt>Bids</dt>
            <dd data-testid="bid-count">{auction.bidSequence}</dd>
          </div>
        </dl>
        <p className="hint" data-testid="schedule">
          Started {new Date(auction.startsAt).toLocaleString()} · ends{' '}
          <span data-testid="ends-at">{new Date(auction.endsAt).toLocaleString()}</span>
          {auction.extensionCount > 0 && (
            <span data-testid="extensions">
              {' '}
              · extended {String(auction.extensionCount)}× by late bids
            </span>
          )}
        </p>
        <p className="status-row">
          <ConnectionBadge status={state.connection} />
          <span data-testid="participants">
            {state.participants === null ? '' : `${String(state.participants)} watching`}
          </span>
          {!stale && (
            <button type="button" className="link" onClick={refresh} data-testid="refresh">
              Refresh
            </button>
          )}
        </p>
      </section>

      <MyStatus status={mine} currency={auction.currency} />

      {auction.status === 'ENDED' && (
        <section className="card result" data-testid="result" aria-live="polite">
          <h2>Auction ended</h2>
          {auction.winningBidId === null ? (
            <p>It ended without any bids.</p>
          ) : (
            <p>
              Won by <strong>{winnerBid?.bidderDisplayName ?? 'a bidder'}</strong> at{' '}
              <strong>
                {auction.currentPrice} {auction.currency}
              </strong>
              . This is a demo: no payment is taken.
            </p>
          )}
        </section>
      )}

      {auction.status !== 'ENDED' && (
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
              <div aria-live="polite">
                {error && (
                  <p role="alert" className="error" data-testid="bid-error">
                    {error}
                  </p>
                )}
                {accepted && (
                  <p className="ok" data-testid="bid-accepted">
                    {accepted}
                  </p>
                )}
              </div>
              <button type="submit" className="primary" disabled={pending} data-testid="bid-submit">
                {pending ? 'Waiting for the server…' : 'Place bid'}
              </button>
              <p className="hint">
                Your bid is shown only after the server accepts it. A bid in the last two minutes
                extends the auction.
              </p>
            </form>
          )}
          {!session && (
            <p>
              <a href="#/login">Sign in</a> to place a bid.
            </p>
          )}
          {isSeller && (
            <p>
              You are the seller of this auction. <a href="#/sell">Your auctions</a>
            </p>
          )}
          {session && !isSeller && auction.status !== 'LIVE' && (
            <p>
              {auction.status === 'SCHEDULED'
                ? 'This auction has not started yet.'
                : 'This auction is not live.'}
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Bids</h2>
        {state.bids.length === 0 && <p data-testid="no-bids">No bids yet.</p>}
        <ol className="bids" aria-live="polite" data-testid="bids">
          {state.bids.map((b) => (
            <li
              key={b.id}
              data-testid="bid-row"
              className={b.bidderId === session?.userId ? 'mine' : ''}
            >
              <span className="seq">#{b.bidSequence}</span>
              <span className="who">
                {b.bidderDisplayName}
                {b.bidderId === session?.userId && <em> (you)</em>}
              </span>
              <span className="amount">{b.amount}</span>
              <time dateTime={b.acceptedAt}>{new Date(b.acceptedAt).toLocaleTimeString()}</time>
            </li>
          ))}
        </ol>
        {Number(auction.bidSequence) > state.bids.length && (
          <p className="hint" data-testid="bids-truncated">
            Showing the latest {String(Math.min(state.bids.length, MAX_BIDS_KEPT))} of{' '}
            {auction.bidSequence} bids.
          </p>
        )}
      </section>
    </>
  );
}

function MyStatus({ status, currency }: { status: MyBidStatus; currency: string }) {
  if (status.kind === 'none') return null;
  const c = ` ${currency}`;
  const view: { cls: string; text: string } = (() => {
    switch (status.kind) {
      case 'leading':
        return { cls: 'ok', text: `You are the highest bidder at ${status.amount}${c}.` };
      case 'outbid':
        return {
          cls: 'bad',
          text: `You were outbid. Your best bid was ${status.yourBest}${c}; the price is now ${status.currentPrice}${c}.`,
        };
      case 'won':
        return { cls: 'ok', text: `You won this auction at ${status.amount}${c}.` };
      case 'lost':
        return {
          cls: 'bad',
          text: `You did not win. Your best bid was ${status.yourBest}${c}; it ended at ${status.finalPrice}${c}.`,
        };
    }
  })();
  return (
    <p
      role="status"
      className={`my-status ${view.cls}`}
      data-testid="my-status"
      data-kind={status.kind}
    >
      {view.text}
    </p>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label =
    status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <span className={`conn ${status}`} data-testid="connection" role="status">
      {label}
    </span>
  );
}
