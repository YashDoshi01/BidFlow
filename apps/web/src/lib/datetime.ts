/** `<input type="datetime-local">` speaks local time without a zone: "2030-01-01T12:30". */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local `datetime-local` text to an absolute instant (ISO 8601 with Z). null if empty or invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (value === '') return null;
  const d = new Date(value); // a zone-less date-time string is read as LOCAL time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
