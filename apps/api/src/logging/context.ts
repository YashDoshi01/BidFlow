import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields that belong to the unit of work currently running (an HTTP request), added to every log
 * line written while it runs, however deep in the code the line is written. Without this, a log
 * line from the bid service says "bid rejected" and nobody can tell which request it was; with it,
 * every line carries the request id that the client also received in `X-Request-Id`.
 *
 * AsyncLocalStorage follows the work across `await`s, so concurrent requests never see each
 * other's fields.
 */
const storage = new AsyncLocalStorage<Record<string, unknown>>();

export function runWithLogContext<T>(fields: Record<string, unknown>, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export function currentLogContext(): Record<string, unknown> {
  return storage.getStore() ?? {};
}
