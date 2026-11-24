// Small presentational pieces shared by the pages. No state, no data fetching.

import type { AuctionView } from '../room/roomState.ts';

/** A stable number 0..7 from an id, so the same auction always gets the same cover colours. */
export function paletteIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 8;
}

/** First letter of a name, upper case ("" when there is none). */
export function initial(name: string): string {
  return (name.trim()[0] ?? '').toUpperCase();
}

/**
 * Auctions have no photos (nothing is uploaded in this project), so each one gets a generated cover:
 * a gradient chosen from its id with the first letter of its title. Colours are classes, not inline
 * styles, because the production CSP allows only stylesheets from the site itself.
 */
export function Cover({
  auction,
  size = 'card',
}: {
  auction: Pick<AuctionView, 'id' | 'title'>;
  size?: 'card' | 'hero' | 'thumb';
}) {
  return (
    <div
      className={`cover cover-${size} cover-p${String(paletteIndex(auction.id))}`}
      aria-hidden="true"
    >
      <span className="cover-letter">{initial(auction.title)}</span>
    </div>
  );
}

/** The status exactly as the server sends it (tests and screen readers read the text). */
export function StatusBadge({
  status,
  testId,
}: {
  status: AuctionView['status'];
  testId?: string;
}) {
  return (
    <span className={`badge ${status.toLowerCase()}`} data-testid={testId}>
      {status}
    </span>
  );
}
