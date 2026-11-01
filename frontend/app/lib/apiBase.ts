// Where the browser sends /api/* requests.
// Production: same origin ("" -> relative /api/...), proxied to the Modal backend
// by middleware.ts. There is no backend picker in production builds.
// Development: env override, then the per-browser saved value (the
// tunnel picker), then same-host port 8000.
export const IS_PROD = process.env.NODE_ENV === "production";

export function resolveApiBase(
  env: string | undefined,
  saved: string | null | undefined,
  hostname: string
): string {
  if (IS_PROD) return "";
  if (env) return env;
  if (saved) return saved;
  return `http://${hostname}:8000`;
}

/* One id per browser tab, sent with "call a pro" lookups so the backend
   can cap them per session. Not stored beyond the tab; no login. */
export function sessionId(): string {
  try {
    let id = window.sessionStorage.getItem("handyman-session");
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem("handyman-session", id);
    }
    return id;
  } catch (_) {
    return "";
  }
}
