import { z } from 'zod';
import { moneyString } from '../../http/schemas.ts';

export const placeBidSchema = z.object({ amount: moneyString }).strict();

// Letters, digits and . _ : - ; 8-128 characters (a UUID fits). The same rule is a
// CHECK constraint on idempotency_records.
export const idempotencyKeySchema = z
  .string({ error: 'header is required' })
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'must be 8-128 characters of letters, digits and . _ : -');

export const bidHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(100).optional(),
  })
  .strict();

export type PlaceBidInput = z.infer<typeof placeBidSchema>;
export type BidHistoryQuery = z.infer<typeof bidHistoryQuerySchema>;
