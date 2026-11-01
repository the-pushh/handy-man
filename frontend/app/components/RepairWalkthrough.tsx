"use client";

/* Photo repair walkthrough: image in -> Muse Spark names components,
   Muse Image highlights them step by step with an IKEA-style legend,
   spoken thinking throughout. Embedded in the main app's repair view. */

import { useEffect, useRef, useState } from "react";
import { resolveApiBase } from "../lib/apiBase";
import { mark, turnElapsed } from "../lib/timeline";
import { requestDiagnosis } from "../lib/diagnosis";
import type { Heard } from "../lib/recorder";
import CallAPro from "./CallAPro";

/* The rules layer's decision (backend/risk.py): the model proposes
   steps, the rules decide which an owner may do. */
interface Verdict {
  verdict: "diy" | "pro";
  rule: string | null;
  title: string | null;
  headline: string;
  trade: string | null;
  fired: string[];
  blocked_steps: number[];
  proposed_steps: number;
}

interface Instance {
  label: string;
  score: number | null;
  box: { x: number; y: number; w: number; h: number };
  mask_png_b64: string;
  mask_w: number;
  mask_h: number;
}

interface Question {
  ask: string;
  part: string | null;
  options: string[];
}

const ORANGE = "#e86a17";

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export default function RepairWalkthrough({
  files,
  issue,
  perception,
  prefetched,
  heard,
  onListen,
  onMoreViews,
  onRecheck,
  onClose,
}: {
  files: File[];
  issue: string;
  perception?: unknown;
  // Diagnosis already started during the device confirmation.
  prefetched?: Promise<unknown> | null;
  // What the mic caught: measured features + Muse Wonder's hearing.
  heard?: Heard | null;
  onListen?: () => void;
  onMoreViews?: () => void;
  // Final camera re-check: aim at the part, returns the "after" still.
  onRecheck?: (part: string | null) => Promise<File | null>;
  onClose: () => void;
}) {
  const [imgURL, setImgURL] = useState<string>("");
  const [stillURLs, setStillURLs] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [instances, setInstances] = useState<Instance[]>([]);
  const [status, setStatus] = useState<string>("");
  const [overlayURL, setOverlayURL] = useState<string>("");
  const [causes, setCauses] = useState<string[]>([]);
  const [steps, setSteps] = useState<
    { check: string; how: string; part: string | null; caution?: string | null }[]
  >([]);
  const [legend, setLegend] = useState<{ label: string; color: string; tag?: string }[]>([]);
  const [resolution, setResolution] = useState<string>("");
  const [device, setDevice] = useState<string>("");
  const [ask, setAsk] = useState<string>("");
  const [safety, setSafety] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [inventory, setInventory] = useState<
    { label: string; color?: string | null; condition?: string | null; position?: string | null }[]
  >([]);
  const [details, setDetails] = useState<{
    serial?: string | null;
    color?: string | null;
    condition?: string | null;
    markings?: string[];
    other?: string[];
  }>({});
  const [stepIdx, setStepIdx] = useState<number>(0);
  const [stepLoading, setStepLoading] = useState<boolean>(false);
  const [fixed, setFixed] = useState<boolean>(false);
  const [booking, setBooking] = useState<boolean>(false);
  // Done screen: before/after stills, Spark's re-check, time taken.
  const [done, setDone] = useState<{
    afterURL: string;
    state: "checking" | "ok" | "error";
    looksFixed: boolean | null;
    seen: string;
    next: string | null;
    seconds: number;
  } | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  // Look-only questions whose answer can flip the verdict, asked one at
  // a time before it; answered ones stay as a ticked checklist.
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answered, setAnswered] = useState<{ ask: string; reply: string }[]>([]);
  const answerResolve = useRef<((a: { ask: string; reply: string }[]) => void) | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<File | null>(null);

  /* Indices of SAM instances that belong to a step's part. */
  function masksFor(part: string | null | undefined, list: Instance[]): number[] {
    if (!part) return [];
    const want = part.toLowerCase();
    return list.flatMap((inst, i) => (inst.label.toLowerCase() === want ? [i] : []));
  }

  /* Show only the current step's SAM masks (all of them when the step
     names no part). Returns whether SAM covered this part. */
  function showStepMasks(part: string | null | undefined, list: Instance[]): boolean {
    const mine = masksFor(part, list);
    const hide = new Set<number>(
      part ? list.map((_, i) => i).filter((i) => !mine.includes(i)) : []
    );
    setHidden(hide);
    void drawMasks(list, hide);
    return mine.length > 0;
  }

  async function drawMasks(list: Instance[], hide: Set<number>) {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    await new Promise<void>((res) => {
      if (img.complete && img.naturalWidth) res();
      else img.onload = () => res();
    });
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [i, inst] of list.entries()) {
      if (hide.has(i)) continue;
      const color = ORANGE;
      const m = new Image();
      await new Promise<void>((res) => {
        m.onload = () => res();
        m.src = `data:image/png;base64,${inst.mask_png_b64}`;
      });
      const off = document.createElement("canvas");
      off.width = inst.mask_w;
      off.height = inst.mask_h;
      const octx = off.getContext("2d");
      if (!octx) continue;
      octx.drawImage(m, 0, 0);
      octx.globalCompositeOperation = "source-in";
      octx.fillStyle = color + "aa";
      octx.fillRect(0, 0, off.width, off.height);
      const b = inst.box;
      ctx.drawImage(
        off,
        b.x * canvas.width,
        b.y * canvas.height,
        b.w * canvas.width,
        b.h * canvas.height
      );
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, canvas.width / 300);
      ctx.strokeRect(
        b.x * canvas.width,
        b.y * canvas.height,
        b.w * canvas.width,
        b.h * canvas.height
      );
      ctx.fillStyle = color;
      ctx.font = `${Math.max(14, canvas.width / 40)}px sans-serif`;
      ctx.fillText(
        inst.score != null ? `${inst.label} ${Math.round(inst.score * 100)}%` : inst.label,
        b.x * canvas.width + 4,
        Math.max(14, b.y * canvas.height - 6)
      );
    }
  }

  // Backend base URL. Default: same host as the page on port 8000
  // (works from a phone on the LAN). Build-time override via
  // NEXT_PUBLIC_API_BASE; per-browser override below (localStorage)
  // wins — set it once from the phone when tunnel URLs rotate.
  function defaultAPI(): string {
    if (typeof window === "undefined") return "http://127.0.0.1:8000";
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem("handyman-api-base");
    } catch (_) {
      // Storage unavailable; fall through to the default.
    }
    return resolveApiBase(
      process.env.NEXT_PUBLIC_API_BASE,
      saved,
      window.location.hostname
    );
  }
  const [apiBase, setApiBase] = useState<string>("");
  const [needBase, setNeedBase] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const API = apiBase || defaultAPI();

  const [said, setSaid] = useState<string[]>([]);
  // Serial speech: every line waits for the previous audio to finish,
  // so lines never overlap.
  const speechQueue = useRef<Promise<void>>(Promise.resolve());
  // Latest-run-wins: a stale analysis response (e.g. StrictMode's double
  // effect in dev) must not clobber fresh state like the risk decision.
  const runSeq = useRef<number>(0);

  // Pipelined speech: each line's audio is synthesised the moment it is
  // queued, and plays when the previous line finishes. So step 1 is
  // ready to play as soon as the verdict renders, never waiting on a
  // synthesis round-trip after the line before it.
  // Synthesis runs in queue order (one at a time, ahead of playback):
  // parallel requests competed for the CPU and the first line finished
  // last.
  const synthQueue = useRef<Promise<unknown>>(Promise.resolve());

  function say(line: string, maxSeconds?: number): Promise<void> {
    setSaid((prev) => [...prev, line]);
    const audio = synthQueue.current.then(() => fetchSpeech(line, maxSeconds));
    synthQueue.current = audio.catch(() => null);
    speechQueue.current = speechQueue.current
      .then(() => audio)
      .then((url) => playSpeech(url, line))
      .catch(() => {});
    return speechQueue.current;
  }

  // One pinned browser voice for the whole session, so the fallback
  // never alternates between profiles.
  const fallbackVoice = useRef<SpeechSynthesisVoice | null | undefined>(undefined);

  function pickVoice(): SpeechSynthesisVoice | null {
    if (fallbackVoice.current) return fallbackVoice.current;
    const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    if (!voices.length) return null; // try again next line; don't cache emptiness
    voices.sort((a, b) => a.name.localeCompare(b.name));
    fallbackVoice.current = voices[0];
    return fallbackVoice.current;
  }

  /* MMS-TTS audio for a line as an object URL, or null (browser voice). */
  async function fetchSpeech(line: string, maxSeconds?: number): Promise<string | null> {
    mark("tts request", JSON.stringify(line.slice(0, 40)));
    try {
      const r = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, lang: "en", max_seconds: maxSeconds ?? null }),
      });
      const data = await r.json();
      mark("tts audio received", data.audio_b64 ? "" : "fallback");
      if (!data.audio_b64) return null;
      const bytes = Uint8Array.from(atob(data.audio_b64), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type: data.mime || "audio/wav" }));
    } catch (_) {
      return null;
    }
  }

  async function playSpeech(url: string | null, line: string): Promise<void> {
    mark("tts playback start", JSON.stringify(line.slice(0, 40)));
    if (url) {
      await new Promise<void>((res) => {
        const done = () => {
          mark("tts playback ended");
          res();
        };
        const a = new Audio(url);
        a.onended = done;
        a.onerror = done;
        setTimeout(done, 120000);
        a.play().catch(done);
      });
      URL.revokeObjectURL(url);
      return;
    }
    await new Promise<void>((res) => {
      const done = () => res();
      const u = new SpeechSynthesisUtterance(line);
      u.lang = "en-US";
      u.rate = 1;
      u.pitch = 1;
      const v = pickVoice();
      if (v) u.voice = v;
      u.onend = done;
      u.onerror = done;
      setTimeout(done, 120000);
      window.speechSynthesis.speak(u);
    });
  }

  // System-captured stills: analysis starts on its own, no buttons.
  // Exactly once per mount: StrictMode (dev, which `make phone` serves)
  // runs mount effects twice, and a second run doubled every model call
  // and made the user wait for the later, superseding result.
  const started = useRef<boolean>(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const last = files[files.length - 1];
    fileRef.current = last;
    setImgURL(URL.createObjectURL(last));
    setStillURLs(files.map((f) => URL.createObjectURL(f)));
    void run(files, issue, API);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Show the questions one at a time; resolves with every reply. */
  function askAll(qs: Question[]): Promise<{ ask: string; reply: string }[]> {
    setAnswered([]);
    setQuestions(qs);
    return new Promise((resolve) => {
      answerResolve.current = resolve;
    });
  }

  function reply(q: Question, text: string) {
    const next = [...answered, { ask: q.ask, reply: text }];
    setAnswered(next);
    if (next.length >= questions.length) {
      setQuestions([]);
      answerResolve.current?.(next);
      answerResolve.current = null;
    }
  }

  async function run(fs: File[], t: string, base: string) {
    const myRun = ++runSeq.current;
    setStatus("Analyzing…");
    setInstances([]);
    setNotes("");
    setOverlayURL("");
    setCauses([]);
    setSteps([]);
    setLegend([]);
    setSaid([]);
    setStepIdx(0);
    setResolution("");
    setDevice("");
    setDetails({});
    setAsk("");
    setInventory([]);
    setSafety([]);
    setVerdict(null);
    setQuestions([]);
    setAnswered([]);
    setFixed(false);
    setBooking(false);
    setDone(null);
    // Spoken while the analysis runs, not before it starts.
    void say("Working out what's wrong.");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any =
        (prefetched ? await prefetched : null) ||
        (await requestDiagnosis(base, fs, t, perception, heard?.summary || ""));
      // Questions first: the owner looks, taps an answer, and the server
      // decides with those answers (one more diagnose, no re-perceive).
      const qs: Question[] = data.status === "ok" ? data.questions || [] : [];
      if (qs.length && myRun === runSeq.current) {
        mark("questions shown", `${qs.length}`);
        setStatus("");
        const replies = await askAll(qs);
        if (myRun !== runSeq.current) return;
        mark("questions answered", replies.map((r) => r.reply).join(" | "));
        setStatus("Deciding…");
        data = await requestDiagnosis(
          base,
          fs,
          t,
          data.perception || perception,
          heard?.summary || "",
          replies.map((r) => `${r.ask} ${r.reply}.`).join(" ")
        );
      }
      mark("walkthrough analyze returned", `${data.status} trace=${(data.trace || []).length} calls`);
      for (const c of data.trace || []) {
        mark(`  server: ${c.model} ${c.purpose}`, `+${c.start_s}s took ${(c.latency_ms / 1000).toFixed(1)}s ${c.status}`);
      }
      if (myRun !== runSeq.current) return; // superseded by a newer run
      if (data.status !== "ok") {
        const notes: string = data.notes || "";
        setStatus(data.detail);
        setNotes(notes);
        setInventory(data.components || []);
        await say(
          notes
            ? `${notes} But I hit a problem cutting out the parts: ${data.detail}`
            : `I hit a problem: ${data.detail}`
        );
        return;
      }
      setNotes(data.notes || "");
      setStatus("");
      const foundCauses: string[] = data.causes || [];
      const foundSteps = (data.steps || []).map((s: unknown) =>
        typeof s === "string"
          ? { check: s, how: "", part: null, caution: null }
          : {
              check: (s as { check?: string }).check || "",
              how: (s as { how?: string }).how || "",
              part: (s as { part?: string }).part || null,
              caution: (s as { caution?: string }).caution || null,
            }
      );
      setCauses(foundCauses);
      setSteps(foundSteps);
      setFocus(data.focus || null);
      const list: Instance[] = data.instances || [];
      setInstances(list);
      mark("verdict rendered", `${foundSteps.length} steps`);
      const overlay = data.overlay as
        | { image_b64: string; mime: string; legend: { label: string; color: string; tag?: string }[] }
        | null
        | undefined;
      setLegend(data.legend || overlay?.legend || []);
      setInventory(data.components || []);
      if (overlay?.image_b64) {
        setOverlayURL(
          `data:${overlay.mime || "image/webp"};base64,${overlay.image_b64}`
        );
      } else {
        setOverlayURL("");
      }
      // SAM 3.1 masks arrive in their own request (~2-3s) after the
      // verdict; muse-image (labelled illustrative) only for a step-1
      // part SAM could not find.
      const segLabels: unknown[] = data.segment_labels || [];
      const still = fileRef.current;
      if (segLabels.length && still) {
        void (async () => {
          const sfd = new FormData();
          sfd.append("file", still);
          sfd.append("labels", JSON.stringify(segLabels));
          let sam: Instance[] = [];
          try {
            const sd = await (await fetch(`${base}/api/segment`, { method: "POST", body: sfd })).json();
            sam = sd.instances || [];
          } catch (_) {
            sam = [];
          }
          if (myRun !== runSeq.current) return;
          setInstances(sam);
          const part = foundSteps[0]?.part;
          const covered = sam.length ? showStepMasks(part, sam) : false;
          mark("sam masks shown", `${sam.length} masks, step 1 ${covered ? "covered" : "not covered"}`);
          setStatus(sam.length ? `SAM 3.1: ${sam.length} masks` : "");
          if (covered || !part) return;
          const hfd = new FormData();
          hfd.append("file", still);
          hfd.append("part", part);
          hfd.append("legend", JSON.stringify(data.legend || []));
          mark("highlight requested", part);
          try {
            const hd = await (await fetch(`${base}/api/repair/highlight`, { method: "POST", body: hfd })).json();
            mark("highlight returned", hd.status);
            if (myRun === runSeq.current && hd.overlay?.image_b64) {
              setOverlayURL(`data:${hd.overlay.mime || "image/webp"};base64,${hd.overlay.image_b64}`);
            }
          } catch (_) {
            // Step text still guides without a picture.
          }
        })();
      }
      setStatus(segLabels.length ? "Outlining parts…" : "");
      const foundSafety: string[] = data.safety || [];
      setSafety(foundSafety);
      const v: Verdict | null = data.verdict || null;
      setVerdict(v);
      if (v) mark("verdict", `${v.verdict} ${v.rule || ""} "${v.headline}"`);
      // The verdict, out loud, in one short sentence (< 2s), then step 1.
      if (v?.headline) void say(v.headline, 1.9);
      if (data.ask && !(data.steps || []).length) {
        setAsk(data.ask);
        await say(data.ask);
      }
      if (
        !(data.steps || []).length &&
        !data.ask &&
        (list.length > 0 || (data.components || []).length > 0)
      ) {
        await say(
          "I can see the parts but I could not tell what is wrong. " +
            "Move closer to the faulty area or tell me which part you mean, " +
            "then run it again."
        );
      }
      setResolution(data.resolution || "");
      if (data.device) setDevice(data.device);
      if (data.details && typeof data.details === "object") {
        setDetails(data.details);
      }
      setStepIdx(0);
      if (foundSteps.length) {
        await speakStep(
          foundSteps[0],
          0,
          foundSteps.length,
          data.legend || overlay?.legend || []
        );
      }
    } catch (e) {
      const msg = "Failed: " + (e as Error).message;
      setStatus(msg);
      setNeedBase(true);
      await say(
        "I could not reach the server. If you are on a phone, make sure " +
          "it is on the same Wi-Fi as the computer running the app, then try again."
      );
    }
  }

  function tagFor(
    part: string | null,
    leg: { label: string; tag?: string }[] = legend
  ): string | null {
    if (!part) return null;
    return (
      leg.find((e) => e.label.toLowerCase() === part.toLowerCase())?.tag ||
      null
    );
  }

  async function speakStep(
    st: { check: string; how: string; part: string | null; caution?: string | null },
    i: number,
    total: number,
    leg: { label: string; tag?: string }[] = legend
  ): Promise<void> {
    const tag = tagFor(st.part, leg);
    // Short pieces, each synthesised as soon as it is queued: the first
    // is a small clip that starts within a second or two, the rest
    // stream in behind it instead of one large WAV over the tunnel.
    const parts = [
      `Step ${i + 1} of ${total}: ${st.check}.`,
      st.how,
      tag ? `Look for ${tag} on the photo.` : "",
      st.caution ? `Careful: ${st.caution}` : "",
    ].filter(Boolean) as string[];
    let last: Promise<void> = Promise.resolve();
    for (const p of parts) last = say(p);
    await last;
  }

  async function goStep(i: number): Promise<void> {
    if (i < 0 || i >= steps.length || !fileRef.current) return;
    setStepIdx(i);
    const st = steps[i];
    // SAM already outlined this part: show its mask, skip muse-image.
    if (showStepMasks(st.part, instances)) {
      setOverlayURL("");
    } else if (st.part) {
      setStepLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", fileRef.current);
        fd.append("part", st.part);
        fd.append("legend", JSON.stringify(legend));
        const r = await fetch(`${API}/api/repair/highlight`, {
          method: "POST",
          body: fd,
        });
        const data = await r.json();
        if (data.overlay?.image_b64) {
          setOverlayURL(
            `data:${data.overlay.mime || "image/webp"};base64,${data.overlay.image_b64}`
          );
          // Legend stays canonical for the whole walkthrough: only
          // merge in entries for parts not already listed.
          const known = new Set(legend.map((e) => e.label.toLowerCase()));
          const fresh = (data.overlay.legend || []).filter(
            (e: { label: string }) => !known.has(e.label.toLowerCase())
          );
          if (fresh.length) setLegend((prev) => [...prev, ...fresh]);
        }
      } catch (_) {
        // Keep the previous highlight; the step text still guides.
      }
      setStepLoading(false);
    }
    await speakStep(st, i, steps.length);
  }

  /* Last step done: camera re-check of the part, then the Done card. */
  async function finishFix(): Promise<void> {
    const part = focus || steps.find((s) => s.part)?.part || null;
    const seconds = Math.round(turnElapsed());
    const after = onRecheck ? await onRecheck(part) : null;
    if (!after) {
      setDone({ afterURL: "", state: "error", looksFixed: null, seen: "", next: null, seconds });
      return;
    }
    setDone({ afterURL: URL.createObjectURL(after), state: "checking", looksFixed: null, seen: "", next: null, seconds });
    mark("recheck sent", part || "");
    const fd = new FormData();
    fd.append("before", files[0], "before.jpg");
    fd.append("after", after, "after.jpg");
    const last = steps[steps.length - 1];
    fd.append("fix", `${verdict?.headline || ""} Last step: ${last ? `${last.check}. ${last.how}` : ""}`);
    if (part) fd.append("part", part);
    try {
      const r = await (await fetch(`${API}/api/recheck`, { method: "POST", body: fd })).json();
      mark("recheck", `${r.status} looks_fixed=${r.looks_fixed}`);
      setDone((d) =>
        d && {
          ...d,
          state: r.status === "ok" ? "ok" : "error",
          looksFixed: r.looks_fixed ?? null,
          seen: r.seen || "",
          next: r.next || null,
        }
      );
    } catch (_) {
      setDone((d) => d && { ...d, state: "error" });
    }
  }

  async function confirmFixed(yes: boolean): Promise<void> {
    if (yes) {
      setFixed(true);
    } else {
      setBooking(true);
      await say("Sorry. Here's who can help nearby.");
    }
  }


  function toggle(i: number) {
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setHidden(next);
    void drawMasks(instances, next);
  }

  return (
    <section style={{ padding: 16, maxWidth: 720, margin: "0 auto" }}>
      <h1>Repairing what I captured</h1>
      <p style={{ color: "#b9c0c6" }}>
        {files.length} view{files.length === 1 ? "" : "s"} captured from
        your camera. Naming the parts, highlighting them step by step,
        talking you through the fix.
      </p>
      {stillURLs.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {stillURLs.map((u, i) => (
            <figure key={i} className="ref-thumb" style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`view ${i + 1}`} />
              <figcaption>view {i + 1}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <p>
        You said: <em>&ldquo;{issue}&rdquo;</em>{" "}
        {onListen && (
          <button type="button" className="btn-outline" onClick={onListen}>
            {heard ? "Listen again" : "Let me listen"}
          </button>
        )}
        {onMoreViews && (
          <button type="button" className="btn-outline" onClick={onMoreViews}>
            Add a closer view
          </button>
        )}
        <button type="button" className="btn-outline" onClick={onClose}>
          Close and point the camera again
        </button>
      </p>
      {status && <p role="status">{status}</p>}
      {(questions.length > 0 || answered.length > 0) && (
        <section className="question-card" aria-live="polite">
          {answered.length > 0 && (
            <ul className="checklist">
              {answered.map((a, i) => (
                <li key={i} className="done">
                  <span aria-hidden="true">✓</span> {a.ask} <strong>{a.reply}</strong>
                </li>
              ))}
            </ul>
          )}
          {questions[answered.length] && (
            <>
              <p className="sheet-label">
                Quick check {answered.length + 1} of {questions.length}
              </p>
              <p className="question">{questions[answered.length].ask}</p>
              <div className="chips">
                {[...questions[answered.length].options, "Not sure"]
                  .filter((o, i, all) => all.findIndex((x) => x.toLowerCase() === o.toLowerCase()) === i)
                  .map((o) => (
                    <button key={o} type="button" className="chip" onClick={() => reply(questions[answered.length], o)}>
                      {o}
                    </button>
                  ))}
              </div>
              <p className="evidence-note">Just look. No need to touch or open anything.</p>
            </>
          )}
        </section>
      )}
      {needBase && (
        <div style={{ marginTop: 8 }}>
          <p>
            The backend is not reachable at <code>{API}</code>. If it is
            behind a tunnel, paste its URL (it changes every run — this is
            remembered in this browser only):
          </p>
          <input
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            placeholder="https://your-backend-tunnel-url"
            className="text-input"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn-primary"
            style={{ marginTop: 8 }}
            onClick={() => {
              const url = baseInput.trim().replace(/\/$/, "");
              if (!url) return;
              try {
                window.localStorage.setItem("handyman-api-base", url);
              } catch (_) {
                // Private mode; keep it for this run only.
              }
              setApiBase(url);
              setNeedBase(false);
              setBaseInput("");
              void run(files, issue, url);
            }}
          >
            Save and retry
          </button>
        </div>
      )}
      {notes && <p className="instruction">{notes}</p>}
      {device && <p className="step-count">{device}</p>}
      {(device || (details.markings || []).length > 0) && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Evidence for the call</p>
          <div>
            {device && <span className="evidence-note">badge → {device}</span>}
            {(details.markings || []).map((m, i) => (
              <span key={i} className="evidence-note">{m}</span>
            ))}
          </div>
        </div>
      )}
      {ask && (
        <p style={{ fontWeight: "bold" }}>
          {ask} (Close this and describe the problem, then I will dig in.)
        </p>
      )}
      {inventory.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Parts list</p>
          {inventory.map((c, i) => (
            <div key={i} className="parts-row">
              <span>
                <strong>{c.label}</strong>
                {[c.color, c.condition, c.position].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))}
        </div>
      )}
      {(details.serial || details.color || details.condition ||
        (details.markings || []).length > 0 || (details.other || []).length > 0) && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Every little detail</p>
          {details.serial && <div><strong>Serial:</strong> {details.serial}</div>}
          {details.color && <div><strong>Color:</strong> {details.color}</div>}
          {details.condition && <div><strong>Condition:</strong> {details.condition}</div>}
          {(details.markings || []).length > 0 && (
            <div>
              <strong>Markings:</strong>
              <ul>
                {details.markings!.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
          {(details.other || []).length > 0 && (
            <div>
              <strong>Also noticed:</strong>
              <ul>
                {details.other!.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {said.length > 0 && (
        <div style={{ marginTop: 8 }} className="transcript">
          <p className="sheet-label">Thinking aloud</p>
          <ol>
            {said.map((line, i) => <li key={i}>{line}</li>)}
          </ol>
        </div>
      )}
      {imgURL && (
        <div style={{ position: "relative", marginTop: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imgRef} src={imgURL} alt="upload" style={{ width: "100%", display: "block" }} />
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        </div>
      )}
      {overlayURL && (
        <div style={{ marginTop: 8 }}>
          <p className="evidence-note">Illustrative highlight (muse-image), not a measured outline</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={overlayURL} alt="highlighted" style={{ width: "100%", display: "block" }} />
        </div>
      )}
      {safety.length > 0 && (
        <div className="callout callout-caution">
          <p className="sheet-label">Handle with care</p>
          <ul>
            {safety.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {causes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Likely causes</p>
          <ul>
            {causes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {heard && (
        <div className={`heard-card${heard.agree ? "" : " doubt"}`}>
          <p className="sheet-label">What I heard</p>
          <table>
            <tbody>
              <tr>
                <td>Measured</td>
                <td>
                  {heard.features.beeps} beep{heard.features.beeps === 1 ? "" : "s"}
                  {heard.features.beep_ms ? ` · ${heard.features.beep_ms} ms` : ""}
                  {heard.features.beep_interval_ms ? ` · every ${(heard.features.beep_interval_ms / 1000).toFixed(1)} s` : ""}
                  {heard.features.beep_hz ? ` · ${heard.features.beep_hz} Hz` : ""}
                  {` · ${heard.features.clicks} click${heard.features.clicks === 1 ? "" : "s"}`}
                </td>
              </tr>
              <tr>
                <td>Muse Wonder</td>
                <td>
                  {heard.wonder
                    ? `${heard.wonder.beeps ?? "?"} beeps · ${heard.wonder.sound || "—"}`
                    : "unavailable"}
                </td>
              </tr>
            </tbody>
          </table>
          {!heard.agree && (
            <p className="evidence-note">They disagree on the count, so the diagnosis leans on the measured numbers.</p>
          )}
        </div>
      )}
      {verdict && (
        <div className={`verdict-card ${verdict.verdict}`}>
          <p className="sheet-label">Verdict</p>
          <p className="verdict-title">
            {verdict.verdict === "diy" ? "You can fix this" : "Call a pro"}
          </p>
          {verdict.verdict === "pro" && (
            <>
              <div className="callout callout-dont-touch">
                <p className="sheet-label">Safety rule</p>
                <p>{verdict.title}</p>
              </div>
              {verdict.blocked_steps.length > 0 && (
                <p className="evidence-note">
                  The rules removed {verdict.blocked_steps.length} of the{" "}
                  {verdict.proposed_steps} steps the model suggested.
                </p>
              )}
              {!booking && (
                <button type="button" className="btn-primary" onClick={() => setBooking(true)}>
                  Find a {verdict.trade || "pro"}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {steps.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {verdict?.verdict === "pro" && (
            <p className="sheet-label">Safe checks before you call</p>
          )}
          <p className="step-count">{String(stepIdx + 1).padStart(2, "0")}/{String(steps.length).padStart(2, "0")}</p>
          <div className="ticks">
            {steps.map((_, i) => (
              <span key={i} className={i === stepIdx ? "tick active" : "tick"} />
            ))}
          </div>
          {(() => {
            const s = steps[stepIdx];
            if (!s) return null;
            const tag = legend.find(
              (e) => s.part && e.label.toLowerCase() === s.part.toLowerCase()
            )?.tag;
            return (
              <div>
                <p className="sheet-label">What to check</p>
                <p className="instruction">{s.check}</p>
                {s.how && <p>{s.how}</p>}
                {s.caution && (
                  <div className="callout callout-dont-touch">
                    <p className="sheet-label">Don&apos;t touch</p>
                    <p>{s.caution}</p>
                  </div>
                )}
                {s.part && (
                  <div>
                    {tag && <span className="tag-letter active">{tag}</span>}
                    <span className="evidence-note">{s.part}</span>
                  </div>
                )}
              </div>
            );
          })()}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn-outline"
              onClick={() => void goStep(stepIdx - 1)}
              disabled={stepIdx === 0 || stepLoading}
            >
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                stepIdx < steps.length - 1
                  ? void goStep(stepIdx + 1)
                  : verdict?.verdict === "pro"
                    ? setBooking(true)
                    : void finishFix()
              }
              disabled={stepLoading || (done?.state === "checking")}
            >
              {stepLoading
                ? "Highlighting…"
                : stepIdx < steps.length - 1
                  ? "Next step"
                  : verdict?.verdict === "pro"
                    ? `Find a ${verdict.trade || "pro"}`
                    : "Done, check it"}
            </button>
          </div>
        </div>
      )}
      {legend.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Legend</p>
          {legend.map((e, i) => (
            <div key={i} className="parts-row">
              <span className="tag-letter active">{e.tag || String.fromCharCode(65 + i)}</span>
              <span>{e.label}</span>
            </div>
          ))}
        </div>
      )}
      {done && (
        <section className={`done-card ${done.looksFixed === true ? "ok" : done.looksFixed === false ? "bad" : ""}`}>
          <p className="sheet-label">Final check</p>
          <div className="before-after">
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={stillURLs[0] || imgURL} alt="before the fix" />
              <figcaption>Before</figcaption>
            </figure>
            <figure>
              {done.afterURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={done.afterURL} alt="after the fix" />
              ) : (
                <div className="after-missing">No camera frame</div>
              )}
              <figcaption>After</figcaption>
            </figure>
          </div>
          <p className="done-result" role="status">
            {done.state === "checking" && "Checking the after photo…"}
            {done.state === "error" && "Couldn't run the check. Try again, or just tell me below."}
            {done.state === "ok" && done.looksFixed === true && <>✓ {done.seen}</>}
            {done.state === "ok" && done.looksFixed === false && <>✗ {cap(done.next || done.seen)}</>}
            {done.state === "ok" && done.looksFixed === null && <>Couldn&apos;t see it clearly. {cap(done.next || "")}</>}
          </p>
          {done.state !== "checking" && done.looksFixed !== true && (
            <button type="button" className="btn-outline" onClick={() => void finishFix()}>
              Check again
            </button>
          )}
          <div className="done-stats">
            <div><strong>{done.seconds < 60 ? `${done.seconds} s` : `${Math.floor(done.seconds / 60)} min ${done.seconds % 60} s`}</strong><span>time taken</span></div>
            <div><strong>₹0</strong><span>spent</span></div>
            <div><strong>{steps.length}</strong><span>steps done</span></div>
          </div>
          {!fixed && !booking && done.state !== "checking" && (
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button type="button" className="btn-success" onClick={() => void confirmFixed(true)}>
                It works now
              </button>
              <button type="button" className="btn-outline" onClick={() => void confirmFixed(false)}>
                Still broken
              </button>
            </div>
          )}
          {fixed && <p className="done-result">Fixed. Close this and point the camera at the next thing.</p>}
        </section>
      )}
      {resolution && !done && (
        <div style={{ marginTop: 8 }}>
          <p className="sheet-label">Did it work?</p>
          <p>{resolution}</p>
          <button
            type="button"
            className="btn-outline"
            onClick={() => void say(`Resolution check: ${resolution}`)}
          >
            Read the resolution check aloud
          </button>
          {!fixed && !booking && (
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button type="button" className="btn-success" onClick={() => void confirmFixed(true)}>
                Yes, it is fixed
              </button>
              <button type="button" className="btn-outline" onClick={() => void confirmFixed(false)}>
                No, still broken
              </button>
            </div>
          )}
          {fixed && <p>Fixed — nice work. Close this and point the camera at the next thing.</p>}
        </div>
      )}
      {booking && (
        <CallAPro
          api={API}
          trade={verdict?.trade || "repair service"}
          brief={{
            device: device || "",
            issue,
            finding: verdict?.headline || causes[0] || "needs a closer look",
            rule: verdict?.verdict === "pro" ? verdict.title : null,
            checks: steps.slice(0, Math.max(stepIdx + 1, 1)).map((st) => st.check),
            sound: heard ? heard.summary : null,
            photo: fileRef.current || null,
            clip: heard?.clip || null,
          }}
        />
      )}
      {instances.map((inst, i) => (
        <label key={i} style={{ display: "block", marginTop: 4 }}>
          <input type="checkbox" checked={!hidden.has(i)} onChange={() => toggle(i)} />{" "}
          <span style={{ color: ORANGE }}>■</span> {inst.label}
          {inst.score != null ? ` (SAM ${Math.round(inst.score * 100)}%)` : " (SAM)"}
        </label>
      ))}
    </section>
  );
}
