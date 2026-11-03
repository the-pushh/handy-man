"use client";

/* The agent loop's live board: each possible cause with an animated
   confidence bar, and every test so far with the reason it was chosen
   and what came back. Rows keep the order they first appeared in, so a
   bar grows or shrinks in place instead of jumping. */

import { useRef, type ReactNode } from "react";

export interface Hyp {
  cause: string;
  p: number;
}

export interface AgentRound {
  n: number;
  tool: string;
  label: string;
  why: string;
  result?: string;
}

const TOOL: Record<string, string> = {
  ask_user: "Asked you",
  look_closer: "Closer look",
  listen: "Listened",
  segment: "Outlined",
};

export function toolLabel(tool: string): string {
  return TOOL[tool] || tool;
}

export default function HypothesisBoard({
  hyps,
  rounds,
  thinking,
  threshold = 0.75,
  compact = false,
  note = "",
  children,
}: {
  hyps: Hyp[];
  rounds: AgentRound[];
  thinking: boolean;
  threshold?: number;
  compact?: boolean;
  // One line under the title (why the tests run at all).
  note?: string;
  // The current test (a question, "Show me the filter"), shown between
  // the bars and the log so it is always in view.
  children?: ReactNode;
}) {
  // First-seen order, so rows stay put while their bars move.
  const order = useRef<string[]>([]);
  for (const h of hyps) {
    const k = h.cause.toLowerCase();
    if (!order.current.includes(k)) order.current.push(k);
  }
  const byKey = new Map(hyps.map((h) => [h.cause.toLowerCase(), h]));
  const rows = order.current.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  const top = hyps[0]?.cause.toLowerCase();

  return (
    <section className={`hyp-board${compact ? " compact" : ""}`} aria-live="polite">
      <div className="hyp-head">
        <p className="sheet-label">Possible causes</p>
        <p className="hyp-round">
          {thinking ? <span className="hyp-pulse" aria-hidden="true" /> : null}
          {thinking
            ? "Thinking"
            : compact
              ? `After ${rounds.length} test${rounds.length === 1 ? "" : "s"}`
              : `Round ${rounds.length + (rounds.length && rounds[rounds.length - 1].result ? 1 : 0) || 1}`}
        </p>
      </div>
      {note && <p className="hyp-note">{note}</p>}
      <ul className="hyp-list">
        {rows.map((h) => {
          const pct = Math.round(h.p * 100);
          const lead = h.cause.toLowerCase() === top;
          return (
            <li key={h.cause.toLowerCase()} className={`hyp-row${lead ? " lead" : ""}`}>
              <div className="hyp-label">
                <span>{h.cause}</span>
                <span className="hyp-pct">{pct}%</span>
              </div>
              <div className="hyp-track">
                <div className="hyp-bar" style={{ width: `${Math.max(2, pct)}%` }} />
                <span className="hyp-mark" style={{ left: `${threshold * 100}%` }} aria-hidden="true" />
              </div>
            </li>
          );
        })}
      </ul>
      {children}
      {rounds.length > 0 && (
        <ol className="hyp-log">
          {[...rounds].reverse().map((r) => (
            <li key={r.n}>
              <p className="hyp-move">
                <strong>
                  {r.n}. {toolLabel(r.tool)}
                </strong>{" "}
                {r.label}
              </p>
              {r.why && !compact && <p className="hyp-why">{r.why}</p>}
              {r.result && <p className="hyp-result">{r.result}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
