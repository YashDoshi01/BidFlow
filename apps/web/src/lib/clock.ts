// The countdown is a DISPLAY derived from the server's end time. It is never the source
// of truth: the server decides when bids stop (database clock) and when the auction ends
// (the lifecycle worker). This module only reduces the visible error caused by a wrong
// browser clock, so "3s left" is not off by minutes on a machine with a bad clock.
//
// How: every API response carries a `Date` header. It has one-second resolution, so the
// real server time is somewhere in [header, header + 1s). We take the middle of that
// interval and compare it with the middle of the request's own round trip. The sample
// with the shortest round trip is the most trustworthy one, so it replaces older samples.
// Expected error: roughly half a second plus half the round trip. Good enough for a label,
// not good enough to decide anything, which is why nothing here ever decides.

export interface ClockSample {
  /** Server time minus browser time, in milliseconds (positive = browser is behind). */
  offsetMs: number;
  /** Round trip of the request the sample came from, in milliseconds. */
  rttMs: number;
}

/** Returns null when the header is missing or unparseable. Pure: times are passed in. */
export function sampleFromResponse(
  dateHeader: string | null,
  sentAtMs: number,
  receivedAtMs: number,
): ClockSample | null {
  if (dateHeader === null) return null;
  const serverSecond = Date.parse(dateHeader);
  if (Number.isNaN(serverSecond)) return null;
  const rttMs = receivedAtMs - sentAtMs;
  if (rttMs < 0) return null; // the browser clock jumped during the request: ignore the sample
  const serverMid = serverSecond + 500;
  const browserMid = sentAtMs + rttMs / 2;
  return { offsetMs: serverMid - browserMid, rttMs };
}

/** Keeps the better (shorter round trip) of two samples. */
export function betterSample(
  current: ClockSample | null,
  next: ClockSample | null,
): ClockSample | null {
  if (next === null) return current;
  if (current === null) return next;
  return next.rttMs <= current.rttMs ? next : current;
}

let best: ClockSample | null = null;

export function observeResponse(
  dateHeader: string | null,
  sentAtMs: number,
  receivedAtMs: number,
): void {
  best = betterSample(best, sampleFromResponse(dateHeader, sentAtMs, receivedAtMs));
}

/** The best estimate of the server's current time (browser time if nothing was observed yet). */
export function serverNow(browserNowMs: number = Date.now()): number {
  return browserNowMs + (best?.offsetMs ?? 0);
}

/** For tests only. */
export function resetClockForTests(): void {
  best = null;
}
