import { Router } from 'express';
import { parseInput } from '../../http/validate.ts';
import {
  getAuth,
  mustGetAuth,
  optionalAuth,
  requireAuth,
  type AuthService,
} from '../auth/index.ts';
import {
  auctionIdSchema,
  createAuctionSchema,
  listQuerySchema,
  updateAuctionSchema,
} from './schemas.ts';
import type { AuctionService } from './service.ts';

export function auctionRoutes(auctions: AuctionService, auth: AuthService): Router {
  const router = Router();
  const required = requireAuth(auth);
  const optional = optionalAuth(auth);

  router.post('/auctions', required, async (req, res) => {
    const input = parseInput(createAuctionSchema, req.body);
    const auction = await auctions.create(mustGetAuth(res).userId, input);
    res.status(201).json({ auction });
  });

  router.get('/auctions', optional, async (req, res) => {
    const query = parseInput(listQuerySchema, req.query);
    res.status(200).json(await auctions.list(query, getAuth(res)?.userId));
  });

  router.get('/auctions/:auctionId', optional, async (req, res) => {
    const id = parseInput(auctionIdSchema, req.params['auctionId']);
    res.status(200).json({ auction: await auctions.get(id, getAuth(res)?.userId) });
  });

  router.patch('/auctions/:auctionId', required, async (req, res) => {
    const id = parseInput(auctionIdSchema, req.params['auctionId']);
    const patch = parseInput(updateAuctionSchema, req.body);
    res.status(200).json({ auction: await auctions.update(id, mustGetAuth(res).userId, patch) });
  });

  router.post('/auctions/:auctionId/publish', required, async (req, res) => {
    const id = parseInput(auctionIdSchema, req.params['auctionId']);
    res.status(200).json({ auction: await auctions.publish(id, mustGetAuth(res).userId) });
  });

  return router;
}
