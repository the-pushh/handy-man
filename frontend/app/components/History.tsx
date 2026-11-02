"use client";

/* Past jobs on this device: a list, and each job reopened with its
   verdict, steps, before/after and the "what to tell them" card.
   Everything comes from lib/history.ts (localStorage + IndexedDB). */

import { useEffect, useState } from "react";
import CallAPro, { BriefCard, ProList } from "./CallAPro";
import { resolveApiBase, IS_PROD } from "../lib/apiBase";
import CautionPin from "./CautionPin";
import { clearHistory, getMedia, listJobs, updateJob } from "../lib/history";
import type { Job, MediaKind } from "../lib/history";

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (_) {
    return iso;
  }
}

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

const OUTCOME: Record<string, string> = {
  fixed: "Fixed",
  "still broken": "Still broken",
  "called a pro": "Called a pro",
};

/* One past run, the same way the walkthrough showed it: a summary
   first (verdict, outcome, before/after), the steps one at a time with
   the picture the owner saw, and the diagnosis to share on request. */
function apiBase(): string {
  if (IS_PROD) return "";
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem("handyman-api-base");
  } catch (_) {
    // Storage unavailable.
  }
  return resolveApiBase(process.env.NEXT_PUBLIC_API_BASE, stored, window.location.hostname);
}

/* What closed this run, in a few words, for the top of the run view. */
function closedBy(job: Job, next: Job | undefined): { title: string; line: string; tone: string } {
  if (job.contacted) {
    return {
      title: `${job.contacted.how === "call" ? "Called" : "Texted"} ${job.contacted.name}`,
      line: `${job.prosTrade || "Technician"} · ${when(job.contacted.at)}`,
      tone: "",
    };
  }
  if (job.outcome === "fixed") return { title: "Fixed", line: "You confirmed it works after the fix.", tone: "diy" };
  if (job.outcome === "still broken") {
    return {
      title: "Still broken",
      line: next ? `Tried again in run ${next.attempt || 2}.` : "Not fixed by this run.",
      tone: "pro",
    };
  }
  if (job.outcome === "called a pro") {
    return { title: "Sent to a technician", line: "Looked for someone nearby to fix it.", tone: "" };
  }
  return { title: "Not finished", line: "Closed before the final check.", tone: "" };
}

function JobView({ job, next, onBack }: { job: Job; next?: Job; onBack: () => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<{ before?: File; clip?: File }>({});
  const [screen, setScreen] = useState<"summary" | "steps" | "share" | "pros" | "compare">("summary");
  const [idx, setIdx] = useState<number>(0);
  // The technicians saved with this run (or found from here and saved).
  const [saved, setSaved] = useState(job.pros);

  useEffect(() => {
    let live = true;
    const made: string[] = [];
    void (async () => {
      const kinds = ["before", "after", "clip", ...job.steps.map((_, i) => `step${i}`)] as MediaKind[];
      const blobs = await Promise.all(kinds.map((k) => (job.media[k] ? getMedia(job.id, k) : null)));
      if (!live) return;
      const out: Record<string, string> = {};
      blobs.forEach((b, i) => {
        if (b && kinds[i] !== "clip") {
          const u = URL.createObjectURL(b);
          made.push(u);
          out[kinds[i]] = u;
        }
      });
      const before = blobs[0];
      const clip = blobs[2];
      setUrls(out);
      setFiles({
        before: before ? new File([before], "before.jpg", { type: before.type || "image/jpeg" }) : undefined,
        clip: clip ? new File([clip], "sound.wav", { type: clip.type || "audio/wav" }) : undefined,
      });
    })();
    return () => {
      live = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [job]);

  const closed = closedBy(job, next);
  const trade = job.prosTrade || job.trade || "technician";
  const contact = (p: { name: string; phone: string | null }, how: "call" | "text") =>
    updateJob(job.id, {
      outcome: "called a pro",
      contacted: { name: p.name, phone: p.phone, how, at: new Date().toISOString() },
    });
  const brief = {
    device: job.device,
    issue: job.issue,
    finding: job.finding || job.headline,
    rule: job.verdict === "pro" ? job.ruleTitle : null,
    checks: [...job.answers.map((a) => `${a.ask} ${a.reply}`), ...job.steps.map((st) => st.check)],
    sound: job.sound,
    photo: files.before || null,
    clip: files.clip || null,
  };
  const step = job.steps[idx];
  const stepPicture = urls[`step${idx}`] || urls.before || "";
  const back = () => (screen === "summary" ? onBack() : setScreen("summary"));

  return (
    <section className="walk screened">
      <header className="walk-bar">
        <button type="button" className="walk-icon" onClick={back} aria-label="Back">
          ←
        </button>
        <div className="walk-title">
          <p className="sheet-label">
            {job.machine || job.device} · run {job.attempt || 1} · {when(job.date)}
          </p>
          <p className="walk-said">&ldquo;{job.issue}&rdquo;</p>
        </div>
        <span className="walk-icon-space" />
      </header>

      {(screen === "summary" || screen === "steps") && (stepPicture || urls.before) && (
        <figure className="walk-photo">
          <div className="photo-box">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={screen === "steps" ? stepPicture : urls.before} alt={job.device} />
          </div>
          <figcaption>
            {screen === "steps"
              ? urls[`step${idx}`]
                ? `Highlighted: ${step?.part || "this step"}`
                : job.steps.some((_, i) => job.media[`step${i}` as MediaKind])
                  ? "No part to highlight on this step"
                  : "This run was saved before step pictures were kept"
              : "Before"}
          </figcaption>
        </figure>
      )}

      <div className="walk-body">
        {screen === "summary" && (
          <>
            {/* What closed this run, then the diagnosis in one line. */}
            <section className={`verdict-card ${closed.tone}`}>
              <p className="verdict-title">{closed.title}</p>
              <p className="verdict-line">{closed.line}</p>
              <p className="verdict-line">
                <span className={`pill ${job.verdict || ""}`}>
                  {job.verdict === "pro" ? "Pro" : job.riskAccepted ? "Own risk" : "DIY"}
                </span>{" "}
                {job.verdict === "pro" ? job.ruleTitle : job.headline}
              </p>
            </section>
            <div className="run-actions">
              {job.steps.length > 0 && (
                <button type="button" className="btn-outline" onClick={() => { setIdx(0); setScreen("steps"); }}>
                  See the {job.steps.length} step{job.steps.length === 1 ? "" : "s"}
                </button>
              )}
              <button type="button" className="btn-outline" onClick={() => setScreen("pros")}>
                {cap(trade)} nearby{(saved || []).length ? ` (${saved!.length})` : ""}
              </button>
              {urls.after && (
                <button type="button" className="btn-outline" onClick={() => setScreen("compare")}>
                  Before &amp; after
                </button>
              )}
              <button type="button" className="btn-outline" onClick={() => setScreen("share")}>
                Share diagnosis
              </button>
            </div>
          </>
        )}

        {screen === "compare" && (
          <section className="history-card">
            <div className="before-after">
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={urls.before} alt="before" />
                <figcaption>Before</figcaption>
              </figure>
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={urls.after} alt="after" />
                <figcaption>After</figcaption>
              </figure>
            </div>
            {job.recheck && (
              <p className="verdict-line">
                {job.recheck.looksFixed === true ? "✓ " : job.recheck.looksFixed === false ? "✗ " : ""}
                {job.recheck.seen}
              </p>
            )}
          </section>
        )}

        {screen === "pros" && ((saved || []).length > 0 ? (
          <section className="call-pro">
            <p className="sheet-label">{cap(trade)} found for this diagnosis</p>
            <ProList pros={saved!} brief={brief} onContact={contact} />
            <p className="evidence-note places-credit">Listings from Google Maps, saved with this run.</p>
          </section>
        ) : (
          // Never searched during the run: search now, near where the
          // owner is, and keep the list with this run.
          <CallAPro
            api={apiBase()}
            trade={trade}
            brief={brief}
            onFound={(pros) => {
              updateJob(job.id, { pros, prosTrade: trade });
              setSaved(pros);
            }}
            onContact={contact}
          />
        ))}

        {screen === "steps" && step && (
          <section className={`step-card${step.caution ? " has-caution" : ""}`}>
            <div className="step-top">
              <p className="sheet-label">
                {job.verdict === "pro" ? "Safe check" : "Step"} {idx + 1} of {job.steps.length}
              </p>
              <div className="ticks">
                {job.steps.map((_, i) => (
                  <span key={i} className={i < idx ? "tick done" : i === idx ? "tick active" : "tick"} />
                ))}
              </div>
            </div>
            <p className="instruction">{step.check}</p>
            {step.how && <p className="step-how">{step.how}</p>}
            {step.caution && <CautionPin text={step.caution} />}
          </section>
        )}

        {screen === "share" && <BriefCard brief={brief} />}
      </div>

      <div className="walk-cta">
        {screen === "steps" && (
          <>
            <button type="button" className="btn-outline" onClick={() => (idx === 0 ? setScreen("summary") : setIdx(idx - 1))}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => (idx < job.steps.length - 1 ? setIdx(idx + 1) : setScreen("summary"))}
            >
              {idx < job.steps.length - 1 ? "Next step" : "Done"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/* One group per machine (the item the owner named), newest group first;
   inside it every run, newest first. */
function byMachine(jobs: Job[]): { key: string; title: string; jobs: Job[] }[] {
  const groups = new Map<string, { key: string; title: string; jobs: Job[] }>();
  for (const j of jobs) {
    const title = (j.machine || j.device || "device").trim();
    const key = title.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, title: title[0].toUpperCase() + title.slice(1), jobs: [] });
    groups.get(key)!.jobs.push(j);
  }
  const newest = (g: { jobs: Job[] }) => Math.max(...g.jobs.map((j) => Date.parse(j.date) || 0));
  return [...groups.values()]
    .map((g) => ({ ...g, jobs: [...g.jobs].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)) }))
    .sort((a, b) => newest(b) - newest(a));
}

export default function History({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<Job | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setJobs(listJobs());
  }, []);

  if (open) {
    return (
      <JobView
        job={open}
        next={jobs.find((j) => j.parentId === open.id)}
        onBack={() => {
          setJobs(listJobs());
          setOpen(null);
        }}
      />
    );
  }

  return (
    <section className="walk screened">
      <header className="walk-bar">
        <div className="walk-title">
          <p className="history-title">History</p>
          <p className="sheet-label">On this phone only</p>
        </div>
        <button type="button" className="walk-icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="walk-body">
        {jobs.length === 0 ? (
          <p className="instruction">No fixes yet. Tap the button on the camera screen and say what&apos;s broken.</p>
        ) : (
          byMachine(jobs).map((g) => (
            // One card per machine: its name heads the card, its runs are
            // rows inside it, newest first.
            <section key={g.key} className="history-group">
              <header className="history-machine">
                <span className="history-machine-name">{g.title}</span>
                <span className="history-machine-count">
                  {g.jobs.length} run{g.jobs.length === 1 ? "" : "s"}
                </span>
              </header>
              <ol className="history-list">
                {g.jobs.map((j) => (
                  <li key={j.id}>
                    <button type="button" className="history-row" onClick={() => setOpen(j)}>
                      <span className="history-top">
                        <span className={`pill ${j.verdict || ""}`}>
                          {j.verdict === "diy" ? (j.riskAccepted ? "Own risk" : "DIY") : j.verdict === "pro" ? "Pro" : "—"}
                        </span>
                        <strong>Run {j.attempt || 1}</strong>
                        <span className="history-when">{when(j.date)}</span>
                      </span>
                      <span className="history-finding">{j.headline || j.issue}</span>
                      <span className="history-outcome">
                        {j.contacted
                          ? `${j.contacted.how === "call" ? "Called" : "Texted"} ${j.contacted.name}`
                          : j.outcome
                            ? OUTCOME[j.outcome] || j.outcome
                            : "No outcome yet"}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
      </div>

      {jobs.length > 0 && (
        <div className="walk-cta">
          <button
            type="button"
            className={confirming ? "btn-primary" : "btn-outline"}
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              await clearHistory();
              setJobs([]);
              setConfirming(false);
            }}
          >
            {confirming ? "Tap again to clear all history" : "Clear history"}
          </button>
        </div>
      )}
    </section>
  );
}
