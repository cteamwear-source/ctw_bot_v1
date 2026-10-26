/**
 * Latency probe (plan.md T9): times N lightweight Graph API calls through
 * META_API_BASE_URL (e.g. Emovur) and, with --compare, the same calls
 * against graph.facebook.com directly. Prints p50/p95 per host so you can
 * decide whether the provider hop is worth keeping.
 *
 *   npm run latency-probe              # 10 calls via META_API_BASE_URL
 *   npm run latency-probe -- 20 --compare
 *
 * Reads META_API_TOKEN / META_PHONE_NUMBER_ID / META_API_BASE_URL from the
 * environment, .env.local or .env. Never prints the token, the phone number
 * id, response bodies or any other env value: only the host, HTTP status
 * codes and timings.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://graph.facebook.com";
const GRAPH_VERSION = "v20.0";
const CALL_TIMEOUT_MS = 10_000;

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  baseUrl: string;
  token: string;
  phoneNumberId: string;
  count: number;
  fetchImpl?: ProbeFetch;
  now?: () => number;
}

export interface ProbeResult {
  host: string;
  timingsMs: number[];
  statuses: Record<string, number>;
  p50: number;
  p95: number;
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** Host only (no path, query or credentials) — safe to print. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** Time `count` sequential GET <base>/<version>/<phone-number-id>?fields=id calls. */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = opts.now ?? (() => performance.now());
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/${GRAPH_VERSION}/${encodeURIComponent(opts.phoneNumberId)}?fields=id`;
  const timingsMs: number[] = [];
  const statuses: Record<string, number> = {};
  for (let i = 0; i < opts.count; i++) {
    const startedAt = now();
    let status: string;
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      await res.arrayBuffer(); // include body read in the timing; never printed
      status = String(res.status);
    } catch (err) {
      status = (err as Error)?.name === "TimeoutError" ? "timeout" : "network-error";
    }
    timingsMs.push(Math.round(now() - startedAt));
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return { host: hostOf(base), timingsMs, statuses, p50: percentile(timingsMs, 50), p95: percentile(timingsMs, 95) };
}

export function formatResult(r: ProbeResult): string {
  const codes = Object.entries(r.statuses)
    .map(([s, n]) => `${s}×${n}`)
    .join(" ");
  return `${r.host}: n=${r.timingsMs.length} p50=${r.p50}ms p95=${r.p95}ms min=${Math.min(...r.timingsMs)}ms max=${Math.max(...r.timingsMs)}ms status=[${codes}]`;
}

async function loadEnvFiles(): Promise<void> {
  const { config } = await import("dotenv");
  // Existing process env wins; .env.local before .env. quiet: no dotenv logs.
  for (const path of [".env.local", ".env"]) config({ path, quiet: true });
}

async function main(): Promise<void> {
  await loadEnvFiles();
  const args = process.argv.slice(2);
  const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
  const compare = args.includes("--compare");
  const token = process.env["META_API_TOKEN"];
  const phoneNumberId = process.env["META_PHONE_NUMBER_ID"];
  if (!token || !phoneNumberId) {
    console.error("Missing META_API_TOKEN or META_PHONE_NUMBER_ID (env, .env.local or .env).");
    process.exit(1);
  }
  const baseUrl = (process.env["META_API_BASE_URL"] ?? DEFAULT_BASE).trim() || DEFAULT_BASE;
  const targets = [baseUrl];
  if (compare && hostOf(baseUrl) !== hostOf(DEFAULT_BASE)) targets.push(DEFAULT_BASE);

  console.log(`Probing ${count} calls per host (sequential, ${CALL_TIMEOUT_MS / 1000}s timeout each)…`);
  for (const target of targets) {
    console.log(formatResult(await probe({ baseUrl: target, token, phoneNumberId, count })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Error name only: messages from fetch can echo request details.
    console.error(`latency-probe failed: ${(err as Error)?.name ?? "Error"}`);
    process.exit(1);
  });
}
