"use client";

/* The orb: front-view fan disc with TWO spoke layers. The outer 24
   cream blades ripple with the human voice (mic level); the inner 12
   orange blades ripple with the AI voice (TTS level). Driven by
   requestAnimationFrame straight on the SVG lines — no react state
   per frame. Still when idle. */

import { useEffect, useRef } from "react";

export type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "asking"
  | "success"
  | "error";

const OUTER = Array.from({ length: 24 }, (_, i) => (i * 360) / 24);
const INNER = Array.from({ length: 12 }, (_, i) => (i * 360) / 12);

export default function Orb({
  state,
  onTap,
  label,
  getHuman,
  getAi,
}: {
  state: OrbState;
  onTap: () => void;
  label: string;
  getHuman?: () => number;
  getAi?: () => number;
}) {
  const outerRef = useRef<SVGGElement>(null);
  const innerRef = useRef<SVGGElement>(null);
  const liveRef = useRef({ getHuman, getAi, state });
  liveRef.current = { getHuman, getAi, state };

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let raf = 0;
    let last = performance.now();
    let hS = 0;
    let aS = 0;
    // Travelling radial waves: each blade pumps in and out, the crest
    // circling the disc. Outer (human) runs clockwise, inner (AI) runs
    // counter-clockwise; voice level drives the wave height.
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const now = t / 1000;
      const { getHuman, getAi, state } = liveRef.current;
      let h = 0;
      let a = 0;
      try {
        h = getHuman?.() ?? 0;
        a = getAi?.() ?? 0;
      } catch (_) {
        // Levels unavailable; fall back to a calm ripple.
      }
      const k = Math.min(1, dt * 10);
      hS += (Math.min(1, h) - hS) * k;
      aS += (Math.min(1, a) - aS) * k;
      const hActive = state === "listening" || state === "thinking";
      const aActive = state === "speaking";
      const hAmp = hActive ? 0.5 + hS * 5 : 0;
      const aAmp = aActive ? 0.5 + aS * 4 : 0;
      const o = outerRef.current;
      if (o) {
        const blades = o.children;
        for (let i = 0; i < blades.length; i++) {
          const w = Math.sin(now * 6 - (i * Math.PI * 2 * 3) / blades.length);
          blades[i].setAttribute(
            "y1",
            Math.max(4, 10 - w * hAmp).toFixed(2)
          );
        }
        o.setAttribute(
          "opacity",
          hActive ? (0.45 + 0.55 * Math.min(1, hS * 2.5)).toFixed(2) : "0.55"
        );
      }
      const g = innerRef.current;
      if (g) {
        const blades = g.children;
        for (let j = 0; j < blades.length; j++) {
          const w = Math.sin(now * 8 + (j * Math.PI * 2 * 2) / blades.length);
          blades[j].setAttribute(
            "y1",
            Math.max(20.5, 23 - w * aAmp).toFixed(2)
          );
        }
        g.setAttribute(
          "opacity",
          aActive ? (0.45 + 0.55 * Math.min(1, aS * 2.5)).toFixed(2) : "0.55"
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <button
      type="button"
      className={`orb orb-${state}`}
      onClick={onTap}
      aria-label={label}
    >
      <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <circle cx="32" cy="32" r="29" className="orb-casing" />
        <circle cx="32" cy="32" r="29" className="orb-ring" />
        <g ref={outerRef}>
          {OUTER.map((deg) => (
            <line
              key={deg}
              x1="32"
              y1="10"
              x2="32"
              y2="22"
              className="orb-blade orb-blade-human"
              transform={`rotate(${deg} 32 32)`}
            />
          ))}
        </g>
        <g ref={innerRef}>
          {INNER.map((deg) => (
            <line
              key={deg}
              x1="32"
              y1="23"
              x2="32"
              y2="27.5"
              className="orb-blade orb-blade-ai"
              transform={`rotate(${deg} 32 32)`}
            />
          ))}
        </g>
        <line x1="32" y1="4" x2="32" y2="60" className="orb-cross" />
        <line x1="4" y1="32" x2="60" y2="32" className="orb-cross" />
        <circle cx="32" cy="32" r="3.5" className="orb-hub" />
        {state === "asking" && (
          <text x="32" y="37" textAnchor="middle" className="orb-glyph">?</text>
        )}
        {state === "success" && (
          <text x="32" y="37" textAnchor="middle" className="orb-glyph">✓</text>
        )}
        {state === "error" && (
          <text x="32" y="37" textAnchor="middle" className="orb-glyph">✗</text>
        )}
      </svg>
    </button>
  );
}
