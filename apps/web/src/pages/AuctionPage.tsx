import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import { Countdown } from '../components/Countdown.tsx';
import {
  IconAlert,
  IconArrowLeft,
  IconClock,
  IconRefresh,
  IconTrophy,
} from '../components/Icons.tsx';
import { Cover, StatusBadge, initial } from '../components/ui.tsx';
import { quickBids } from '../lib/money.ts';
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
      <section className="card empty-state">
        <h1>Auction not found</h1>
        <p>It may not exist, or it may be a draft that is not yours.</p>
        <p>
          <a className="button" href="#/">
            Back to auctions
          </a>
        </p>
      </section>
    );
  }

  if (!auction) {
    return (
      <section className="card empty-state">
        <div className="spinner" aria-hidden="true" />
        <p aria-live="polite" data-testid="room-loading">
          {joinError ? `Could not open the auction (${joinError}).` : 'Connecting to the auction…'}
        </p>
        <ConnectionBadge status={state.connection} />
        {(joinError !== null || state.connection === 'disconnected') && (
          <p>
            <button type="button" className="button" onClick={refresh} data-testid="refresh">
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

  const suggestions = canBid ? quickBids(auction.minimumNextBid, auction.minimumIncrement) : [];

  return (
    <>
      <p className="back-row">
        <a href="#/" className="back-link">
          <IconArrowLeft /> All auctions
        </a>
      </p>
      {stale && (
        <div role="status" className="warn-box" data-testid="stale-banner">
          <IconAlert />
          <p>
            {state.connection === 'connecting' ? 'Connecting…' : 'Live updates are paused.'} The
            price and time below were correct at event #{auction.eventSequence}, and may be out of
            date.
            {online ? '' : ' You are offline.'} The server still checks every bid against the real
            state.
          </p>
          <button type="button" className="button small" onClick={refresh} data-testid="refresh">
            Refresh from the server
          </button>
        </div>
      )}
      <div className="room">
        <section className="card room-head">
          <Cover auction={auction} size="hero" />
          <div className="room-head-body">
            <div className="title-row">
              <h1>{auction.title}</h1>
              <StatusBadge status={auction.status} testId="status" />
            </div>
            {auction.description && <p className="description">{auction.description}</p>}
            <p className="hint schedule" data-testid="schedule">
              <IconClock /> Started {new Date(auction.startsAt).toLocaleString()} · ends{' '}
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
              <span data-testid="participants" className="participants">
                {state.participants === null ? '' : `${String(state.participants)} watching`}
              </span>
              {!stale && (
                <button type="button" className="link" onClick={refresh} data-testid="refresh">
                  <IconRefresh /> Refresh
                </button>
              )}
            </p>
          </div>
        </section>

        <aside className="room-side" aria-label="Price and bidding">
          <section className="card bid-panel">
            <dl className="facts">
              <div className="fact-price">
                <dt>{auction.status === 'ENDED' ? 'Final price' : 'Current price'}</dt>
                <dd key={auction.currentPrice} className="big flash" data-testid="price">
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

            <MyStatus status={mine} currency={auction.currency} />

            {auction.status === 'ENDED' && (
              <div className="result" data-testid="result" aria-live="polite">
                <IconTrophy />
                <div>
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
                </div>
              </div>
            )}

            {auction.status !== 'ENDED' && (
              <div className="bid-box">
                <h2>Place a bid</h2>
                {canBid && (
                  <form
                    onSubmit={(e) => {
                      void submit(e);
                    }}
                  >
                    <label>
                      Your bid ({auction.currency})
                      <span className="money-input">
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
                        <span className="money-suffix" aria-hidden="true">
                          {auction.currency}
                        </span>
                      </span>
                    </label>
                    {suggestions.length > 0 && (
                      <div className="chips" role="group" aria-label="Quick amounts">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={`chip${amount === s ? ' selected' : ''}`}
                            onClick={() => {
                              setAmount(s);
                            }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
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
                    <button
                      type="submit"
                      className="button primary block"
                      disabled={pending}
                      data-testid="bid-submit"
                    >
                      {pending ? 'Waiting for the server…' : 'Place bid'}
                    </button>
                    <p className="hint">
                      Your bid is shown only after the server accepts it. A bid in the last two
                      minutes extends the auction.
                    </p>
                  </form>
                )}
                {!session && (
                  <p>
                    <a className="button primary block" href="#/login">
                      Sign in
                    </a>{' '}
                    <span className="hint">to place a bid.</span>
                  </p>
                )}
                {isSeller && (
                  <p className="note">
                    You are the seller of this auction. <a href="#/sell">Your auctions</a>
                  </p>
                )}
                {session && !isSeller && auction.status !== 'LIVE' && (
                  <p className="note">
                    {auction.status === 'SCHEDULED'
                      ? 'This auction has not started yet.'
                      : 'This auction is not live.'}
                  </p>
                )}
              </div>
            )}
          </section>
        </aside>

        <section className="card room-bids">
          <div className="section-head">
            <h2>Bids</h2>
            <span className="bid-pill">{auction.bidSequence}</span>
          </div>
          {state.bids.length === 0 && (
            <p className="empty-inline" data-testid="no-bids">
              No bids yet.
            </p>
          )}
          <ol className="bids" aria-live="polite" data-testid="bids">
            {state.bids.map((b, i) => (
              <li
                key={b.id}
                data-testid="bid-row"
                className={`${b.bidderId === session?.userId ? 'mine' : ''}${i === 0 ? ' top' : ''}`}
              >
                <span className="seq">#{b.bidSequence}</span>
                <span className="who" data-initial={initial(b.bidderDisplayName)}>
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
      </div>
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
      <span className="conn-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
