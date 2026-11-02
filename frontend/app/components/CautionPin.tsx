"use client";

/* A step's caution as a small warning pin in the card's bottom corner.
   Tap it to read the warning in a bubble; tap again (or anywhere else)
   to close. The warning is still spoken with the step, so the card stays
   short without hiding anything. */

import { useEffect, useRef, useState } from "react";

export default function CautionPin({ text }: { text: string }) {
  const [open, setOpen] = useState<boolean>(false);
  const ref = useRef<HTMLDivElement>(null);

  // A new step closes the bubble; a tap outside closes it too.
  useEffect(() => setOpen(false), [text]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div className="caution-pin" ref={ref}>
      {open && (
        <p className="caution-bubble" role="note">
          <strong>Careful:</strong> {text}
        </p>
      )}
      <button
        type="button"
        className={`caution-btn${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Hide the warning" : "Careful: show the warning"}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 3 22 20H2L12 3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 10v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="17.6" r="1.1" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}
