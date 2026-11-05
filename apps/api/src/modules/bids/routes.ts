import { Router } from 'express';
import { parseInput } from '../../http/validate.ts';
import {
  getAuth,
  mustGetAuth,
  optionalAuth,
  requireAuth,
  type AuthService,
} from '../auth/index.ts';
import { bidHistoryQuerySchema, idempotencyKeySchema, placeBidSchema } from './schemas.ts';
import type { BidService } from './service.ts';
import { z } from 'zod';

const auctionId = z.uuid();

export function bidRoutes(bids: BidService, auth: AuthService): Router {
  const router = Router();

  // The tenant (bidder) is the authenticated user; the body carries only the amount.
  router.post('/auctions/:auctionId/bids', requireAuth(auth), async (req, res) => {
    const id = parseInput(auctionId, req.params['auctionId']);
    const input = parseInput(placeBidSchema, req.body);
    const key = parseInput(idempotencyKeySchema, req.get('Idempotency-Key'), 'Idempotency-Key');
    const result = await bids.place({
      auctionId: id,
      userId: mustGetAuth(res).userId,
      idempotencyKey: key,
      input,
    });
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(result.status).json(result.body);
  });

  router.get('/auctions/:auctionId/bids', optionalAuth(auth), async (req, res) => {
    const id = parseInput(auctionId, req.params['auctionId']);
    const query = parseInput(bidHistoryQuerySchema, req.query);
    res.status(200).json(await bids.history(id, getAuth(res)?.userId, query));
  });

  return router;
}
