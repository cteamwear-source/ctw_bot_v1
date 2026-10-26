import { withTimeout } from "../shared/withTimeout.js";

/** Hard cap on one Google Sheets attempt (T8), so a hung call fails fast and retries/escalates. */
export const SHEETS_TIMEOUT_MS = 10_000;

export function sheetsAttempt<T>(fn: () => Promise<T>): Promise<T> {
  return withTimeout(fn(), SHEETS_TIMEOUT_MS, "Google Sheets call");
}
