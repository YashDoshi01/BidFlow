import type { AuctionView } from '../room/roomState.ts';

/** "2d 3h", "1h 05m", "4m 07s", "7s". `ms` must be positive. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  if (d > 0) return `${String(d)}d ${String(h)}h`;
  if (h > 0) return `${String(h)}h ${two(m)}m`;
  if (m > 0) return `${String(m)}m ${two(s)}s`;
  return `${String(s)}s`;
}

export interface ClockLabel {
  label: string;
  text: string;
  /** True when the end time has passed on the (estimated) server clock but the server has not said "ended" yet. */
  waitingForServer: boolean;
}

/**
 * What to show next to the auction. The status (a fact from the server) wins over the time:
 * a countdown that reaches zero while the status is still LIVE says "Ending…", NOT "Ended",
 * because only the server's `auction.ended` (or a snapshot) makes it ended.
 */
export function describeClock(
  auction: Pick<AuctionView, 'status' | 'startsAt' | 'endsAt' | 'endedAt'>,
  serverNowMs: number,
): ClockLabel {
  switch (auction.status) {
    case 'ENDED':
      return {
        label: 'Ended',
        text: auction.endedAt ? new Date(auction.endedAt).toLocaleString() : 'ended',
        waitingForServer: false,
      };
    case 'CANCELLED':
      return { label: 'Status', text: 'cancelled', waitingForServer: false };
    case 'DRAFT':
      return { label: 'Status', text: 'not published', waitingForServer: false };
    case 'SCHEDULED': {
      const ms = new Date(auction.startsAt).getTime() - serverNowMs;
      return {
        label: 'Starts in',
        text: ms > 0 ? formatRemaining(ms) : 'starting…',
        waitingForServer: ms <= 0,
      };
    }
    case 'LIVE': {
      const ms = new Date(auction.endsAt).getTime() - serverNowMs;
      return {
        label: 'Time left',
        text: ms > 0 ? formatRemaining(ms) : 'ending…',
        waitingForServer: ms <= 0,
      };
    }
  }
}
