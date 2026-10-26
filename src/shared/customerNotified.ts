/**
 * Marks an error whose customer apology was already sent, so the top-level
 * handler in src/bot/index.ts does not send a second one (T8: exactly one
 * reply per failure).
 */

const NOTIFIED = Symbol.for("ctw.customerNotified");

export function markCustomerNotified(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  (error as unknown as Record<symbol, boolean>)[NOTIFIED] = true;
  return error;
}

export function customerWasNotified(err: unknown): boolean {
  return err instanceof Error && (err as unknown as Record<symbol, boolean>)[NOTIFIED] === true;
}
