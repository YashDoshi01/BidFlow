import { z } from 'zod';

// Money travels as a decimal string ("125.50"), never as a JSON number, so no
// binary floating point is involved anywhere between client and NUMERIC(12,2).
export const moneyString = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a decimal string with at most 2 decimal places')
  .refine((v) => /[1-9]/.test(v), 'must be greater than zero');
