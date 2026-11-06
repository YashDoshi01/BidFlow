import type { AuctionView, BidView } from '../room/roomState.ts';

/**
 * Where the signed-in user stands in this auction, derived ONLY from server facts already in
 * the room state: the auction's `highestBidId` / `winningBidId` and the recent bids (newest
 * first, at most MAX_BIDS_KEPT). Nothing here is a guess about a bid that is still in flight.
 *
 * Limit: if the user's bids are all older than the window kept in the room state, they are not
 * seen, and the status is `none`. The leading bid is always the newest, so `leading` and
 * `won` never depend on the window.
 */
export type MyBidStatus =
  | { kind: 'none' }
  | { kind: 'leading'; amount: string }
  | { kind: 'outbid'; yourBest: string; currentPrice: string }
  | { kind: 'won'; amount: string }
  | { kind: 'lost'; yourBest: string; finalPrice: string };

export function myBidStatus(
  auction: Pick<AuctionView, 'status' | 'highestBidId' | 'winningBidId' | 'currentPrice'>,
  bids: readonly BidView[],
  userId: string | undefined,
): MyBidStatus {
  if (userId === undefined) return { kind: 'none' };
  // Newest first, and each accepted bid is higher than the last: the first of mine is my best.
  const mine = bids.find((b) => b.bidderId === userId);
  if (auction.status === 'ENDED') {
    if (auction.winningBidId === null) return { kind: 'none' };
    const winner = bids.find((b) => b.id === auction.winningBidId);
    if (winner?.bidderId === userId) return { kind: 'won', amount: winner.amount };
    if (mine) return { kind: 'lost', yourBest: mine.amount, finalPrice: auction.currentPrice };
    return { kind: 'none' };
  }
  if (!mine) return { kind: 'none' };
  const leader =
    auction.highestBidId === null ? undefined : bids.find((b) => b.id === auction.highestBidId);
  if (leader?.bidderId === userId) return { kind: 'leading', amount: leader.amount };
  return { kind: 'outbid', yourBest: mine.amount, currentPrice: auction.currentPrice };
}
