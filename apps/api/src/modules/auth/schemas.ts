import { z } from 'zod';

export const registerSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email())
      .refine((e) => e.length <= 254, 'too long'),
    // Length only (NIST SP 800-63B): no composition rules. Upper bound stops
    // a huge password from making the server hash megabytes.
    password: z.string().min(10).max(128),
    displayName: z.string().trim().min(1).max(50),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
