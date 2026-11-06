// The state of one auction room as the browser sees it. Pure functions only (no DOM,
// no sockets), so every rule below is covered by unit tests.
//
// The server is the only authority. The browser applies:
//   * a snapshot (the full authoritative state at the time of joining), and
//   * `bid.accepted` events (or the server's own 201 reply to our bid), each carrying
//     a `sequence` (the auction's auction_event_sequence: the position of the event among ALL
//     durable events of the auction; the bid's own position is `bidSequence`, a different counter).
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
  /** Number of accepted bids. */
  bidSequence: string;
  /** Number of durable events: the `sequence` of the last event applied. */
  eventSequence: string;
  highestBidId: string | null;
  /** Anti-sniping extensions used so far. */
  extensionCount: number;
  endedAt: string | null;
  winningBidId: string | null;
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

/**
 * The lifecycle events (Phase 6). They share the sequence with bids, so they are applied by the same
 * rule: only the next one, duplicates ignored, a gap means "ask for a snapshot".
 */
export type LifecycleEvent =
  | { kind: 'started'; sequence: number; endsAt: string }
  | { kind: 'extended'; sequence: number; endsAt: string; extensionCount: number }
  | {
      kind: 'ended';
      sequence: number;
      endedAt: string;
      winningBidId: string | null;
      finalPrice: string;
    };

type SequencedEvent = AcceptedBid | LifecycleEvent;

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
  buffered: SequencedEvent[];
  /** The highest sequence seen in a gap (an event ahead of the next expected one). */
  gapTarget: number;
  /** Incremented every time a gap is detected; the hook re-joins when it changes. */
  resyncRequests: number;
}

export type RoomAction =
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'snapshot'; sequence: number; auction: AuctionView; recentBids: BidView[] }
  | { type: 'bid'; accepted: AcceptedBid }
  | { type: 'lifecycle'; event: LifecycleEvent }
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

function applyLifecycle(state: RoomState, event: LifecycleEvent): RoomState {
  if (state.auction === null) return state;
  const sequence = String(event.sequence);
  switch (event.kind) {
    case 'started':
      return {
        ...state,
        auction: {
          ...state.auction,
          status: 'LIVE',
          endsAt: event.endsAt,
          eventSequence: sequence,
        },
        lastSequence: event.sequence,
      };
    case 'extended':
      return {
        ...state,
        auction: {
          ...state.auction,
          endsAt: event.endsAt,
          extensionCount: event.extensionCount,
          eventSequence: sequence,
        },
        lastSequence: event.sequence,
      };
    case 'ended':
      return {
        ...state,
        auction: {
          ...state.auction,
          status: 'ENDED',
          endedAt: event.endedAt,
          winningBidId: event.winningBidId,
          currentPrice: event.finalPrice,
          minimumNextBid: null,
          eventSequence: sequence,
        },
        lastSequence: event.sequence,
      };
  }
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
      bidSequence: accepted.bid.bidSequence,
      eventSequence: String(accepted.sequence),
      highestBidId: accepted.bid.id,
    },
    bids: [accepted.bid, ...state.bids].slice(0, MAX_BIDS_KEPT),
    lastSequence: accepted.sequence,
  };
}

function acceptEvent(state: RoomState, event: SequencedEvent): RoomState {
  if (state.auction === null) {
    // Joined, snapshot not here yet: remember it rather than lose it.
    return { ...state, buffered: [...state.buffered, event] };
  }
  const expected = state.lastSequence + 1;
  if (event.sequence < expected) return state; // duplicate or stale
  if (event.sequence === expected) {
    return 'kind' in event ? applyLifecycle(state, event) : applyNext(state, event);
  }
  // A gap (or out-of-order delivery): never guess, ask for the authoritative state.
  return {
    ...state,
    gapTarget: Math.max(state.gapTarget, event.sequence),
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
      return acceptEvent(state, action.accepted);

    case 'lifecycle':
      return acceptEvent(state, action.event);

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
      for (const event of early) next = acceptEvent(next, event);
      return next;
    }
  }
}
