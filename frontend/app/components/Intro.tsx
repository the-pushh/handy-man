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
          Point your camera at what&apos;s acting up and tell us what&apos;s wrong. We&apos;ll run the quick
          checks people often miss, then guide you through a safe fix or find a handyman nearby.
        </p>

        <ul className="intro-list">
          <li>
            <strong>Tap to speak</strong> and describe what it does or doesn&apos;t do, like &ldquo;the AC
            runs but the air isn&apos;t cold&rdquo;.
          </li>
          <li>
            <strong>Details help.</strong> &ldquo;It&apos;s broken&rdquo; or &ldquo;not working&rdquo;
            leaves us guessing.
          </li>
          <li>
            <strong>Rather not talk?</strong> Tap Type. <strong>Camera not working?</strong> Add a Photo,
            then tell us the problem by voice or text.
          </li>
        </ul>

        <p className="intro-note">
          We&apos;ll walk you through the safe fixes step by step. If a job looks risky, we&apos;ll warn you
          and suggest a handyman, and you can still go ahead at your own risk. Your history stays on
          this phone.
        </p>

        <button ref={okRef} type="button" className="btn-primary" onClick={close}>
          Got it
        </button>
      </div>
    </div>
  );
}
