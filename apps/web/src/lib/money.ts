// Money arrives from the API as decimal strings ("13.50"). The client never does float arithmetic on
// them: amounts are converted to whole cents (an integer) and back. These helpers only produce
// SUGGESTIONS for the bid box; the server decides what is acceptable.

const MONEY = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

/** "13.5" -> 1350. Returns null for anything that is not a plain non-negative amount. */
export function toCents(amount: string): number | null {
  const m = MONEY.exec(amount.trim());
  if (!m?.[1]) return null;
  const fraction = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(fraction);
}

/** 1350 -> "13.50". */
export function fromCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${String(whole)}.${String(rest).padStart(2, '0')}`;
}

/**
 * Up to three one-tap amounts: the minimum, the minimum plus one increment, and plus five
 * increments. Empty when either input is missing or malformed (then no buttons are shown).
 */
export function quickBids(minimumNextBid: string | null, increment: string): string[] {
  if (minimumNextBid === null) return [];
  const min = toCents(minimumNextBid);
  const inc = toCents(increment);
  if (min === null || inc === null || inc <= 0) return [];
  return [min, min + inc, min + 5 * inc].map(fromCents);
}

/** "1234.50" -> "1,234.50" for display only (never sent back to the server). */
export function groupThousands(amount: string): string {
  const [whole = '', fraction] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
