"use client";

/* What the app is doing while the owner waits: a pulsing mark, the step
   in plain words, a seconds counter and a moving bar, so a 10-second
   model call never looks like a frozen app. `hint` says who is working
   and how long it usually takes; past `slowAfter` seconds it switches to
   a "still working" line. No fake percentages: the bar only shows that
   work is in progress. */

import { useEffect, useState } from "react";

export default function Busy({
  label,
  hint = "",
  slowAfter = 0,
  slowHint = "Still working. The model is slower than usual right now.",
  compact = false,
}: {
  label: string;
  hint?: string;
  slowAfter?: number;
  slowHint?: string;
  compact?: boolean;
}) {
  const [secs, setSecs] = useState<number>(0);
  useEffect(() => {
    const t0 = Date.now();
    setSecs(0);
    const id = window.setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [label]);
  const slow = slowAfter > 0 && secs >= slowAfter;
  return (
    <div className={`busy${compact ? " busy-compact" : ""}`} role="status" aria-live="polite">
      <div className="busy-row">
        <span className="busy-mark" aria-hidden="true" />
        <span className="busy-label">{label}</span>
        <span className="busy-secs" aria-hidden="true">{secs}s</span>
      </div>
      <div className="busy-bar" aria-hidden="true"><span /></div>
      {(slow ? slowHint : hint) && <p className="busy-hint">{slow ? slowHint : hint}</p>}
    </div>
  );
}
