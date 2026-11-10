import type { RequestHandler } from 'express';

/**
 * Headers for an API that returns only JSON. None of the responses is ever meant to be rendered,
 * framed, cached or shared:
 *  - `nosniff`: a browser must not guess a different content type.
 *  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`: if a response were
 *    ever rendered as a document it could load and run nothing, and nobody can frame it.
 *  - `X-Frame-Options: DENY`: the same for older browsers.
 *  - `Cache-Control: no-store`: bids, sessions and notifications are per user and moment.
 *  - `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`.
 * No CORS headers are sent at all: the web client and the API share one origin (the Vite proxy in
 * development, NGINX in production), so browsers refuse cross-origin reads by default.
 */
export function apiSecurityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  };
}

/**
 * Whether a browser-supplied `Origin` may open a WebSocket.
 *
 * Browsers do NOT apply CORS to WebSockets: any web page can try to open one. Here the credential
 * is a bearer token the page must put in the handshake itself (not a cookie the browser attaches),
 * so a foreign page has no ambient credential to ride on. The check is still applied, as defence
 * in depth and to keep anonymous scraping from arbitrary sites out:
 *  - no Origin header: not a browser (a script, a test client): allowed, there is nothing to forge;
 *  - the Origin's host is the host the request was sent to: same origin, allowed;
 *  - otherwise only an origin listed in `allowed` (exact match, for example a separate dev server).
 */
export function isOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (hostHeader !== undefined && parsed.host.toLowerCase() === hostHeader.toLowerCase()) {
    return true;
  }
  return allowed.includes(parsed.origin);
}
