/* The diagnostic agent loop is experimental. Modes:
     off     the regular flow only (the default)
     auto    the router decides per case (NEXT_PUBLIC_AGENT_LOOP=1, or
             ?agent=1): the first diagnosis pass, which already runs in
             the background during the quick checks, says whether one
             common cause stands out ("direct": a flat battery, a dirty
             filter) or several are about equally likely ("investigate").
             Direct cases take the regular fix; only unclear ones get the
             agent's tests, so simple fixes are not tested into doubt.
     always  every case goes through the agent (?agent=always, testing)
   A URL choice is remembered in this browser (?agent=0 turns it off).
   If the loop fails mid-run the regular flow takes over. */

const KEY = "handyman-agent";
export type AgentMode = "off" | "auto" | "always";

function parse(v: string | null | undefined): AgentMode | null {
  if (v === "0" || v === "off") return "off";
  if (v === "1" || v === "auto") return "auto";
  if (v === "always") return "always";
  return null;
}

export function agentMode(): AgentMode {
  if (typeof window === "undefined") return "off";
  try {
    const q = parse(new URLSearchParams(window.location.search).get("agent"));
    if (q) window.localStorage.setItem(KEY, q);
    const saved = parse(window.localStorage.getItem(KEY));
    if (saved) return saved;
  } catch {
    /* storage blocked: fall through to the build flag */
  }
  return parse(process.env.NEXT_PUBLIC_AGENT_LOOP) || "off";
}

/* The router: should this case use the agent's tests? `first` is the
   first diagnosis pass (the quick-check prefetch). */
export function wantsAgent(
  mode: AgentMode,
  first: { status?: string; verdict?: { route?: string | null; confidence?: string | null } } | null
): { agent: boolean; why: string } {
  if (mode === "off") return { agent: false, why: "agent off" };
  if (mode === "always") return { agent: true, why: "agent always on" };
  if (!first || first.status !== "ok") return { agent: false, why: "no first pass: regular flow" };
  const route = first.verdict?.route;
  const conf = first.verdict?.confidence;
  if (route === "direct" || (!route && conf === "high")) {
    return { agent: false, why: `clear case (route ${route || "-"}, confidence ${conf || "-"})` };
  }
  return { agent: true, why: `unclear case (route ${route || "-"}, confidence ${conf || "-"})` };
}
