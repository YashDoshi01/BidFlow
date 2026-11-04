import { AppError } from '../../http/errors.ts';
import { PG_CHECK_VIOLATION, pgCode, withTransaction, type Db } from '../../db/pool.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import * as repo from './repository.ts';
import type { CreateAuctionInput, ListQuery, UpdateAuctionInput } from './schemas.ts';
import { canTransition, publishTarget, validateSchedule } from './stateMachine.ts';

export interface AuctionView {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  startingPrice: string;
  currentPrice: string;
  minimumIncrement: string;
  currency: string;
  status: repo.AuctionRow['status'];
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

function toView(r: repo.AuctionRow): AuctionView {
  return {
    id: r.id,
    sellerId: r.seller_id,
    title: r.title,
    description: r.description,
    startingPrice: r.starting_price,
    currentPrice: r.current_price,
    minimumIncrement: r.minimum_increment,
    currency: r.currency,
    status: r.status,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const notFound = (): AppError => new AppError(404, 'NOT_FOUND', 'Auction not found');

function scheduleError(message: string): AppError {
  return new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', [
    { path: 'endsAt', message },
  ]);
}

/**
 * Ownership check used by every mutation. A draft is invisible to everyone but
 * its seller, so for a non-owner it is reported as 404 (its existence is not
 * revealed). A published auction is public, so a non-owner gets 403.
 */
function assertOwner(row: repo.AuctionRow, userId: string): void {
  if (row.seller_id === userId) return;
  if (row.status === 'DRAFT') throw notFound();
  throw new AppError(403, 'FORBIDDEN', 'Only the seller can change this auction');
}

/** Database CHECK violations are the backstop for rules the app should already have caught. */
function mapDbError(error: unknown): never {
  if (pgCode(error) === PG_CHECK_VIOLATION) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Request validation failed');
  }
  throw error;
}

export interface AuctionService {
  create: (sellerId: string, input: CreateAuctionInput) => Promise<AuctionView>;
  get: (id: string, viewerId: string | undefined) => Promise<AuctionView>;
  update: (id: string, userId: string, patch: UpdateAuctionInput) => Promise<AuctionView>;
  publish: (id: string, userId: string) => Promise<AuctionView>;
  list: (
    query: ListQuery,
    viewerId: string | undefined,
  ) => Promise<{ items: AuctionView[]; nextCursor: string | null }>;
}

export function createAuctionService(db: Db): AuctionService {
  return {
    async create(sellerId, input) {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      const problem = validateSchedule(startsAt, endsAt);
      if (problem) throw scheduleError(problem);
      try {
        // sellerId comes from the authenticated session, never from the body.
        const row = await repo.insertAuction(db, {
          sellerId,
          title: input.title,
          description: input.description,
          startingPrice: input.startingPrice,
          minimumIncrement: input.minimumIncrement,
          currency: input.currency,
          startsAt,
          endsAt,
        });
        return toView(row);
      } catch (error) {
        return mapDbError(error);
      }
    },

    async get(id, viewerId) {
      const row = await repo.findAuction(db, id);
      if (!row) throw notFound();
      if (row.status === 'DRAFT' && row.seller_id !== viewerId) throw notFound();
      return toView(row);
    },

    update(id, userId, patch) {
      return withTransaction(db, async (client) => {
        // Lock first, then decide: a concurrent publish cannot slip in between
        // the status check and the write.
        const row = await repo.lockAuction(client, id);
        if (!row) throw notFound();
        assertOwner(row, userId);
        if (row.status !== 'DRAFT') {
          throw new AppError(409, 'INVALID_STATE', 'Only a DRAFT auction can be edited');
        }
        const merged = {
          title: patch.title ?? row.title,
          description: patch.description ?? row.description,
          startingPrice: patch.startingPrice ?? row.starting_price,
          minimumIncrement: patch.minimumIncrement ?? row.minimum_increment,
          currency: patch.currency ?? row.currency,
          startsAt: patch.startsAt ? new Date(patch.startsAt) : row.starts_at,
          endsAt: patch.endsAt ? new Date(patch.endsAt) : row.ends_at,
        };
        const problem = validateSchedule(merged.startsAt, merged.endsAt);
        if (problem) throw scheduleError(problem);
        try {
          return toView(await repo.updateDraftFields(client, id, merged));
        } catch (error) {
          return mapDbError(error);
        }
      });
    },

    publish(id, userId) {
      return withTransaction(db, async (client) => {
        const row = await repo.lockAuction(client, id);
        if (!row) throw notFound();
        assertOwner(row, userId);
        if (row.status !== 'DRAFT') {
          throw new AppError(409, 'INVALID_STATE', 'Only a DRAFT auction can be published');
        }
        // Read the clock after the lock is held (plan section 3.4).
        const now = await repo.databaseNow(client);
        const target = publishTarget(row.starts_at, row.ends_at, now);
        if (!target) {
          throw new AppError(409, 'INVALID_STATE', 'endsAt is in the past; edit the auction first');
        }
        if (!canTransition(row.status, target)) {
          throw new AppError(409, 'INVALID_STATE', 'Illegal status transition');
        }
        return toView(await repo.setStatus(client, id, target));
      });
    },

    async list(query, viewerId) {
      if (query.mine === 'true' && query.sellerId !== undefined) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', [
          { path: 'mine', message: 'cannot be combined with sellerId' },
        ]);
      }
      if (query.mine === 'true' && viewerId === undefined) {
        throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      }
      const mine = query.mine === 'true';
      const rows = await repo.listAuctions(db, {
        publicOnly: !mine,
        sellerId: mine ? viewerId : query.sellerId,
        status: query.status,
        beforeSeq: query.cursor ? decodeCursor(query.cursor) : undefined,
        limit: query.limit + 1, // one extra row tells us whether another page exists
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toView),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.seq) : null,
      };
    },
  };
}
