"use client";

/* Pull-up panel on every screen: each model call this session made,
   newest first: model, purpose, latency, input thumbnail, SAM mask,
   parsed response. "Export session trace" saves it all as JSON.
   Hidden by default; open the app with ?trace in the URL to show it
   (e.g. to export a trace for a case). */

import { useEffect, useState } from "react";
import { exportTrace, installFetchTap, subscribe } from "../lib/traceStore";
import type { TraceRecord } from "../lib/traceStore";

function secs(ms: number | null): string {
  return ms == null ? "…" : `${(ms / 1000).toFixed(1)}s`;
}

function tokens(r: TraceRecord): string {
  const u = r.usage as
    | { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
    | null;
  if (!u) return "";
  const i = u.prompt_tokens ?? u.input_tokens;
  const o = u.completion_tokens ?? u.output_tokens;
  return i != null && o != null ? `${i}→${o} tok` : "";
}

function short(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
    return s.length > 1400 ? s.slice(0, 1400) + "\n…" : s;
  } catch (_) {
    return String(v);
  }
}

function Row({ r }: { r: TraceRecord }) {
  const [open, setOpen] = useState(false);
  const thumb = r.mask_thumb || r.output_thumb;
  return (
    <li className={`trace-row ${r.status}`}>
      <button type="button" className="trace-head" onClick={() => setOpen(!open)}>
        <span className="trace-model">{r.model}</span>
        <span className="trace-lat">{secs(r.latency_ms)}</span>
        <span className="trace-purpose">{r.purpose}</span>
        <span className="trace-meta">
          {new Date(r.at).toLocaleTimeString()} · {r.endpoint}
          {tokens(r) && ` · ${tokens(r)}`}
          {r.effort ? ` · effort ${r.effort}` : ""}
          {r.status === "error" ? " · ERROR" : ""}
        </span>
      </button>
      {(r.input_thumb || thumb) && (
        <div className="trace-thumbs">
          {r.input_thumb && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.input_thumb} alt="model input" />
              <figcaption>input</figcaption>
            </figure>
          )}
          {thumb && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb} alt={r.mask_thumb ? "SAM mask" : "output"} />
              <figcaption>{r.mask_thumb ? "SAM 3.1 mask" : "output"}</figcaption>
            </figure>
          )}
        </div>
      )}
      {open && (
        <div className="trace-body">
          {r.request_text && (
            <>
              <p className="sheet-label">Prompt</p>
              <pre>{r.request_text}</pre>
            </>
          )}
          <p className="sheet-label">Parsed response</p>
          <pre>{short(r.parsed ?? r.raw_text ?? r.error ?? "(none)")}</pre>
          {r.error && (
            <>
              <p className="sheet-label">Error</p>
              <pre>{r.error}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function TraceDrawer() {
  const [records, setRecords] = useState<TraceRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let on = false;
    try {
      on = new URLSearchParams(window.location.search).has("trace");
    } catch (_) {
      on = false;
    }
    if (!on) return;
    setShown(true);
    // Reserve the bottom strip for the handle only while it's shown.
    document.documentElement.classList.add("with-trace");
    installFetchTap();
    const off = subscribe(setRecords);
    return () => {
      off();
      document.documentElement.classList.remove("with-trace");
    };
  }, []);

  if (!shown) return null;

  const models = records.filter((r) => r.kind === "model");
  const latest = models[models.length - 1];
  const sorted = records.slice().reverse();

  return (
    <aside className={`trace-drawer${open ? " open" : ""}`} aria-label="Model call trace">
      <button type="button" className="trace-handle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="trace-grip" aria-hidden="true" />
        <span className="trace-handle-text">
          {models.length} call{models.length === 1 ? "" : "s"}
          {latest ? ` · ${latest.model} ${secs(latest.latency_ms)}` : " · model trace"}
        </span>
      </button>
      {open && (
        <div className="trace-panel">
          <div className="trace-actions">
            <button type="button" className="btn-primary" onClick={exportTrace} disabled={!records.length}>
              Export session trace
            </button>
            <button type="button" className="btn-outline" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {!records.length && <p className="evidence-note">No model calls yet. Point the camera and say what&apos;s wrong.</p>}
          <ol className="trace-list">
            {sorted.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}
