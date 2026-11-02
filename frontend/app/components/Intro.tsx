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
          Point your phone at something that&apos;s acting up and say what&apos;s wrong. Handyman runs the
          quick checks people miss, walks you through a safe fix, or finds a technician nearby.
        </p>

        <ul className="intro-list">
          <li>
            <strong>Tap to speak.</strong> Name the machine and what it does or doesn&apos;t do:
            &ldquo;AC runs but the air isn&apos;t cold&rdquo;.
          </li>
          <li>
            <strong>Skip &ldquo;it&apos;s broken&rdquo;</strong> or &ldquo;not working&rdquo;. The more
            you describe, the better the fix.
          </li>
          <li>
            <strong>Type</strong> if you can&apos;t talk right now, or send a <strong>Photo</strong> if
            the camera isn&apos;t working.
          </li>
        </ul>

        <p className="intro-note">
          Advice only. Unplug before you touch anything, and stop if you see smoke, sparks, a swollen
          battery or smell gas. Anything you do is at your own risk. History stays on this phone.
        </p>

        <button ref={okRef} type="button" className="btn-primary" onClick={close}>
          Got it
        </button>
      </div>
    </div>
  );
}
