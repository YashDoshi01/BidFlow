// Runtime checks for what arrives over the socket. Types vanish at runtime, and a
// client must not trust the wire. Anything malformed is dropped (returns null).
import type { AcceptedBid, AuctionView, BidView } from './roomState.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const money = (v: unknown): v is string => str(v) && /^\d{1,10}\.\d{2}$/.test(v);
const seqString = (v: unknown): v is string => str(v) && /^\d{1,18}$/.test(v);

function bidView(v: unknown): BidView | null {
  if (!isRec(v)) return null;
  if (
    !str(v['id']) ||
    !str(v['auctionId']) ||
    !str(v['bidderId']) ||
    !str(v['bidderDisplayName']) ||
    !money(v['amount']) ||
    !seqString(v['bidSequence']) ||
    !str(v['acceptedAt'])
  ) {
    return null;
  }
  return {
    id: v['id'],
    auctionId: v['auctionId'],
    bidderId: v['bidderId'],
    bidderDisplayName: v['bidderDisplayName'],
    amount: v['amount'],
    bidSequence: v['bidSequence'],
    acceptedAt: v['acceptedAt'],
  };
}

function auctionView(v: unknown): AuctionView | null {
  if (!isRec(v)) return null;
  const status = v['status'];
  if (
    !str(v['id']) ||
    !str(v['sellerId']) ||
    !str(v['title']) ||
    !str(v['description']) ||
    !money(v['startingPrice']) ||
    !money(v['currentPrice']) ||
    !money(v['minimumIncrement']) ||
    !str(v['currency']) ||
    !(
      status === 'DRAFT' ||
      status === 'SCHEDULED' ||
      status === 'LIVE' ||
      status === 'ENDED' ||
      status === 'CANCELLED'
    ) ||
    !str(v['startsAt']) ||
    !str(v['endsAt']) ||
    !str(v['createdAt']) ||
    !str(v['updatedAt']) ||
    !seqString(v['bidSequence']) ||
    !(v['highestBidId'] === null || str(v['highestBidId'])) ||
    !(v['minimumNextBid'] === null || money(v['minimumNextBid']))
  ) {
    return null;
  }
  return {
    id: v['id'],
    sellerId: v['sellerId'],
    title: v['title'],
    description: v['description'],
    startingPrice: v['startingPrice'],
    currentPrice: v['currentPrice'],
    minimumIncrement: v['minimumIncrement'],
    currency: v['currency'],
    status,
    startsAt: v['startsAt'],
    endsAt: v['endsAt'],
    createdAt: v['createdAt'],
    updatedAt: v['updatedAt'],
    bidSequence: v['bidSequence'],
    highestBidId: v['highestBidId'],
    minimumNextBid: v['minimumNextBid'],
  };
}

export function parseSnapshot(
  payload: unknown,
): { sequence: number; auction: AuctionView; recentBids: BidView[] } | null {
  if (!isRec(payload) || payload['eventType'] !== 'auction.snapshot') return null;
  const sequence = payload['sequence'];
  const data = payload['data'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || !isRec(data)) return null;
  const auction = auctionView(data['auction']);
  const rawBids = data['recentBids'];
  if (!auction || !Array.isArray(rawBids)) return null;
  const recentBids: BidView[] = [];
  for (const raw of rawBids) {
    const parsed = bidView(raw);
    if (!parsed) return null;
    recentBids.push(parsed);
  }
  return { sequence, auction, recentBids };
}

export function parseBidAccepted(payload: unknown): AcceptedBid | null {
  if (!isRec(payload) || payload['eventType'] !== 'bid.accepted') return null;
  const sequence = payload['sequence'];
  const data = payload['data'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || !isRec(data)) return null;
  const bid = bidView({
    id: data['bidId'],
    auctionId: payload['auctionId'],
    bidderId: data['bidderId'],
    bidderDisplayName: data['bidderDisplayName'],
    amount: data['amount'],
    bidSequence: String(sequence),
    acceptedAt: data['acceptedAt'],
  });
  if (
    !bid ||
    !money(data['currentPrice']) ||
    !str(data['endsAt']) ||
    !(data['minimumNextBid'] === null || money(data['minimumNextBid']))
  ) {
    return null;
  }
  return {
    sequence,
    bid,
    currentPrice: data['currentPrice'],
    endsAt: data['endsAt'],
    minimumNextBid: data['minimumNextBid'],
  };
}

export function parseParticipantCount(payload: unknown): number | null {
  if (!isRec(payload) || payload['eventType'] !== 'participant.count') return null;
  const data = payload['data'];
  if (!isRec(data)) return null;
  const count = data['count'];
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}
