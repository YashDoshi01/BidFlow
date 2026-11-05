// The state of one auction room as the browser sees it. Pure functions only (no DOM,
// no sockets), so every rule below is covered by unit tests.
//
// The server is the only authority. The browser applies:
//   * a snapshot (the full authoritative state at the time of joining), and
//   * `bid.accepted` events (or the server's own 201 reply to our bid), each carrying
//     a `sequence` (the auction's bid_sequence).
// An event is applied only if it is exactly the next one. Older = duplicate/stale,
// ignored. Further ahead = a gap: do not guess, ask the server for a fresh snapshot.
// Nothing is ever shown as accepted because the user clicked a button.

export interface BidView {
  id: string;
  auctionId: string;
  bidderId: string;
  bidderDisplayName: string;
  amount: string;
  bidSequence: string;
  acceptedAt: string;
}

export interface AuctionView {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  startingPrice: string;
  currentPrice: string;
  minimumIncrement: string;
  currency: string;
  status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
  bidSequence: string;
  highestBidId: string | null;
  minimumNextBid: string | null;
}

/** A committed bid, from a live event or from our own confirmed REST reply. */
export interface AcceptedBid {
  sequence: number;
  bid: BidView;
  currentPrice: string;
  endsAt: string;
  minimumNextBid: string | null;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface RoomState {
  connection: ConnectionStatus;
  auction: AuctionView | null;
  /** Newest first. */
  bids: BidView[];
  /** The highest sequence applied so far (0 = no bids). */
  lastSequence: number;
  participants: number | null;
  /** Events that arrived before the first snapshot; replayed once it is applied. */
  buffered: AcceptedBid[];
  /** The highest sequence seen in a gap (an event ahead of the next expected one). */
  gapTarget: number;
  /** Incremented every time a gap is detected; the hook re-joins when it changes. */
  resyncRequests: number;
}

export type RoomAction =
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'snapshot'; sequence: number; auction: AuctionView; recentBids: BidView[] }
  | { type: 'bid'; accepted: AcceptedBid }
  | { type: 'participants'; count: number };

export const MAX_BIDS_KEPT = 50;

export const initialRoomState: RoomState = {
  connection: 'connecting',
  auction: null,
  bids: [],
  lastSequence: 0,
  participants: null,
  buffered: [],
  gapTarget: 0,
  resyncRequests: 0,
};

export function needsResync(state: RoomState): boolean {
  return state.lastSequence < state.gapTarget;
}

function applyNext(state: RoomState, accepted: AcceptedBid): RoomState {
  if (state.auction === null) return state;
  return {
    ...state,
    auction: {
      ...state.auction,
      currentPrice: accepted.currentPrice,
      endsAt: accepted.endsAt,
      minimumNextBid: accepted.minimumNextBid,
      bidSequence: String(accepted.sequence),
      highestBidId: accepted.bid.id,
    },
    bids: [accepted.bid, ...state.bids].slice(0, MAX_BIDS_KEPT),
    lastSequence: accepted.sequence,
  };
}

function acceptBid(state: RoomState, accepted: AcceptedBid): RoomState {
  if (state.auction === null) {
    // Joined, snapshot not here yet: remember it rather than lose it.
    return { ...state, buffered: [...state.buffered, accepted] };
  }
  const expected = state.lastSequence + 1;
  if (accepted.sequence < expected) return state; // duplicate or stale
  if (accepted.sequence === expected) return applyNext(state, accepted);
  // A gap (or out-of-order delivery): never guess, ask for the authoritative state.
  return {
    ...state,
    gapTarget: Math.max(state.gapTarget, accepted.sequence),
    resyncRequests: state.resyncRequests + 1,
  };
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.status };

    case 'participants':
      return { ...state, participants: action.count };

    case 'bid':
      return acceptBid(state, action.accepted);

    case 'snapshot': {
      // A snapshot older than what we already applied must not move us backwards
      // (a slow reply overtaken by live events).
      if (state.auction !== null && action.sequence < state.lastSequence) return state;
      let next: RoomState = {
        ...state,
        auction: action.auction,
        bids: action.recentBids.slice(0, MAX_BIDS_KEPT),
        lastSequence: action.sequence,
        buffered: [],
      };
      const early = [...state.buffered].sort((a, b) => a.sequence - b.sequence);
      for (const accepted of early) next = acceptBid(next, accepted);
      return next;
    }
  }
}
