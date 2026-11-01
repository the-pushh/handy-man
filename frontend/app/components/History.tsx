"use client";

/* Past jobs on this device: a list, and each job reopened with its
   verdict, steps, before/after and the "what to tell them" card.
   Everything comes from lib/history.ts (localStorage + IndexedDB). */

import { useEffect, useMemo, useState } from "react";
import { BriefCard } from "./CallAPro";
import { clearHistory, getMedia, listJobs } from "../lib/history";
import type { Job } from "../lib/history";

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

function JobView({ job, onBack }: { job: Job; onBack: () => void }) {
  const [media, setMedia] = useState<{ before?: File; after?: File; clip?: File }>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [b, a, c] = await Promise.all([
        job.media.before ? getMedia(job.id, "before") : null,
        job.media.after ? getMedia(job.id, "after") : null,
        job.media.clip ? getMedia(job.id, "clip") : null,
      ]);
      if (!live) return;
      setMedia({
        before: b ? new File([b], "before.jpg", { type: b.type || "image/jpeg" }) : undefined,
        after: a ? new File([a], "after.jpg", { type: a.type || "image/jpeg" }) : undefined,
        clip: c ? new File([c], "sound.wav", { type: c.type || "audio/wav" }) : undefined,
      });
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [job]);

  const [beforeURL, afterURL] = useMemo(
    () => [media.before, media.after].map((f) => (f ? URL.createObjectURL(f) : "")),
    [media]
  );
  useEffect(
    () => () => {
      for (const u of [beforeURL, afterURL]) if (u) URL.revokeObjectURL(u);
    },
    [beforeURL, afterURL]
  );

  return (
    <section className="walk">
      <button type="button" className="btn-outline" onClick={onBack}>
        ← All jobs
      </button>
      <header className="walk-head" style={{ marginTop: 12 }}>
        <p className="sheet-label">
          {job.device} · {when(job.date)}
        </p>
        <p className="walk-said">&ldquo;{job.issue}&rdquo;</p>
      </header>

      {job.verdict && (
        <section className={`verdict-card ${job.verdict}`}>
          <p className="verdict-title">{job.verdict === "diy" ? "You can fix this" : "Call a pro"}</p>
          <p className="verdict-finding">{job.verdict === "pro" ? job.ruleTitle : job.headline}</p>
          {job.rule && <p className="evidence-note">Safety rule: {job.rule}</p>}
          {job.outcome && <p className="sheet-label">Outcome: {OUTCOME[job.outcome] || job.outcome}</p>}
        </section>
      )}

      {job.answers.length > 0 && (
        <ul className="checklist" style={{ marginTop: 12 }}>
          {job.answers.map((a, i) => (
            <li key={i} className="done">
              <span aria-hidden="true">✓</span> {a.ask} <strong>{a.reply}</strong>
            </li>
          ))}
        </ul>
      )}

      {job.steps.length > 0 && (
        <section className="step-card">
          <p className="sheet-label">{job.verdict === "pro" ? "Safe checks" : "Steps"}</p>
          <ol className="history-steps">
            {job.steps.map((s, i) => (
              <li key={i}>
                <strong>{s.check}</strong>
                {s.how && <p>{s.how}</p>}
                {s.caution && <p className="history-caution">Careful: {s.caution}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {(beforeURL || afterURL) && (
        <section className="done-card">
          <div className="before-after">
            <figure>
              {beforeURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={beforeURL} alt="before" />
              ) : (
                <div className="after-missing">No photo</div>
              )}
              <figcaption>Before</figcaption>
            </figure>
            <figure>
              {afterURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={afterURL} alt="after" />
              ) : (
                <div className="after-missing">Not checked</div>
              )}
              <figcaption>After</figcaption>
            </figure>
          </div>
          {job.recheck && (
            <p className="done-result">
              {job.recheck.looksFixed === true ? "✓ " : job.recheck.looksFixed === false ? "✗ " : ""}
              {job.recheck.seen}
            </p>
          )}
        </section>
      )}

      {loaded && (
        <div style={{ marginTop: 12 }}>
          <BriefCard
            brief={{
              device: job.device,
              issue: job.issue,
              finding: job.finding || job.headline,
              rule: job.verdict === "pro" ? job.ruleTitle : null,
              checks: [...job.answers.map((a) => `${a.ask} ${a.reply}`), ...job.steps.map((s) => s.check)],
              sound: job.sound,
              photo: media.before || null,
              clip: media.clip || null,
            }}
          />
        </div>
      )}
    </section>
  );
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
    <section className="walk">
      <div className="row" style={{ marginTop: 0, alignItems: "center" }}>
        <h1 className="history-title">History</h1>
        <button type="button" className="btn-outline" style={{ flex: "0 0 auto" }} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="evidence-note">History stays on this device only.</p>

      {jobs.length === 0 ? (
        <p className="instruction" style={{ marginTop: 16 }}>
          No jobs yet. Point the camera at something broken to start.
        </p>
      ) : (
        <ol className="history-list">
          {jobs.map((j) => (
            <li key={j.id}>
              <button type="button" className="history-row" onClick={() => setOpen(j)}>
                <span className={`pill ${j.verdict || ""}`}>
                  {j.verdict === "diy" ? "DIY" : j.verdict === "pro" ? "Pro" : "—"}
                </span>
                <span className="history-main">
                  <strong>{j.device}</strong>
                  <span>{j.headline || j.issue}</span>
                </span>
                <span className="history-meta">
                  {when(j.date)}
                  {j.outcome && <em>{OUTCOME[j.outcome] || j.outcome}</em>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {jobs.length > 0 && (
        <button
          type="button"
          className={confirming ? "btn-primary" : "btn-outline"}
          style={{ marginTop: 16, width: "100%" }}
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
      )}
    </section>
  );
}
