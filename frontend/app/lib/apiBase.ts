// Pure backend-base resolution (no DOM): env override wins, then the
// per-browser saved value, then same-host port 8000.
export function resolveApiBase(
  env: string | undefined,
  saved: string | null | undefined,
  hostname: string
): string {
  if (env) return env;
  if (saved) return saved;
  return `http://${hostname}:8000`;
}
