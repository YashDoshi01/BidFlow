import type { z } from 'zod';
import { AppError, type ErrorDetail } from './errors.ts';

/**
 * Parses untrusted input with a zod schema. On failure it throws a 400 whose
 * details list the field path and the rule, never the submitted value
 * (the value may be a password).
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: ErrorDetail[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
  throw new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', details);
}
