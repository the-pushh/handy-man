"use client";

/* The app is portrait-only. A web page cannot truly lock rotation, so:
   1. ask the browser to lock portrait (works on Android when installed
      or fullscreen; iOS ignores it, so failures are silent),
   2. the web manifest says portrait for the installed app,
   3. on a phone held sideways, cover the app with a "turn it upright"
      card (CSS only: touch screens in landscape that are phone-height).
   Nothing is reset underneath: turn the phone back and it carries on. */

import { useEffect } from "react";

export default function OrientationGuard() {
  useEffect(() => {
    const o = (screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
    try {
      void o?.lock?.("portrait").catch(() => undefined);
    } catch {
      /* not supported here */
    }
  }, []);
  return (
    <div className="rotate-guard" role="alert" aria-live="assertive">
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        <rect x="14" y="6" width="20" height="36" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M40 30a14 14 0 0 1-12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M28 38l0 4 4 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p>Turn your phone upright</p>
      <span>Handyman works in portrait.</span>
    </div>
  );
}
