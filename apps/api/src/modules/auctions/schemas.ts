import { z } from 'zod';
import { moneyString as money } from '../../http/schemas.ts';
import { AUCTION_STATUSES } from './stateMachine.ts';

const isoInstant = z.iso.datetime({ offset: true });

export const createAuctionSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5000).default(''),
    startingPrice: money,
    minimumIncrement: money.default('1.00'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'must be a 3-letter upper-case code')
      .default('USD'),
    startsAt: isoInstant,
    endsAt: isoInstant,
  })
  .strict();

export const updateAuctionSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5000),
    startingPrice: money,
    minimumIncrement: money,
    currency: z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter upper-case code'),
    startsAt: isoInstant,
    endsAt: isoInstant,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

const uuid = z.uuid();
export const auctionIdSchema = uuid;

export const listQuerySchema = z
  .object({
    status: z.enum(AUCTION_STATUSES).optional(),
    sellerId: uuid.optional(),
    mine: z.enum(['true', 'false']).optional(),
    /** Title search: 1-100 characters after trimming, matched literally. */
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();

export type CreateAuctionInput = z.infer<typeof createAuctionSchema>;
export type UpdateAuctionInput = z.infer<typeof updateAuctionSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
