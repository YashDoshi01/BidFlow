import { AppError } from './errors.ts';

// An opaque cursor is not a security boundary (it is trivially decodable); it
// stops clients depending on its shape. The value is validated on the way in.
export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      's' in parsed &&
      typeof parsed.s === 'string' &&
      /^\d{1,18}$/.test(parsed.s)
    ) {
      return parsed.s;
    }
  } catch {
    // fall through to the error below
  }
  throw new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', [
    { path: 'cursor', message: 'invalid cursor' },
  ]);
}
