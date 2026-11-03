/* The diagnostic agent loop is experimental. It runs only when
   NEXT_PUBLIC_AGENT_LOOP=1 (the preview deploy), or when the URL says
   ?agent=1 (remembered in this browser; ?agent=0 turns it off again).
   Otherwise the app keeps its current flow, which is also the fallback
   if the loop fails mid-run. */

const KEY = "handyman-agent";

export function agentEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("agent");
    if (q === "1" || q === "0") window.localStorage.setItem(KEY, q);
    const saved = window.localStorage.getItem(KEY);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    /* storage blocked: fall through to the build flag */
  }
  return process.env.NEXT_PUBLIC_AGENT_LOOP === "1";
}
