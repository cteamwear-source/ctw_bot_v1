/**
 * T5 cold-start guard: importing the webhook entry point must not load the
 * heavy modules that only some paths need (they are `await import()`ed
 * lazily). Runs the import in a fresh Node process so module caches from
 * other tests can't hide a regression.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAVY = [
  "sharp",
  "google-spreadsheet",
  "google-auth-library",
  "@vercel/blob",
  "qrcode",
  "@sentry/node",
  "@upstash/ratelimit",
];

function isPackage(entry: string, pkg: string): boolean {
  if (entry === pkg || entry.startsWith(`${pkg}/`)) return true;
  const norm = decodeURIComponent(entry).replace(/\\/g, "/");
  return norm.includes(`/node_modules/${pkg}/`);
}

test("cold start: importing api/webhook.ts loads none of the heavy modules", () => {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join("tests", "support", "coldStartProbe.ts")],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  const line = child.stdout.split("\n").find((l) => l.startsWith("__COLDSTART__"));
  assert.ok(line, `probe produced no result. status=${child.status}\nstderr:\n${child.stderr}`);
  const result = JSON.parse(line.slice("__COLDSTART__".length)) as {
    importMs: number;
    specifiers: string[];
    urls: string[];
  };

  // Sanity: the probe really saw the webhook's own dependency graph.
  assert.ok(result.specifiers.some((s) => isPackage(s, "@vercel/functions")), "hook recorded webhook imports");

  const all = [...result.specifiers, ...result.urls];
  const loaded = HEAVY.filter((pkg) => all.some((e) => isPackage(e, pkg)));
  console.log(`[coldStart] api/webhook.ts import ${Math.round(result.importMs)}ms; heavy loaded: ${loaded.join(", ") || "none"}`);
  assert.deepEqual(loaded, [], "heavy modules must be lazy-loaded");
});
