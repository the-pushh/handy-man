/* Turn timeline: one console line per hop, relative to the turn start.
   Read in DevTools (filter "[hm]") or window.__hm for the raw list.
   The same lines go to the backend logs in small batches (/api/event),
   so a phone test can be checked afterwards from the server side:
   `modal app logs handyman-backend --since 1h | grep '"what": "client"'`. */

import { sessionId } from "./apiBase";

type Mark = { t: number; hop: string; detail?: string };

const marks: Mark[] = [];
let t0 = 0;
let unsent: Mark[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let logBase: string | null = null;

/* Where to send the batches ("" = same origin); null = don't send. */
export function setLogBase(base: string): void {
  logBase = base;
}

function flush(): void {
  flushTimer = null;
  if (logBase === null || !unsent.length) return;
  const events = unsent.slice(0, 60).map((m) => ({
    t: Math.round(m.t * 100) / 100,
    hop: m.hop.slice(0, 80),
    detail: (m.detail || "").slice(0, 200),
  }));
  unsent = unsent.slice(60);
  try {
    void fetch(`${logBase}/api/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionId(), events }),
      keepalive: true,
    }).catch(() => undefined);
  } catch (_) {
    // Logging never gets in the way.
  }
  if (unsent.length) flushTimer = setTimeout(flush, 3000);
}

export function turnStart(label: string): void {
  marks.length = 0;
  t0 = performance.now();
  mark(label);
}

export function mark(hop: string, detail?: string): void {
  if (!t0) t0 = performance.now();
  const t = (performance.now() - t0) / 1000;
  marks.push({ t, hop, detail });
  unsent.push({ t, hop, detail });
  // One batch per quiet moment: at most every 3s while things happen.
  if (!flushTimer) flushTimer = setTimeout(flush, 3000);
  if (typeof window !== "undefined") {
    (window as unknown as { __hm?: Mark[] }).__hm = marks;
  }
  console.log(`[hm] +${t.toFixed(2)}s ${hop}${detail ? " " + detail : ""}`);
}

/* Seconds since the current turn started (0 before any turn). */
export function turnElapsed(): number {
  return t0 ? (performance.now() - t0) / 1000 : 0;
}

export function kb(n: number): string {
  return `${Math.round(n / 1024)}KB`;
}
