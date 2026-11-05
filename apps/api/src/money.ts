// Exact decimal arithmetic for amounts with two decimal places.
// Amounts are strings at every boundary ("125.50"). Inside this file they are
// converted to a BigInt count of minor units (cents), so no JavaScript number,
// and therefore no binary floating point, ever holds a price.
// Limitation (ADR-019): all supported currencies are assumed to have 2 decimals
// (not JPY, KWD, ...).

const PATTERN = /^(\d{1,10})(?:\.(\d{1,2}))?$/;
const MAX_MINOR = 999_999_999_999n; // NUMERIC(12,2) upper bound: 9999999999.99

export function isMoney(value: string): boolean {
  return PATTERN.test(value);
}

export function toMinorUnits(value: string): bigint {
  const match = PATTERN.exec(value);
  if (!match) throw new Error('not a money string');
  const whole = BigInt(match[1] as string);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + fraction;
}

/** Returns undefined if the amount does not fit NUMERIC(12,2). */
export function fromMinorUnits(minor: bigint): string | undefined {
  if (minor < 0n || minor > MAX_MINOR) return undefined;
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
}

/** "125" and "125.5" become "125.00" and "125.50". */
export function normalizeMoney(value: string): string {
  return fromMinorUnits(toMinorUnits(value)) as string;
}

export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const x = toMinorUnits(a);
  const y = toMinorUnits(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** a + b, or undefined if the result does not fit NUMERIC(12,2). */
export function addMoney(a: string, b: string): string | undefined {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}
