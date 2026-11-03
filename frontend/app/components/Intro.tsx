"use client";

/* First-use intro: what the app does, how to tell it what's wrong
   (speak, type or a photo), how to describe a problem, and the safety
   note. Shown once per browser; "Got it" stores that it was seen. */

import { useEffect, useRef } from "react";

export const INTRO_KEY = "handyman-intro-seen";

export function introSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false; // private mode: show it, closing still works
  }
}

export default function Intro({ onClose }: { onClose: () => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), []);

  const close = () => {
    try {
      window.localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* not stored: it shows again next time */
    }
    onClose();
  };

  return (
    <div className="intro-backdrop">
      <div className="intro-card" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <p className="sheet-label">Welcome</p>
        <h2 id="intro-title" className="intro-title">Try DIY before you call a handyman.</h2>
        <p className="intro-lead">
          Show us what&apos;s wrong. We&apos;ll check the basics, guide you through a safe fix, or find a
          handyman nearby.
        </p>

        <ul className="intro-list">
          <li>
            <strong>Tap to speak.</strong> Say what it does or doesn&apos;t do, like &ldquo;AC runs but no
            cold air&rdquo;.
          </li>
          <li>
            <strong>Be specific.</strong> &ldquo;It&apos;s broken&rdquo; leaves us guessing.
          </li>
          <li>
            <strong>Can&apos;t talk?</strong> Type it. <strong>No camera?</strong> Add a photo, then describe
            the problem.
          </li>
        </ul>

        <p className="intro-note">
          Risky jobs get a warning first, and you can still go ahead at your own risk. Your history is
          saved for this browser, no login, and how fixes turn out (words only) helps Handyman learn.
          Turn that off or delete it all in History.
        </p>

        <button ref={okRef} type="button" className="btn-primary" onClick={close}>
          Got it
        </button>
      </div>
    </div>
  );
}
