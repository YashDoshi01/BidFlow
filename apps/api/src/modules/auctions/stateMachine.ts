export const AUCTION_STATUSES = ['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED'] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];

// Product rule 9. The same table is enforced a second time by the trigger in
// db/migrations/0002_auctions.sql; keep them identical.
const TRANSITIONS: Record<AuctionStatus, readonly AuctionStatus[]> = {
  DRAFT: ['SCHEDULED', 'LIVE', 'CANCELLED'],
  SCHEDULED: ['LIVE', 'CANCELLED'],
  LIVE: ['ENDED', 'CANCELLED'],
  ENDED: [],
  CANCELLED: [],
};

export function canTransition(from: AuctionStatus, to: AuctionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/** Product rule 14. Returns an error message, or undefined if the window is valid. */
export function validateSchedule(startsAt: Date, endsAt: Date): string | undefined {
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration < MIN_DURATION_MS) return 'endsAt must be at least 1 minute after startsAt';
  if (duration > MAX_DURATION_MS) return 'endsAt must be at most 30 days after startsAt';
  return undefined;
}

/**
 * Where a publish leads. `now` must be the database clock (never the app
 * clock). Returns undefined if the auction has already ended.
 */
export function publishTarget(startsAt: Date, endsAt: Date, now: Date): AuctionStatus | undefined {
  if (endsAt.getTime() <= now.getTime()) return undefined;
  return startsAt.getTime() > now.getTime() ? 'SCHEDULED' : 'LIVE';
}
