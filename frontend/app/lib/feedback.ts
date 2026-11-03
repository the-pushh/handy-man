/* Outcome feedback (backend/feedback.py), on by default for every run in
   both flows: how it ended (fixed, at which step or quick check, still
   broken, handyman), the owner's "Was it ...?", the route, tests and
   answers. Words only: never photos, sound or location. The welcome
   card says so; History has an off switch, and "Delete my history"
   removes these rows. The server stores nothing without a database. */

import { fetchJSON } from "./net";
import { userId } from "./userId";

const OPT_OUT = "handyman-share";

/* True unless the owner turned learning off in History. */
export function sharing(): boolean {
  try {
    return window.localStorage.getItem(OPT_OUT) !== "0";
  } catch {
    return true;
  }
}

export function setSharing(on: boolean): void {
  try {
    window.localStorage.setItem(OPT_OUT, on ? "1" : "0");
  } catch {
    /* not remembered */
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
  if (!sharing() || !run.id) return;
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
