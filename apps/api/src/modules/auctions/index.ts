// Public surface of the auctions module. Other modules import only from here.
export { auctionRoutes } from './routes.ts';
export { createAuctionService, type AuctionService, type AuctionView } from './service.ts';
