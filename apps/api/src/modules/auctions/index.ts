// Public surface of the auctions module. Other modules import only from here.
export { auctionRoutes } from './routes.ts';
export {
  createAuctionService,
  minimumNextBid,
  type AuctionService,
  type AuctionView,
} from './service.ts';
// Narrow write access used by the bids module's transaction (ADR-017).
export {
  activate,
  applyAcceptedBid,
  extendEnd,
  finish,
  lockAuction,
  lockNextDue,
  markEndingSoonNotified,
  type AuctionRow,
  type DueKind,
  type TransitionResult,
} from './repository.ts';
