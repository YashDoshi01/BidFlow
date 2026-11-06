// Turns a notification row from `GET /notifications` into text. The rows come from the server;
// their `data` is a snapshot written at the time (see docs/API.md). Fields are read defensively
// because `data` is JSON the client did not write: a missing field never throws.

export type NotificationType =
  'outbid' | 'ending_soon' | 'auction_won' | 'auction_lost' | 'auction_ended';

export interface NotificationView {
  id: string;
  auctionId: string;
  type: NotificationType;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationText {
  title: string;
  body: string;
  href: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function describeNotification(n: NotificationView): NotificationText {
  const title = str(n.data['auctionTitle']) ?? 'an auction';
  const currency = str(n.data['currency']) ?? '';
  const money = (v: unknown): string => {
    const s = str(v);
    return s === undefined ? '?' : `${s}${currency ? ` ${currency}` : ''}`;
  };
  const href = `#/auction/${n.auctionId}`;
  switch (n.type) {
    case 'outbid':
      return {
        title: `You were outbid on ${title}`,
        body: `Your ${str(n.data['yourAmount']) ?? '?'} was beaten by ${str(n.data['currentPrice']) ?? '?'}. The next bid must be at least ${str(n.data['minimumNextBid']) ?? '?'}.`,
        href,
      };
    case 'ending_soon':
      return {
        title: `${title} is ending soon`,
        body: `Current price ${str(n.data['currentPrice']) ?? '?'}. It ends at ${formatTime(str(n.data['endsAt']))} unless a late bid extends it.`,
        href,
      };
    case 'auction_won':
      return {
        title: `You won ${title}`,
        body: `Final price ${money(n.data['finalPrice'])}. This is a demo: no payment is taken.`,
        href,
      };
    case 'auction_lost':
      return {
        title: `You did not win ${title}`,
        body: `It ended at ${money(n.data['finalPrice'])}.`,
        href,
      };
    case 'auction_ended': {
      const sold = n.data['sold'] === true;
      const winner = str(n.data['winnerDisplayName']);
      return {
        title: `Your auction ${title} has ended`,
        body: sold
          ? `Won by ${winner ?? 'a bidder'} at ${money(n.data['finalPrice'])}.`
          : 'It ended without any bids.',
        href,
      };
    }
  }
}

function formatTime(iso: string | undefined): string {
  if (iso === undefined) return 'the scheduled time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'the scheduled time' : d.toLocaleTimeString();
}

/** Narrow check used when parsing the REST reply; rows that do not look right are dropped, not rendered. */
export function parseNotification(raw: unknown): NotificationView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const types: readonly string[] = [
    'outbid',
    'ending_soon',
    'auction_won',
    'auction_lost',
    'auction_ended',
  ];
  if (
    typeof r['id'] !== 'string' ||
    typeof r['auctionId'] !== 'string' ||
    typeof r['type'] !== 'string' ||
    !types.includes(r['type']) ||
    typeof r['createdAt'] !== 'string' ||
    (r['readAt'] !== null && typeof r['readAt'] !== 'string') ||
    typeof r['data'] !== 'object' ||
    r['data'] === null
  ) {
    return null;
  }
  return {
    id: r['id'],
    auctionId: r['auctionId'],
    type: r['type'] as NotificationType,
    data: r['data'] as Record<string, unknown>,
    createdAt: r['createdAt'],
    readAt: r['readAt'],
  };
}
