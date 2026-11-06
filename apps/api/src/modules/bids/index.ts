// Public surface of the bids module. Other modules import only from here.
export { bidRoutes } from './routes.ts';
export {
  createBidService,
  PLACE_BID_OPERATION,
  type BidService,
  type BidTestHooks,
  type BidView,
} from './service.ts';
export { purgeExpired as purgeExpiredIdempotencyRecords } from './idempotency.ts';
// Read access used by the lifecycle worker when an auction ends (winner, bidders to notify).
export { distinctBidderIds, findBid, type BidRow } from './repository.ts';
