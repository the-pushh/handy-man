/* Outcome feedback (experimental, backend/feedback.py). Shown only when
   the build has NEXT_PUBLIC_FEEDBACK=1 or the URL says ?feedback=1
   (?feedback=0 hides it). Nothing is sent unless the owner ticks "Help
   improve Handyman"; the choice is remembered in this browser and can
   be unticked any time. Text only: never photos, sound or location. */

import { fetchJSON } from "./net";
import { userId } from "./userId";

const FLAG = "handyman-feedback";
const CONSENT = "handyman-share";

export function feedbackOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("feedback");
    if (q === "1" || q === "0") window.localStorage.setItem(FLAG, q);
    const saved = window.localStorage.getItem(FLAG);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    /* fall through */
  }
  return process.env.NEXT_PUBLIC_FEEDBACK === "1";
}

export function sharing(): boolean {
  try {
    return window.localStorage.getItem(CONSENT) === "1";
  } catch {
    return false;
  }
}

export function setSharing(on: boolean): void {
  try {
    window.localStorage.setItem(CONSENT, on ? "1" : "0");
  } catch {
    /* not remembered; this run still follows the tick */
  }
}

export interface RunFeedback {
  id: string;
  parent_id: string | null;
  machine: string;
  said: string;
  route: string;
  finding: string;
  verdict: string;
  rule: string | null;
  outcome: "fixed" | "still broken" | "handyman" | "fixed by quick check" | "";
  fixed_by: string;
  confirmed: boolean | null;
  recheck: string;
  tests: string[];
  answers: string;
  app: string;
}

/* Send (or update) one run's outcome. Fire and forget: feedback never
   slows or breaks a fix. */
export function sendFeedback(base: string, run: RunFeedback): void {
  if (!feedbackOn() || !sharing() || !run.id) return;
  void fetchJSON(
    `${base}/api/feedback`,
    {
      method: "POST",
      // The browser ID lets "Delete my history" remove these rows too.
      headers: { "Content-Type": "application/json", "x-handyman-user": userId() || "" },
      body: JSON.stringify(run),
    },
    { label: "feedback", timeoutMs: 10000 }
  ).catch(() => undefined);
}
