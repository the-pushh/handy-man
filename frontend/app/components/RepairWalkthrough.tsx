"use client";

/* Photo repair walkthrough: image in -> Muse Spark names components,
   Muse Image highlights them step by step with an IKEA-style legend,
   spoken thinking throughout. Embedded in the main app's repair view. */

import { useEffect, useRef, useState } from "react";
import { IS_PROD, resolveApiBase } from "../lib/apiBase";
import { mark, turnElapsed } from "../lib/timeline";
import { requestDiagnosis } from "../lib/diagnosis";
import type { Heard } from "../lib/recorder";
import CallAPro from "./CallAPro";
import Busy from "./Busy";
import type { ScanWarning } from "./LiveDetect";
import { getSpeechRecognition } from "../lib/speech";
import { newJobId, putMedia, saveJob, updateJob } from "../lib/history";

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
  difficulty?: "easy" | "medium" | "hard" | null;
  minutes?: number | null;
  tools?: string[];
  confidence?: "high" | "medium" | "low" | null;
  based_on?: string[];
  // Rule the owner chose to override at the scan warning (own risk).
  overridden?: string | null;
}

/* What went wrong, in words for the owner (never the raw error). */
function failureFor(status: string, detail = ""): { title: string; hint: string } {
  if (status === "rate-limited")
    return { title: "Slow down a little.", hint: detail || "Too many fixes at once. Try again soon." };
  if (status === "needs-api-key")
    return { title: "The model isn't set up on this server.", hint: "Add the API key to .env and restart the backend." };
  if (status === "timeout")
    return { title: "That took too long.", hint: "The model is slow right now. Try again." };
  if (status === "network")
    return { title: "Couldn't reach the server.", hint: "Check the connection, then try again." };
  return { title: "The model didn't answer that time.", hint: "Nothing is wrong with your device. Try again." };
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

// Who is working during each wait, and how long it usually takes.
const BUSY: Record<string, { hint: string; slowAfter: number }> = {
  "Working it out…": {
    hint: "Muse Spark is reading the photo and what you said; then the safety rules check its plan. Usually 15–30 s.",
    slowAfter: 35,
  },
  "Deciding…": { hint: "Muse Spark is deciding with your answers. Usually 10–20 s.", slowAfter: 25 },
  "Outlining parts…": { hint: "SAM 3.1 is outlining the parts on your photo. A few seconds.", slowAfter: 10 },
};

// Runs on one machine before the walkthrough calls a technician.
const MAX_RUNS = 3;

export default function RepairWalkthrough({
  files,
  issue,
  perception,
  prefetched,
  heard,
  followUp = "",
  machine = "",
  attempt = 1,
  parentId = null,
  acceptRisk = null,
  onRetry,
  onListen,
  onMoreViews,
  onRecheck,
  onClose,
}: {
  files: File[];
  issue: string;
  // Run 2 onwards: what was tried and what is still wrong.
  followUp?: string;
  // The item the owner named; History groups runs by it.
  machine?: string;
  attempt?: number;
  parentId?: string | null;
  // Scan-time warning the owner overrode: every step shown, their risk.
  acceptRisk?: ScanWarning | null;
  // "Still broken": run again with what is still wrong.
  onRetry?: (reply: string, tried: string[], after: File | null, jobId: string | null) => void;
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
  const [failure, setFailure] = useState<{ title: string; hint: string } | null>(null);
  // This turn's entry in the on-device history (lib/history.ts).
  const jobId = useRef<string | null>(null);
  const [appliance, setAppliance] = useState<string>("");
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
  // One screen at a time: the verdict (main), then the steps on tap.
  const [view, setView] = useState<"main" | "steps">("main");
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
  const answeredRef = useRef<{ ask: string; reply: string }[]>([]);
  const answerResolve = useRef<((a: { ask: string; reply: string }[]) => void) | null>(null);
  // Called when only the last question is left, with the replies so far.
  const lastQuestion = useRef<((sofar: { ask: string; reply: string }[]) => void) | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<File | null>(null);
  // SAM's outlines for this run (a step waits for them instead of
  // racing them), and Muse Image fallbacks prepared ahead per part.
  const samRef = useRef<Promise<Instance[]>>(Promise.resolve([]));
  const highlightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const highlightChain = useRef<Promise<unknown>>(Promise.resolve());
  // The re-check's "after" still: run 2 starts from it.
  const afterRef = useRef<File | null>(null);
  // "Still broken": what is still wrong, by voice or typed.
  const [stillWrong, setStillWrong] = useState<string | null>(null);
  const [hearing, setHearing] = useState<boolean>(false);
  const askedFixed = useRef<boolean>(false);

  /* Indices of SAM instances that belong to a step's part. */
  /* The step's part: only SAM's best match for it (a second, weaker
     match is usually the wrong thing and clutters the photo). */
  function masksFor(part: string | null | undefined, list: Instance[]): number[] {
    if (!part) return [];
    const want = part.toLowerCase();
    const mine = list.flatMap((inst, i) => (inst.label.toLowerCase() === want ? [i] : []));
    if (mine.length < 2) return mine;
    const best = mine.reduce((a, b) => ((list[b].score ?? 0) > (list[a].score ?? 0) ? b : a));
    return [best];
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
    if (IS_PROD) return "";
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

  // Bumped by hush(): lines queued before it never play.
  const speechGen = useRef<number>(0);
  const playing = useRef<HTMLAudioElement | null>(null);

  function say(line: string, maxSeconds?: number): Promise<void> {
    setSaid((prev) => [...prev, line]);
    const gen = speechGen.current;
    const audio = synthQueue.current.then(() => fetchSpeech(line, maxSeconds));
    synthQueue.current = audio.catch(() => null);
    speechQueue.current = speechQueue.current
      .then(() => audio)
      .then((url) => (gen === speechGen.current ? playSpeech(url, line) : undefined))
      .catch(() => {});
    return speechQueue.current;
  }

  /* Stop the line playing now and drop everything queued after it
     (moving to another step, or leaving for the camera re-check). */
  function hush(): void {
    speechGen.current += 1;
    playing.current?.pause();
    playing.current?.dispatchEvent(new Event("ended"));
    playing.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
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
        playing.current = a;
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
  function askAll(
    qs: Question[],
    onLast?: (sofar: { ask: string; reply: string }[]) => void
  ): Promise<{ ask: string; reply: string }[]> {
    setAnswered([]);
    answeredRef.current = [];
    setQuestions(qs);
    lastQuestion.current = onLast || null;
    if (qs.length === 1) onLast?.([]);
    return new Promise((resolve) => {
      answerResolve.current = resolve;
    });
  }

  function reply(q: Question, text: string) {
    const next = [...answered, { ask: q.ask, reply: text }];
    setAnswered(next);
    answeredRef.current = next;
    if (next.length === questions.length - 1) lastQuestion.current?.(next);
    if (next.length >= questions.length) {
      setQuestions([]);
      answerResolve.current?.(next);
      answerResolve.current = null;
    }
  }

  async function run(fs: File[], t: string, base: string) {
    const myRun = ++runSeq.current;
    setStatus("Working it out…");
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
    setFailure(null);
    setQuestions([]);
    setAnswered([]);
    setFixed(false);
    setBooking(false);
    setDone(null);
    setView("main");
    // What the model works on: the owner's words, plus on run 2+ what
    // was tried and what is still wrong.
    const ask = followUp ? `${t}. ${followUp}` : t;
    const risk = acceptRisk?.rule || "";
    // Spoken while the analysis runs, not before it starts.
    void say(attempt > 1 ? `Run ${attempt}. Working out what's still wrong.` : "Working out what's wrong.");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any =
        (prefetched ? await prefetched : null) ||
        (await requestDiagnosis(base, fs, ask, perception, heard?.summary || "", "", false, risk));
      // Questions first: the owner looks, taps an answer, and the server
      // decides with those answers (one more diagnose, no re-perceive).
      const qs: Question[] = data.status === "ok" ? data.questions || [] : [];
      if (data.perception?.appliance) setAppliance(data.perception.appliance);
      if (qs.length && myRun === runSeq.current) {
        mark("questions shown", `${qs.length}`);
        setStatus("");
        // Decide ahead: once only the last question is left, one decide
        // request per possible answer starts while the owner looks, so
        // the tap picks a result that is already on its way.
        const persp = data.perception || perception;
        const sound = heard?.summary || "";
        const text = (rs: { ask: string; reply: string }[]) =>
          rs.map((r) => `${r.ask} ${r.reply}.`).join(" ");
        const ahead = new Map<string, Promise<unknown>>();
        const replies = await askAll(qs, (sofar) => {
          const q = qs[sofar.length];
          const opts = [...q.options, "Not sure"].filter(
            (o, i, all) => all.findIndex((x) => x.toLowerCase() === o.toLowerCase()) === i
          );
          mark("decide ahead", `${opts.length} answers`);
          for (const o of opts) {
            const key = text([...sofar, { ask: q.ask, reply: o }]);
            ahead.set(key, requestDiagnosis(base, fs, ask, persp, sound, key, true, risk).catch(() => null));
          }
        });
        if (myRun !== runSeq.current) return;
        mark("questions answered", replies.map((r) => r.reply).join(" | "));
        setStatus("Deciding…");
        const key = text(replies);
        const pre = (await ahead.get(key)) as typeof data;
        const usable = pre && pre.status === "ok";
        data = usable ? pre : await requestDiagnosis(base, fs, ask, persp, sound, key, false, risk);
        mark("decided", usable ? "from ahead" : "fresh");
      }
      mark("walkthrough analyze returned", `${data.status} trace=${(data.trace || []).length} calls`);
      for (const c of data.trace || []) {
        mark(`  server: ${c.model} ${c.purpose}`, `+${c.start_s}s took ${(c.latency_ms / 1000).toFixed(1)}s ${c.status}`);
      }
      if (myRun !== runSeq.current) return; // superseded by a newer run
      if (data.status !== "ok") {
        mark("analysis failed", `${data.status}: ${data.detail || ""}`);
        setStatus("");
        setNotes(data.notes || "");
        setInventory(data.components || []);
        setFailure(failureFor(data.status, data.detail));
        return;
      }
      setAppliance(data.perception?.appliance || "");
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
      highlightRef.current = new Map();
      if (segLabels.length && still) {
        samRef.current = (async () => {
          const sfd = new FormData();
          sfd.append("file", still);
          sfd.append("labels", JSON.stringify(segLabels));
          try {
            const sd = await (await fetch(`${base}/api/segment`, { method: "POST", body: sfd })).json();
            return (sd.instances || []) as Instance[];
          } catch (_) {
            return [] as Instance[];
          }
        })();
        void samRef.current.then((sam) => {
          if (myRun !== runSeq.current) return;
          setInstances(sam);
          showStepMasks(null, sam);
          setStatus("");
          const missed = foundSteps
            .map((st: { part: string | null }) => st.part)
            .filter((part: string | null): part is string => !!part && !masksFor(part, sam).length);
          mark("sam masks shown", `${sam.length} masks; preparing ${missed.length} illustrated highlight(s): ${missed.join(", ")}`);
          // Steps SAM missed: illustrated highlights, one after another in
          // the background, so a step rarely waits for one.
          for (const part of missed) void fetchHighlight(part, still, base, data.legend || []);
        });
      } else {
        samRef.current = Promise.resolve([]);
      }
      setStatus(segLabels.length ? "Outlining parts…" : "");
      const foundSafety: string[] = data.safety || [];
      setSafety(foundSafety);
      const v: Verdict | null = data.verdict || null;
      setVerdict(v);
      if (v && myRun === runSeq.current) {
        const id = jobId.current || newJobId();
        jobId.current = id;
        saveJob({
          id,
          date: new Date().toISOString(),
          device: [data.device, data.perception?.appliance].filter(Boolean).join(" ") || "device",
          issue: t,
          verdict: v.verdict,
          rule: v.rule,
          ruleTitle: v.title,
          headline: v.headline,
          trade: v.trade,
          steps: foundSteps.map((st: { check: string; how: string; caution?: string | null }) => ({
            check: st.check,
            how: st.how,
            caution: st.caution || null,
          })),
          answers: answeredRef.current,
          outcome: null,
          finding: v.headline || foundCauses[0] || "",
          sound: heard ? heard.summary : null,
          media: {},
          machine: machine || data.perception?.appliance || data.device || "device",
          attempt,
          parentId,
          riskAccepted: acceptRisk ? { rule: acceptRisk.rule, title: acceptRisk.title } : null,
        });
        void putMedia(id, "before", fs[0]);
        void putMedia(id, "clip", heard?.clip);
      }
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
      // Steps start when the owner taps "Show me the steps" (one screen
      // at a time), so the verdict screen only says what to tap.
      if (v && foundSteps.length) {
        void say(v.verdict === "pro" ? "You can call a technician from here." : "Tap show me the steps when you're ready.");
      }
    } catch (e) {
      const err = e as Error;
      mark("analysis failed", `${err.name}: ${err.message}`);
      setStatus("");
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      setFailure(failureFor(timedOut ? "timeout" : "network"));
      // Still on the same-host fallback (no env, nothing saved): the
      // backend is probably behind a tunnel, so offer to paste it.
      if (!IS_PROD && !timedOut && API === `http://${window.location.hostname}:8000`) setNeedBase(true);
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

  /* Muse Image highlight for one part, made once and reused. Requests
     run one at a time (a queue), so the next step's is not starved. */
  function fetchHighlight(
    part: string,
    still: File,
    base: string,
    leg: { label: string; color: string; tag?: string }[]
  ): Promise<string | null> {
    const key = part.toLowerCase();
    const have = highlightRef.current.get(key);
    if (have) return have;
    const job = highlightChain.current.then(async () => {
      const fd = new FormData();
      fd.append("file", still);
      fd.append("part", part);
      fd.append("legend", JSON.stringify(leg));
      mark("highlight requested", part);
      try {
        const d = await (await fetch(`${base}/api/repair/highlight`, { method: "POST", body: fd })).json();
        mark("highlight returned", `${part}: ${d.status}`);
        if (!d.overlay?.image_b64) return null;
        const fresh = (d.overlay.legend || []).filter(
          (e: { label: string }) => !leg.some((x) => x.label.toLowerCase() === e.label.toLowerCase())
        );
        if (fresh.length) setLegend((prev) => [...prev, ...fresh]);
        return `data:${d.overlay.mime || "image/webp"};base64,${d.overlay.image_b64}`;
      } catch (_) {
        return null;
      }
    });
    highlightChain.current = job.catch(() => null);
    highlightRef.current.set(key, job);
    return job;
  }

  async function goStep(i: number): Promise<void> {
    if (i < 0 || i >= steps.length || !fileRef.current) return;
    hush(); // the previous step never talks over this one
    setStepIdx(i);
    const st = steps[i];
    // Speak right away; the highlight lands while the step is read.
    const spoken = speakStep(st, i, steps.length);
    setStepLoading(true);
    // SAM's outlines may still be on their way: wait for them (a few
    // seconds at most) rather than racing to a slower illustration.
    const sam = await Promise.race([
      samRef.current,
      new Promise<Instance[]>((r) => setTimeout(() => r(instances), 6000)),
    ]);
    if (showStepMasks(st.part, sam)) {
      setOverlayURL("");
      mark("step highlight", `${i + 1}: SAM outline of ${st.part}`);
    } else if (st.part) {
      setOverlayURL("");
      const url = await fetchHighlight(st.part, fileRef.current, API, legend);
      if (url) setOverlayURL(url);
      mark("step highlight", `${i + 1}: ${url ? "illustrated" : "none"} for ${st.part}`);
    }
    setStepLoading(false);
    await spoken;
  }

  /* Last step done: camera re-check of the part, then the Done card. */
  async function finishFix(): Promise<void> {
    const part = focus || steps.find((s) => s.part)?.part || null;
    hush();
    const seconds = Math.round(turnElapsed());
    const after = onRecheck ? await onRecheck(part) : null;
    afterRef.current = after;
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
      if (jobId.current) {
        updateJob(jobId.current, {
          recheck: { looksFixed: r.looks_fixed ?? null, seen: r.seen || r.next || "" },
          seconds,
        });
        void putMedia(jobId.current, "after", after);
      }
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

  /* "Find a pro" from a pro verdict: that is this job's outcome. */
  function openPro(): void {
    setBooking(true);
    if (jobId.current) updateJob(jobId.current, { outcome: "called a pro" });
  }

  // After the run's re-check: ask out loud whether it is fixed.
  useEffect(() => {
    if (!done || done.state === "checking" || askedFixed.current) return;
    askedFixed.current = true;
    void say("Is it fixed now?");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done?.state]);

  async function confirmFixed(yes: boolean): Promise<void> {
    if (jobId.current) updateJob(jobId.current, { outcome: yes ? "fixed" : "still broken" });
    if (yes) {
      setFixed(true);
      void say("Great. It's fixed.");
      return;
    }
    if (attempt >= MAX_RUNS || !onRetry) {
      // Enough runs on this machine: a technician is the answer now.
      setBooking(true);
      if (jobId.current) updateJob(jobId.current, { outcome: "called a pro" });
      await say(`That's ${attempt} tries. Leave it to ${/^[aeiou]/i.test(verdict?.trade || "technician") ? "an" : "a"} ${verdict?.trade || "technician"}. Here's who can help nearby.`);
      return;
    }
    setStillWrong("");
    await say("What's still not right?");
  }

  // One spoken answer to "What's still not right?".
  function hearStillWrong(): void {
    const SR = getSpeechRecognition();
    if (!SR) return;
    hush();
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      const text = String(e.results[0][0].transcript || "").trim();
      if (text) setStillWrong(text);
    };
    r.onend = () => setHearing(false);
    r.onerror = () => setHearing(false);
    try {
      r.start();
      setHearing(true);
    } catch (_) {
      setHearing(false);
    }
  }

  function sendStillWrong(): void {
    const reply = (stillWrong || "").trim();
    if (!reply || !onRetry) return;
    hush();
    onRetry(
      reply,
      steps.map((st) => st.check),
      afterRef.current,
      jobId.current
    );
  }


  /* Show or hide every mask of one part at once. */
  function toggleLabel(idx: number[], on: boolean) {
    const next = new Set(hidden);
    for (const i of idx) {
      if (on) next.add(i);
      else next.delete(i);
    }
    setHidden(next);
    void drawMasks(instances, next);
  }


  function showSteps(): void {
    mark("tap", "show me the steps");
    setView("steps");
    void goStep(0);
  }

  function back(): void {
    hush();
    if (booking && !done) {
      mark("tap", "back from technicians");
      setBooking(false);
    } else if (view === "steps" && !done) {
      mark("tap", "back to verdict");
      setView("main");
    }
  }

  const busy = status && !failure ? status : "";
  const name = appliance || device || "your device";
  const removed = verdict?.blocked_steps.length || 0;
  const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
  const trade = verdict?.trade || "technician";
  const screen: "fail" | "pros" | "done" | "steps" | "verdict" | "question" | "working" = failure
    ? "fail"
    : booking
      ? "pros"
      : done
        ? "done"
        : view === "steps" && steps.length
          ? "steps"
          : verdict
            ? "verdict"
            : questions[answered.length]
              ? "question"
              : "working";
  const step = steps[stepIdx];
  const stepTag = step?.part
    ? legend.find((e) => e.label.toLowerCase() === step.part!.toLowerCase())?.tag
    : undefined;
  const canBack = (screen === "steps" || screen === "pros") && !done;

  return (
    <section className="walk screened">
      <header className="walk-bar">
        {canBack ? (
          <button type="button" className="walk-icon" onClick={back} aria-label="Back">
            ←
          </button>
        ) : (
          <span className="walk-icon-space" />
        )}
        <div className="walk-title">
          <p className="sheet-label">
            {name}
            {attempt > 1 ? ` · run ${attempt} of ${MAX_RUNS}` : ""}
          </p>
          <p className="walk-said">&ldquo;{issue}&rdquo;</p>
        </div>
        <button type="button" className="walk-icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {needBase && (
        <div className="fail-card">
          <p>Paste the backend address (remembered in this browser only):</p>
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

      {/* The photo: every screen except the final check (before/after)
          and the technician list. On a step it shows that step's part. */}
      {imgURL && screen !== "done" && screen !== "pros" && (
        <figure className="walk-photo">
          <div className="photo-box">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgRef} src={overlayURL || imgURL} alt={name} />
            <canvas ref={canvasRef} className="mask-layer" hidden={!!overlayURL} />
          </div>
          {overlayURL ? (
            <figcaption>Illustrative highlight (Muse Image), not a measured outline</figcaption>
          ) : instances.length > 0 && screen !== "steps" ? (
            <figcaption>
              Outlined by SAM 3.1:{" "}
              {[...new Set(instances.map((inst) => inst.label))].map((label) => {
                const mine = instances.flatMap((inst, i) => (inst.label === label ? [i] : []));
                const on = mine.some((i) => !hidden.has(i));
                const best = Math.max(...mine.map((i) => instances[i].score ?? 0));
                return (
                  <button
                    key={label}
                    type="button"
                    className={`mask-chip${on ? "" : " off"}`}
                    onClick={() => toggleLabel(mine, on)}
                    aria-pressed={on}
                  >
                    {label}
                    {best ? ` ${Math.round(best * 100)}%` : ""}
                  </button>
                );
              })}
            </figcaption>
          ) : screen === "steps" && step?.part ? (
            <figcaption>
              {stepTag && <span className="tag-letter active">{stepTag}</span>} {step.part}
            </figcaption>
          ) : null}
        </figure>
      )}

      <div className="walk-body">
        {screen === "working" && busy && (
          <Busy
            label={busy === "Working it out…" && attempt > 1 ? `Run ${attempt}: working out what's still wrong…` : busy}
            hint={BUSY[busy]?.hint || ""}
            slowAfter={BUSY[busy]?.slowAfter || 0}
          />
        )}
        {screen === "working" && !busy && ask && <p className="instruction">{ask}</p>}

        {screen === "fail" && failure && (
          <section className="fail-card" role="alert">
            <p className="fail-title">{failure.title}</p>
            <p>{failure.hint}</p>
          </section>
        )}

        {screen === "question" && (
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
            <p className="sheet-label">
              Quick check{questions.length > 1 ? ` ${answered.length + 1} of ${questions.length}` : ""}
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
          </section>
        )}

        {screen === "verdict" && verdict && (
          <>
            <section className={`verdict-card ${verdict.verdict}`}>
              <p className="verdict-title">
                {verdict.verdict === "pro" ? "Call a pro" : acceptRisk ? "At your own risk" : "You can fix this"}
              </p>
              <p className="verdict-finding">
                {verdict.verdict === "pro" ? verdict.title : verdict.headline}
              </p>
              {acceptRisk && verdict.verdict === "diy" && (
                <p className="callout callout-caution own-risk">You chose to go on: {acceptRisk.title}</p>
              )}
              {verdict.verdict === "diy" && (
                <p className="verdict-line">
                  {[
                    verdict.difficulty && cap(verdict.difficulty),
                    verdict.minutes && `~${verdict.minutes} min`,
                    `${steps.length} step${steps.length === 1 ? "" : "s"}`,
                    (verdict.tools || []).length ? verdict.tools!.join(", ") : "no tools",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {verdict.verdict === "pro" && verdict.headline && verdict.headline !== verdict.title && (
                <p className="verdict-line">{verdict.headline}</p>
              )}
            </section>
            {heard && (
              <p className="evidence-note heard-line">
                Heard: {heard.features.beeps} beep{heard.features.beeps === 1 ? "" : "s"}
                {heard.features.beep_interval_ms ? ` every ${(heard.features.beep_interval_ms / 1000).toFixed(1)} s` : ""}
                {heard.wonder ? ` · Muse Wonder: ${heard.wonder.beeps ?? "?"} beeps` : ""}
                {!heard.agree ? " (they disagree)" : ""}
              </p>
            )}
            <details className="workings">
              <summary>Why I think so</summary>
              {(verdict.based_on || []).length > 0 && (
                <ul>
                  {verdict.based_on!.map((b, i) => <li key={i}>{b}</li>)}
                  {verdict.verdict === "pro" && verdict.rule && <li>safety rule: {verdict.rule}</li>}
                </ul>
              )}
              {verdict.confidence && <p>Confidence: {verdict.confidence}</p>}
              {removed > 0 && (
                <p>The safety rules removed {removed} of the {verdict.proposed_steps} steps the model suggested.</p>
              )}
              {causes.length > 0 && (
                <>
                  <p className="sheet-label">Likely causes</p>
                  <ul>{causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </>
              )}
              {safety.length > 0 && (
                <>
                  <p className="sheet-label">Handle with care</p>
                  <ul>{safety.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </>
              )}
              {resolution && (
                <>
                  <p className="sheet-label">How to tell it worked</p>
                  <p>{resolution}</p>
                </>
              )}
              {inventory.length > 0 && (
                <>
                  <p className="sheet-label">Parts seen</p>
                  <ul>{inventory.map((c, i) => <li key={i}>{c.label}</li>)}</ul>
                </>
              )}
              {(device || (details.markings || []).length > 0) && (
                <>
                  <p className="sheet-label">Read off the device</p>
                  <ul>
                    {device && <li>badge: {device}</li>}
                    {(details.markings || []).map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </>
              )}
              {notes && <p>{notes}</p>}
            </details>
            <div className="walk-links">
              {onListen && (
                <button type="button" className="link-btn" onClick={onListen}>
                  {heard ? "Listen again" : "Let me listen"}
                </button>
              )}
              {onMoreViews && (
                <button type="button" className="link-btn" onClick={onMoreViews}>
                  Add a closer view
                </button>
              )}
            </div>
          </>
        )}

        {screen === "steps" && step && (
          <section className="step-card">
            <div className="step-top">
              <p className="sheet-label">
                {verdict?.verdict === "pro" ? "Safe check" : "Step"} {stepIdx + 1} of {steps.length}
              </p>
              <div className="ticks">
                {steps.map((_, i) => (
                  <span key={i} className={i < stepIdx ? "tick done" : i === stepIdx ? "tick active" : "tick"} />
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
            {stepLoading && (
              <Busy
                compact
                label="Highlighting the part…"
                hint="Marking this step's part on your photo. A few seconds."
                slowAfter={12}
              />
            )}
          </section>
        )}

        {screen === "done" && done && (
          <section className={`done-card ${done.looksFixed === true ? "ok" : done.looksFixed === false ? "bad" : ""}`}>
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
            <div className="done-result" role="status">
              {done.state === "checking" && (
                <Busy label="Checking the after photo…" hint="Muse Spark compares before and after. Usually 5–10 s." slowAfter={15} />
              )}
              {done.state === "error" && "Couldn't run the check. Just tell me below."}
              {done.state === "ok" && done.looksFixed === true && <>✓ {cap(done.seen)}</>}
              {done.state === "ok" && done.looksFixed === false && <>✗ {cap(done.next || done.seen)}</>}
              {done.state === "ok" && done.looksFixed === null && <>Couldn&apos;t see it clearly. {cap(done.next || "")}</>}
            </div>
            {fixed && <p className="done-result">Fixed. {done.seconds < 60 ? `${done.seconds} s` : `${Math.floor(done.seconds / 60)} min ${done.seconds % 60} s`}, ₹0, {steps.length} steps.</p>}
            {stillWrong !== null && !fixed && (
              <form
                className="still-wrong"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendStillWrong();
                }}
              >
                <label className="sheet-label" htmlFor="still-wrong">What&apos;s still not right?</label>
                <input
                  id="still-wrong"
                  className="text-input"
                  value={stillWrong}
                  onChange={(e) => setStillWrong(e.target.value)}
                  placeholder="e.g. still blowing warm air"
                  autoComplete="off"
                />
              </form>
            )}
          </section>
        )}

        {screen === "pros" && (
          <>
            <p className="verdict-line pros-why">
              {verdict?.verdict === "pro" ? verdict.title : verdict?.headline || "Needs a closer look."}
            </p>
            <CallAPro
              api={API}
              trade={trade}
              brief={{
                device: [device, appliance].filter(Boolean).join(" ") || "",
                issue,
                finding: verdict?.headline || causes[0] || "needs a closer look",
                rule: verdict?.verdict === "pro" ? verdict.title : null,
                checks: [
                  ...answered.map((a) => `${a.ask} ${a.reply}`),
                  ...steps.slice(0, Math.max(stepIdx + 1, 1)).map((st) => st.check),
                ],
                sound: heard ? heard.summary : null,
                photo: fileRef.current || null,
                clip: heard?.clip || null,
              }}
            />
          </>
        )}
      </div>

      {/* One clear next action per screen, always in reach. */}
      <div className="walk-cta">
        {screen === "fail" && (
          <>
            <button type="button" className="btn-primary" onClick={() => void run(files, issue, API)}>
              Try again
            </button>
            <button type="button" className="btn-outline" onClick={onClose}>
              Point the camera again
            </button>
          </>
        )}
        {screen === "verdict" && verdict?.verdict === "diy" && steps.length > 0 && (
          <button type="button" className="btn-primary" onClick={showSteps}>
            Show me the steps
          </button>
        )}
        {screen === "verdict" && verdict?.verdict === "pro" && (
          <>
            <button type="button" className="btn-primary" onClick={openPro}>
              Find {article(trade)} {trade}
            </button>
            {steps.length > 0 && (
              <button type="button" className="btn-outline" onClick={showSteps}>
                What can I check safely?
              </button>
            )}
          </>
        )}
        {screen === "steps" && (
          <>
            <button
              type="button"
              className="btn-outline"
              onClick={() => (stepIdx === 0 ? back() : void goStep(stepIdx - 1))}
              disabled={stepLoading}
            >
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                mark("tap", stepIdx < steps.length - 1 ? `next step ${stepIdx + 2}` : "finish steps");
                if (stepIdx < steps.length - 1) void goStep(stepIdx + 1);
                else if (verdict?.verdict === "pro") openPro();
                else void finishFix();
              }}
              disabled={stepLoading}
            >
              {stepLoading
                ? "Highlighting…"
                : stepIdx < steps.length - 1
                  ? "Next step"
                  : verdict?.verdict === "pro"
                    ? `Find ${article(trade)} ${trade}`
                    : "Done, check it"}
            </button>
          </>
        )}
        {screen === "done" && done && done.state !== "checking" && !fixed && stillWrong === null && (
          <>
            <button type="button" className="btn-success" onClick={() => void confirmFixed(true)}>
              It works now
            </button>
            <button type="button" className="btn-outline" onClick={() => void confirmFixed(false)}>
              Still broken
            </button>
          </>
        )}
        {screen === "done" && stillWrong !== null && !fixed && (
          <>
            <button type="button" className="btn-outline" onClick={hearStillWrong} disabled={hearing}>
              {hearing ? "Listening…" : "Say it"}
            </button>
            <button type="button" className="btn-primary" onClick={sendStillWrong} disabled={!stillWrong.trim()}>
              Try again (run {attempt + 1})
            </button>
          </>
        )}
        {screen === "done" && fixed && (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </section>
  );
}
