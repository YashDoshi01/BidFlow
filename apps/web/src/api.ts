// A thin fetch wrapper. `/api` is rewritten to the API by the dev server (and by
// NGINX later). The browser never talks to any other origin.

import { observeResponse } from './lib/clock.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Record<string, string> | undefined;
  /** Field-level validation problems (`path` and rule only; the server never echoes submitted values). */
  readonly details: { path: string; message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    data?: Record<string, string>,
    details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
    this.details = details;
  }
}

interface Options {
  token?: string | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(method: string, path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  const sentAt = Date.now();
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // Network failure: the request may or may not have reached the server.
    throw new ApiError(0, 'NETWORK', 'Network error: the request may not have arrived');
  }
  const receivedAt = Date.now();
  // Only used to display a countdown closer to the server's clock (see lib/clock.ts).
  observeResponse(response.headers.get('Date'), sentAt, receivedAt);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error: the reply was cut off');
  }
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON (for example an HTML error page from a proxy): never let a parse error escape.
    if (response.ok)
      throw new ApiError(response.status, 'BAD_REPLY', 'The server sent an unreadable reply');
    json = undefined;
  }
  if (!response.ok) {
    const error = (
      json as
        | {
            error?: {
              code?: string;
              message?: string;
              data?: Record<string, string>;
              details?: { path: string; message: string }[];
            };
          }
        | undefined
    )?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed (${String(response.status)})`,
      error?.data,
      Array.isArray(error?.details) ? error.details : [],
    );
  }
  return json as T;
}

/**
 * One cheap request whose only purpose is its `Date` header, so the countdown can correct for a
 * wrong browser clock even for a visitor who makes no other REST call (the room itself talks over
 * the socket). Failure is ignored: the countdown then uses the browser clock.
 */
export function syncServerClock(): void {
  void api('GET', '/health/live').catch(() => undefined);
}
