import type { EventPublisher } from './events/publisher.ts';
import type { Db } from './db/pool.ts';
import type { Logger } from './logging/logger.ts';
import { createAuctionService, type AuctionService } from './modules/auctions/index.ts';
import { createAuthService, type AuthService } from './modules/auth/index.ts';
import { createBidService, type BidService } from './modules/bids/index.ts';

export interface Services {
  auth: AuthService;
  auctions: AuctionService;
  bids: BidService;
}

/**
 * Builds the application services once, so the HTTP routes and the WebSocket
 * gateway share the same instances (and therefore the same rules).
 */
export function createServices(
  db: Db,
  options: { sessionTtlSeconds: number; logger: Logger; publisher: EventPublisher },
): Services {
  const auth = createAuthService(db, { sessionTtlSeconds: options.sessionTtlSeconds });
  const auctions = createAuctionService(db);
  const bids = createBidService(db, auctions, {
    publisher: options.publisher,
    logger: options.logger,
  });
  return { auth, auctions, bids };
}
