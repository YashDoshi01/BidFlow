import type { Db } from './db/pool.ts';
import { createAuctionService, type AuctionService } from './modules/auctions/index.ts';
import { createAuthService, type AuthService } from './modules/auth/index.ts';
import { createBidService, type BidService } from './modules/bids/index.ts';
import {
  createNotificationService,
  type NotificationService,
} from './modules/notifications/index.ts';

export interface Services {
  auth: AuthService;
  auctions: AuctionService;
  bids: BidService;
  notifications: NotificationService;
}

/**
 * Builds the application services once, so the HTTP routes and the WebSocket
 * gateway share the same instances (and therefore the same rules).
 */
export function createServices(db: Db, options: { sessionTtlSeconds: number }): Services {
  const auth = createAuthService(db, { sessionTtlSeconds: options.sessionTtlSeconds });
  const auctions = createAuctionService(db);
  const bids = createBidService(db, auctions);
  const notifications = createNotificationService(db);
  return { auth, auctions, bids, notifications };
}
