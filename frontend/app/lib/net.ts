/* JSON requests to the backend that survive a flaky phone connection.

   A phone test (2026-11-03) lost two requests that the server had
   answered: the first diagnosis (34 s, thrown away and asked again,
   another 34 s) and the SAM outlines (every step fell back to slow
   illustrations). Both callers swallowed the error. So: a timeout, one
   retry after a network failure or a broken/5xx reply, and every
   failure on the timeline with its real error, so the next test shows
   why. */

import { mark } from "./timeline";

export async function fetchJSON<T = unknown>(
  url: string,
  init: RequestInit,
  { label, timeoutMs, retries = 1 }: { label: string; timeoutMs: number; retries?: number }
): Promise<T> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (e) {
      last = e;
      const err = e as Error;
      const took = ((performance.now() - t0) / 1000).toFixed(1);
      mark("request failed", `${label} try ${attempt + 1}: ${err.name}: ${err.message} after ${took}s`);
      // A timeout already waited the full budget: retrying would double
      // the wait, so only network errors and broken replies retry.
      if (err.name === "TimeoutError" || err.name === "AbortError") break;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 600));
    }
  }
  throw last;
}
