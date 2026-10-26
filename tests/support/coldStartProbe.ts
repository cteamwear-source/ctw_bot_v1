/**
 * Child-process probe for tests/coldStart.test.ts.
 *
 * Records every module resolution (ESM import and CJS require) while
 * importing api/webhook.ts, then prints one JSON line:
 *   {"importMs": <number>, "specifiers": [...], "urls": [...]}
 */
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";

const specifiers = new Set<string>();
const urls = new Set<string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    specifiers.add(specifier);
    const result = nextResolve(specifier, context);
    if (result?.url) urls.add(result.url);
    return result;
  },
});

await import("./testEnv.js");
const t0 = performance.now();
await import("../../api/webhook.js");
const importMs = performance.now() - t0;

process.stdout.write(
  "\n__COLDSTART__" + JSON.stringify({ importMs, specifiers: [...specifiers], urls: [...urls] }) + "\n",
);
process.exit(0);
