"use client";

/* Past jobs on this device: a list, and each job reopened with its
   verdict, steps, before/after and the "what to tell them" card.
   Everything comes from lib/history.ts (localStorage + IndexedDB). */

import { useEffect, useState } from "react";
import { BriefCard } from "./CallAPro";
import { clearHistory, getMedia, listJobs } from "../lib/history";
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

const OUTCOME: Record<string, string> = {
  fixed: "Fixed",
  "still broken": "Still broken",
  "called a pro": "Called a pro",
};

/* One past run, the same way the walkthrough showed it: a summary
   first (verdict, outcome, before/after), the steps one at a time with
   the picture the owner saw, and the diagnosis to share on request. */
function JobView({ job, onBack }: { job: Job; onBack: () => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<{ before?: File; clip?: File }>({});
  const [screen, setScreen] = useState<"summary" | "steps" | "share">("summary");
  const [idx, setIdx] = useState<number>(0);

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

  const title = job.verdict === "pro" ? "Call a pro" : job.riskAccepted ? "At your own risk" : "You can fix this";
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

      {screen !== "share" && (stepPicture || urls.before) && (
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
            <section className={`verdict-card ${job.verdict || ""}`}>
              <p className="verdict-title">{title}</p>
              <p className="verdict-finding">{job.verdict === "pro" ? job.ruleTitle : job.headline}</p>
              {job.outcome && <p className="verdict-line">Outcome: {OUTCOME[job.outcome] || job.outcome}</p>}
              {job.riskAccepted && (
                <p className="verdict-line">Done at the owner&apos;s own risk.</p>
              )}
            </section>
            {urls.after && (
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
          </>
        )}

        {screen === "steps" && step && (
          <section className="step-card">
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
            {step.caution && (
              <div className="callout callout-dont-touch">
                <p className="sheet-label">Careful</p>
                <p>{step.caution}</p>
              </div>
            )}
          </section>
        )}

        {screen === "share" && (
          <BriefCard
            brief={{
              device: job.device,
              issue: job.issue,
              finding: job.finding || job.headline,
              rule: job.verdict === "pro" ? job.ruleTitle : null,
              checks: [...job.answers.map((a) => `${a.ask} ${a.reply}`), ...job.steps.map((st) => st.check)],
              sound: job.sound,
              photo: files.before || null,
              clip: files.clip || null,
            }}
          />
        )}
      </div>

      <div className="walk-cta">
        {screen === "summary" && job.steps.length > 0 && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setIdx(0);
              setScreen("steps");
            }}
          >
            See the {job.steps.length} step{job.steps.length === 1 ? "" : "s"}
          </button>
        )}
        {screen === "summary" && (
          <button type="button" className="btn-outline" onClick={() => setScreen("share")}>
            Share diagnosis
          </button>
        )}
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

  if (open) return <JobView job={open} onBack={() => setOpen(null)} />;

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
                        {j.outcome ? OUTCOME[j.outcome] || j.outcome : "No outcome yet"}
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
