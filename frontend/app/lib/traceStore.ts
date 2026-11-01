/* Session trace: every model call the backend made for this session,
   as returned in each API response's `trace` field. A fetch tap collects
   them, so no call site has to remember to. Shown in the trace drawer
   and exported as JSON (proof of live Meta model calls). */

export interface TraceRecord {
  id: string;
  kind: "model" | "hop";
  model: string;
  purpose: string;
  start_s: number;
  latency_ms: number | null;
  status: "ok" | "error";
  usage: Record<string, unknown> | null;
  input_thumb: string | null;
  mask_thumb?: string | null;
  output_thumb?: string | null;
  parsed: unknown;
  raw_text?: string;
  request_text?: string;
  effort?: string | null;
  finish?: string | null;
  error: string | null;
  // Added client-side.
  at: number; // ms epoch when the response reached the phone
  endpoint: string;
}

type Listener = (records: TraceRecord[]) => void;

const records: TraceRecord[] = [];
const seen = new Set<string>();
const listeners = new Set<Listener>();
export const sessionStarted = Date.now();
export const sessionId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : String(sessionStarted);

export function addTrace(list: unknown, endpoint: string): void {
  if (!Array.isArray(list) || !list.length) return;
  const at = Date.now();
  for (const r of list as TraceRecord[]) {
    if (!r || typeof r !== "object" || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    records.push({ ...r, at, endpoint });
  }
  const snapshot = records.slice();
  listeners.forEach((l) => l(snapshot));
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(records.slice());
  return () => listeners.delete(l);
}

export function getRecords(): TraceRecord[] {
  return records.slice();
}

/* Wrap window.fetch once: any JSON response from an /api/ route that
   carries `trace` lands in the store. The original response is
   returned untouched. */
export function installFetchTap(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __hmTap?: boolean };
  if (w.__hmTap) return;
  w.__hmTap = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.href).pathname;
      if (path.startsWith("/api/") && (res.headers.get("content-type") || "").includes("json")) {
        res
          .clone()
          .json()
          .then((d) => addTrace(d?.trace, path))
          .catch(() => undefined);
      }
    } catch (_) {
      // Never let the tap break a request.
    }
    return res;
  };
}

/* The whole session as a JSON file the user can save or share. */
export function exportTrace(): void {
  const body = {
    app: "Handyman",
    session_id: sessionId,
    started: new Date(sessionStarted).toISOString(),
    exported: new Date().toISOString(),
    user_agent: navigator.userAgent,
    models: Array.from(new Set(records.filter((r) => r.kind === "model").map((r) => r.model))),
    calls: records,
  };
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `handyman-trace-${sessionId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
