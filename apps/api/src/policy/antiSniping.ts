// Anti-sniping policy (product rule 13). Pure: it decides, it does not touch the database. The
// bid transaction calls it with a clock reading taken AFTER the auction lock (plan section 3.4).
// The same numbers are enforced a second time by the trigger in db/migrations/0005_lifecycle.sql
// and the table CHECKs; keep them identical.

/** A bid in the last 2 minutes before ends_at extends the auction. */
export const ANTI_SNIPING_WINDOW_MS = 2 * 60 * 1000;
/** ... to bid time + 2 minutes. */
export const EXTENSION_MS = 2 * 60 * 1000;
/** At most 10 extensions per auction ... */
export const MAX_EXTENSIONS = 10;
/** ... and never later than the seller's end time + 1 hour, whichever limit is reached first. */
export const MAX_TOTAL_EXTENSION_MS = 60 * 60 * 1000;

export interface ExtensionInput {
  /** The decision time: milliseconds since the epoch, from the database clock read after the lock. */
  nowMs: number;
  endsAtMs: number;
  /** The end time the seller set (frozen at publication). */
  originalEndsAtMs: number;
  /** Extensions already used. */
  extensionCount: number;
}

export type ExtensionDecision =
  | { extend: true; newEndsAtMs: number; extensionCount: number }
  | { extend: false; reason: 'not-in-window' | 'extension-limit' | 'no-gain' | 'already-over' };

/**
 * Should a bid accepted at `nowMs` move the end time, and to when?
 *
 * - The bid must be valid, so `nowMs < endsAtMs` (the caller has already refused a late bid; this
 *   function refuses it too, because it is cheap and the rule is "a finished auction is never extended").
 * - It qualifies if `endsAtMs - nowMs <= window`; a bid exactly 2 minutes before the end would only
 *   set the end to where it already is, so it is a "no-gain", not an extension.
 * - The new end is `now + 2 minutes`, but never later than `original + 1 hour`.
 * - No extension is made after 10, and none that would not move the end forward (the time cap has
 *   been reached): in those cases the bid is simply accepted without an `auction.extended` event.
 */
export function computeExtension(i: ExtensionInput): ExtensionDecision {
  if (i.nowMs >= i.endsAtMs) return { extend: false, reason: 'already-over' };
  if (i.endsAtMs - i.nowMs > ANTI_SNIPING_WINDOW_MS)
    return { extend: false, reason: 'not-in-window' };
  if (i.extensionCount >= MAX_EXTENSIONS) return { extend: false, reason: 'extension-limit' };
  const cap = i.originalEndsAtMs + MAX_TOTAL_EXTENSION_MS;
  const newEndsAtMs = Math.min(i.nowMs + EXTENSION_MS, cap);
  if (newEndsAtMs <= i.endsAtMs) return { extend: false, reason: 'no-gain' };
  return { extend: true, newEndsAtMs, extensionCount: i.extensionCount + 1 };
}
