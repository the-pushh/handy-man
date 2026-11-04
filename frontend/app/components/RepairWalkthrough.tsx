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
import CautionPin from "./CautionPin";
import type { ScanWarning } from "./LiveDetect";
import { paintMasks } from "../lib/masks";
import { getSpeechRecognition } from "../lib/speech";
import { newJobId, putMedia, saveJob, updateJob } from "../lib/history";
import { getSpeech, prefetchSpeech } from "../lib/tts";
import { fetchJSON } from "../lib/net";
import { sendFeedback, type RunFeedback } from "../lib/feedback";
import { agentMode, wantsAgent } from "../lib/agentFlag";
import HypothesisBoard, { toolLabel, type AgentRound, type Hyp } from "./HypothesisBoard";

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

interface AgentAction {
  tool: "ask_user" | "look_closer" | "listen" | "segment";
  why: string;
  question?: string;
  options?: string[];
  part?: string;
  look?: string;
  how?: string;
  what?: string;
}

interface AgentStop {
  reason: "confident" | "max-rounds" | "blocked" | "no-test";
  rule?: string;
  title?: string;
  trade?: string;
  spoken?: string;
  fix_blocked?: { rule: string; title: string; trade: string } | null;
}

const ORANGE = "#e86a17";

const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// A model fragment as a sentence: capitalised, ending in a full stop.
const sentence = (t: string) => {
  const c = cap((t || "").trim());
  return c && !/[.!?]$/.test(c) ? `${c}.` : c;
};

// What is happening during each wait, and how long it usually takes.
const BUSY: Record<string, { hint: string; slowAfter: number }> = {
  "Working it out…": {
    hint: "Reading the photo and what you said, then making sure the plan is safe. Usually 15 to 30 s.",
    slowAfter: 35,
  },
  "Deciding…": { hint: "Working through your answers. Usually 10 to 20 s.", slowAfter: 25 },
  "Outlining parts…": { hint: "Marking the parts on your photo. A few seconds.", slowAfter: 10 },
  "Working out the fix…": { hint: "Turning what the tests found into steps. Usually 10 to 20 s.", slowAfter: 25 },
};

// Phases on one machine: 0 = quick checks, then up to MAX_RUNS rounds of
// diagnosis and fix (phase 1, phase 2); after that, a technician.
const MAX_RUNS = 2;

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
  onLook,
  onHear,
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
  // Agent loop tools: a close photo of one part, and 4 s of sound.
  onLook?: (part: string, how: string, line?: string) => Promise<File | null>;
  onHear?: () => Promise<Heard | null>;
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
    { check: string; how: string; part: string | null; part_look?: string | null; caution?: string | null; rescan?: boolean }[]
  >([]);
  // Scan to check a step (and the rescan after a step that changes the
  // view): where it is, and what the photo showed.
  const [stepScan, setStepScan] = useState<{
    i: number;
    state: "scanning" | "checking" | "result" | "skipped";
    done?: boolean | null;
    seen?: string;
    say?: string;
  } | null>(null);
  // A step that changed the view (panel lifted): ask for a new photo
  // before the next step. The index, or null.
  const [viewAsk, setViewAsk] = useState<number | null>(null);
  const rescanned = useRef<Set<number>>(new Set());
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
  // Phase 0 (first run only): the common quick checks for this machine.
  // While the owner tries them, phase 1's diagnosis is already running
  // (told which checks were tried), so "Still not working" is fast.
  const [quick, setQuick] = useState<{
    state: "off" | "loading" | "ready" | "fixed";
    checks: { check: string; how: string }[];
  }>({ state: "off", checks: [] });
  const earlyRef = useRef<Promise<unknown> | null>(null);
  const quickTried = useRef<string>("");
  // One screen at a time: the verdict (main), then the steps on tap.
  const [view, setView] = useState<"main" | "steps">("main");
  const viewRef = useRef<"main" | "steps">("main");
  // The step on screen, for async results that land after a move.
  const stepRef = useRef<number>(0);
  viewRef.current = view;
  const [stepLoading, setStepLoading] = useState<boolean>(false);
  const [fixed, setFixed] = useState<boolean>(false);
  // Fixed part-way through: the step that did it (1-based), else null.
  const [fixedAt, setFixedAt] = useState<number | null>(null);
  // "Is it working now?" between steps: the step just done, or null.
  // The owner can tick "only ask after the last step" to stop it.
  const [midAsk, setMidAsk] = useState<number | null>(null);
  const [onlyAtEnd, setOnlyAtEnd] = useState<boolean>(false);
  const [onlyAtEndTick, setOnlyAtEndTick] = useState<boolean>(false);
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
  // Agent loop (experimental, agentFlag.ts): the board, the test being
  // run, and how it ended. null = the loop is not in use this run.
  const [agent, setAgent] = useState<{
    hyps: Hyp[];
    rounds: AgentRound[];
    thinking: boolean;
    doing: string;
    asking: { question: string; options: string[]; why: string } | null;
    stop: AgentStop | null;
  } | null>(null);
  const agentAnswer = useRef<((a: string) => void) | null>(null);
  // Feedback loop (lib/feedback.ts): how this run ended, sent only when
  // the owner has not turned learning off in History.
  const outcomeRef = useRef<Pick<RunFeedback, "outcome" | "fixed_by" | "confirmed" | "recheck">>({
    outcome: "",
    fixed_by: "",
    confirmed: null,
    recheck: "",
  });
  const routeRef = useRef<string>("regular");
  const [wasIt, setWasIt] = useState<boolean | null>(null);
  const [whichCheck, setWhichCheck] = useState<string>("");
  const [answered, setAnswered] = useState<{ ask: string; reply: string }[]>([]);
  const answeredRef = useRef<{ ask: string; reply: string }[]>([]);
  const answerResolve = useRef<((a: { ask: string; reply: string }[]) => void) | null>(null);
  // Called when only the last question is left, with the replies so far.
  const lastQuestion = useRef<((sofar: { ask: string; reply: string }[]) => void) | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawToken = useRef<number>(0);
  const fileRef = useRef<File | null>(null);
  // SAM's outlines for this run (a step waits for them instead of
  // racing them), and Muse Image fallbacks prepared ahead per part.
  const samRef = useRef<Promise<Instance[]>>(Promise.resolve([]));
  const highlightRef = useRef<Map<string, Promise<string | null>>>(new Map());
  // Illustrated highlights take ~20 s each: two run at once (two lanes),
  // so step 2's is not stuck behind step 1's.
  const highlightLanes = useRef<Promise<unknown>[]>([Promise.resolve(), Promise.resolve()]);
  const highlightLane = useRef<number>(0);
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

  /* The closest outlined part when the step's own part has none: shares
     a word stem with it ("caps lock key" -> "keyboard", "air filters" ->
     "filter flap"). Shown while the illustration is on its way. */
  function nearMask(part: string | null | undefined, list: Instance[]): number | null {
    if (!part || !list.length) return null;
    const stop = new Set(["the", "and", "for", "with", "its", "of", "on", "at", "to", "a", "an"]);
    const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
    const mine = words(part);
    let best: number | null = null;
    let bestScore = 0;
    list.forEach((inst, i) => {
      const theirs = words(inst.label);
      const hits = mine.filter((w) => theirs.some((x) => x.startsWith(w) || w.startsWith(x))).length;
      const score = hits + (inst.score ?? 0) / 10;
      if (hits && score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
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
    // Only the latest drawing may paint: an older one still waiting for
    // the image must not finish last and bring back other parts' masks.
    const token = ++drawToken.current;
    await new Promise<void>((res) => {
      if (img.complete && img.naturalWidth) res();
      else img.addEventListener("load", () => res(), { once: true });
    });
    if (token !== drawToken.current) return;
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
    // A line hushed before its turn is never fetched, so it cannot hold
    // up the next step's speech.
    const audio = synthQueue.current.then(() => (gen === speechGen.current ? fetchSpeech(line, maxSeconds) : null));
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
    const blob = await getSpeech(API, line, "en", maxSeconds ?? null);
    return blob ? URL.createObjectURL(blob) : null;
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
    if (attempt === 1 && !followUp) void startQuick();
    else void run(files, issue, API);
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

  /* The diagnostic agent loop (backend/agent.py). Each round the server
     updates the possible causes and picks one test; the phone runs it
     (a question, a close photo, a sound, an outline) and sends the
     result back. Returns the findings for the final diagnosis, the
     escalation when a rule blocks the next test, or null to fall back
     to the regular flow. */
  async function agentLoop(
    fs: File[],
    ask: string,
    base: string,
    myRun: number
  ): Promise<{ kind: "findings"; text: string; sound: string } | { kind: "escalate"; stop: AgentStop; hyps: Hyp[] } | null> {
    const state: { seen: string; hypotheses: Hyp[]; history: { action: AgentAction; result: string }[] } = {
      seen: "",
      hypotheses: [],
      history: [],
    };
    let image: File | null = fs[fs.length - 1] || null;
    let sound = heard?.summary || "";
    const rounds: AgentRound[] = [];
    setAgent({ hyps: [], rounds: [], thinking: true, doing: "", asking: null, stop: null });
    mark("agent loop start");
    for (let guard = 0; guard < 8; guard++) {
      const fd = new FormData();
      fd.append("machine", machine || appliance || "");
      fd.append("issue", ask);
      fd.append("state", JSON.stringify(state));
      if (image) fd.append("file", image, "still.jpg");
      setAgent((a) => a && { ...a, thinking: true, doing: "", asking: null });
      const t0 = performance.now();
      let d;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        d = await fetchJSON<any>(`${base}/api/agent/step`, { method: "POST", body: fd }, { label: "agent step", timeoutMs: 30000 });
      } catch (e) {
        mark("agent step failed", (e as Error).message);
        return null;
      }
      if (myRun !== runSeq.current) return null;
      mark("agent round", `${d.round} ${((performance.now() - t0) / 1000).toFixed(1)}s ${d.stop ? `stop ${d.stop.reason}` : d.action?.tool}`);
      if (d.status !== "ok") return null;
      state.seen = d.seen || state.seen;
      state.hypotheses = d.hypotheses || state.hypotheses;
      if (d.stop) {
        const stop = d.stop as AgentStop;
        setAgent((a) => a && { ...a, hyps: state.hypotheses, thinking: false, stop });
        if (stop.reason === "blocked") return { kind: "escalate", stop, hyps: state.hypotheses };
        return { kind: "findings", text: d.findings || "", sound };
      }
      const action = d.action as AgentAction;
      const label =
        action.question || (action.part ? `the ${action.part}` : action.what ? `for ${action.what}` : "");
      rounds.push({ n: rounds.length + 1, tool: action.tool, label, why: action.why });
      setAgent((a) => a && { ...a, hyps: state.hypotheses, rounds: [...rounds], thinking: false });
      const res = await runAgentTool(action, fs, base);
      if (myRun !== runSeq.current) return null;
      if (res.sound) sound = res.sound;
      rounds[rounds.length - 1] = { ...rounds[rounds.length - 1], result: res.shown };
      setAgent((a) => a && { ...a, rounds: [...rounds] });
      state.history.push({ action, result: res.text });
      image = res.image;
    }
    return null;
  }

  /* Run one test on the phone. `text` goes to the model, `shown` to the
     board; a close photo comes back as `image`. */
  async function runAgentTool(
    a: AgentAction,
    fs: File[],
    base: string
  ): Promise<{ text: string; shown: string; image: File | null; sound?: string }> {
    if (a.tool === "ask_user") {
      const options = [...(a.options || []), "Not sure"].filter(
        (o, i, all) => all.findIndex((x) => x.toLowerCase() === o.toLowerCase()) === i
      );
      setAgent((s) => s && { ...s, asking: { question: a.question || "", options, why: a.why } });
      void say(a.question || "");
      const answer = await new Promise<string>((res) => {
        agentAnswer.current = res;
      });
      hush();
      setAgent((s) => s && { ...s, asking: null });
      return { text: answer, shown: answer, image: null };
    }
    if (a.tool === "look_closer" && a.part) {
      setAgent((s) => s && { ...s, doing: `Show me the ${a.part}` });
      const still = onLook ? await onLook(a.part, a.how || "") : null;
      setAgent((s) => s && { ...s, doing: "" });
      if (!still) return { text: "The owner could not take the close photo.", shown: "No photo", image: null };
      return { text: `Close photo of the ${a.part} attached.`, shown: "Photo taken", image: still };
    }
    if (a.tool === "listen") {
      setAgent((s) => s && { ...s, doing: "Listening" });
      const h = onHear ? await onHear() : null;
      setAgent((s) => s && { ...s, doing: "" });
      if (!h || !h.summary) return { text: "No usable recording.", shown: "Couldn't record", image: null };
      return { text: h.summary, shown: h.summary, image: null, sound: h.summary };
    }
    if (a.tool === "segment" && a.part) {
      setAgent((s) => s && { ...s, doing: `Outlining the ${a.part}` });
      const sfd = new FormData();
      sfd.append("file", fs[fs.length - 1]);
      sfd.append("labels", JSON.stringify([{ label: a.part, look: a.look || "" }]));
      let found: Instance[] = [];
      try {
        found = (
          await fetchJSON<{ instances?: Instance[] }>(`${base}/api/segment`, { method: "POST", body: sfd }, { label: "agent segment", timeoutMs: 20000 })
        ).instances || [];
      } catch (_) {
        found = [];
      }
      setAgent((s) => s && { ...s, doing: "" });
      if (!found.length) return { text: `The ${a.part} was not found on the photo.`, shown: "Not found on the photo", image: null };
      setInstances(found);
      showStepMasks(null, found);
      const best = found.reduce((x, y) => ((y.score ?? 0) > (x.score ?? 0) ? y : x));
      const b = best.box;
      return {
        text: `Outlined the ${a.part} (score ${(best.score ?? 0).toFixed(2)}) at x ${b.x.toFixed(2)}, y ${b.y.toFixed(2)}, size ${b.w.toFixed(2)} by ${b.h.toFixed(2)} of the photo.`,
        shown: `Found, ${Math.round((best.score ?? 0) * 100)}% match`,
        image: null,
      };
    }
    return { text: "The test could not run.", shown: "Skipped", image: null };
  }

  /* The next test is blocked by a safety rule: stop here and send the
     owner to a handyman, saying which rule and the most likely cause. */
  function escalateFromAgent(stop: AgentStop, hyps: Hyp[], fs: File[], t: string): void {
    const top = hyps[0];
    const v: Verdict = {
      verdict: "pro",
      rule: stop.rule || null,
      title: stop.title || "This needs a handyman.",
      headline: top ? `Most likely ${top.cause.toLowerCase()} (${Math.round(top.p * 100)}%).` : "",
      trade: stop.trade || null,
      fired: stop.rule ? [stop.rule] : [],
      blocked_steps: [],
      proposed_steps: 0,
    };
    setStatus("");
    setSteps([]);
    setCauses(hyps.map((h) => h.cause));
    if (machine || appliance) setDevice(machine || appliance);
    setVerdict(v);
    mark("verdict", `pro ${v.rule} (agent: next test blocked)`);
    if (!jobId.current) {
      const id = newJobId();
      jobId.current = id;
      saveJob({
        id,
        date: new Date().toISOString(),
        device: machine || appliance || "device",
        issue: t,
        verdict: "pro",
        rule: v.rule,
        ruleTitle: v.title,
        headline: v.headline,
        trade: v.trade,
        steps: [],
        answers: (agent?.rounds || []).map((r) => ({ ask: r.label, reply: r.result || "" })),
        outcome: null,
        finding: v.headline,
        sound: heard ? heard.summary : null,
        media: {},
        machine: machine || appliance || "device",
        attempt,
        parentId,
        riskAccepted: null,
      });
      void putMedia(id, "before", fs[0]);
    }
    void say(`${stop.spoken || "This one needs a handyman."} You can call a handyman from here.`);
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
    const ask = followUp ? `${t}. ${followUp}` : quickTried.current ? `${t}. ${quickTried.current}` : t;
    const risk = acceptRisk?.rule || "";
    // Spoken while the analysis runs, not before it starts.
    void say(attempt > 1 ? `Run ${attempt}. Working out what's still wrong.` : "Working out what's wrong.");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any = null;
      // Experimental agent loop: tests until one cause is clear, then the
      // regular diagnosis turns its findings into steps. Any failure
      // falls through to the regular flow below.
      let viaAgent = false;
      let goAgent = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let firstPass: any = null;
      const mode = agentMode();
      if (mode !== "off" && attempt === 1 && !followUp && !prefetched) {
        // The router: the first pass (already running since the quick
        // checks) says whether one cause stands out. Clear cases keep it
        // and take the regular fix; unclear ones go to the agent's tests.
        const first = mode === "auto" && earlyRef.current ? await earlyRef.current.catch(() => null) : null;
        firstPass = first;
        if (myRun !== runSeq.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pick = wantsAgent(mode, first as any);
        mark("route", `${pick.agent ? "agent" : "regular"}: ${pick.why}`);
        routeRef.current = `${pick.agent ? "agent" : "regular"}: ${pick.why}`;
        goAgent = pick.agent;
        if (!goAgent) {
          data = first; // null (the first pass failed) asks afresh below
        } else {
          earlyRef.current = null;
        }
      }
      if (goAgent) {
        const res = await agentLoop(fs, ask, base, myRun);
        if (myRun !== runSeq.current) return;
        if (res?.kind === "escalate") {
          earlyRef.current = null;
          escalateFromAgent(res.stop, res.hyps, fs, t);
          return;
        }
        if (res?.kind === "findings") {
          viaAgent = true;
          setStatus("Working out the fix…");
          data = await requestDiagnosis(base, fs, ask, perception, res.sound, res.text, false, risk);
        } else {
          mark("agent loop fell back to the regular flow");
          setAgent(null);
          if (firstPass?.status === "ok") data = firstPass;
        }
      }
      if (!data) {
        data =
          (prefetched ? await prefetched : null) ||
          (earlyRef.current ? await earlyRef.current.catch(() => null) : null) ||
          (await requestDiagnosis(base, fs, ask, perception, heard?.summary || "", "", false, risk));
      }
      earlyRef.current = null; // used once; "Try again" asks afresh
      // Questions first: the owner looks, taps an answer, and the server
      // decides with those answers (one more diagnose, no re-perceive).
      // The agent already asked its questions.
      const qs: Question[] = data.status === "ok" && !viaAgent ? data.questions || [] : [];
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
              rescan: (s as { rescan?: boolean }).rescan === true,
              part_look: (s as { part_look?: string }).part_look || null,
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
            const sd = await fetchJSON<{ instances?: Instance[] }>(
              `${base}/api/segment`,
              { method: "POST", body: sfd },
              { label: "segment", timeoutMs: 20000 }
            );
            return sd.instances || [];
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
          // Steps SAM missed: their illustrations are saved to History as
          // they arrive, whether or not the owner opens those steps.
          for (const part of missed) {
            void fetchHighlight(part, still, base, data.legend || []).then((url) => {
              if (!url || myRun !== runSeq.current) return;
              foundSteps.forEach((st: { part: string | null }, i: number) => {
                if (st.part && st.part.toLowerCase() === part.toLowerCase()) void saveStepPicture(i, still, [], url);
              });
            });
          }
          // History keeps each step's picture as the owner saw it.
          foundSteps.forEach((st: { part: string | null }, i: number) => {
            const mine = masksFor(st.part, sam).map((k) => sam[k]);
            if (mine.length) void saveStepPicture(i, still, mine, "");
          });
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
          steps: foundSteps.map((st: { check: string; how: string; caution?: string | null; part: string | null }) => ({
            check: st.check,
            how: st.how,
            caution: st.caution || null,
            part: st.part,
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
        // Every step's lines, fetched now while the owner reads the
        // verdict, so each step starts speaking the moment it opens.
        const total = foundSteps.length;
        prefetchSpeech(API, [
          ...foundSteps.flatMap((st: { check: string; how: string; caution?: string | null }, i: number) =>
            stepLines(st, i, total, null)),
          ...["A", "B", "C", "D"].slice(0, Math.min(4, total + 1)).map((t) => `Look for ${t} on the photo.`),
          "Is it working now?",
          "Great. It's fixed.",
          "What's still not right?",
        ]);
        // Skipped when the owner already tapped through to the steps.
        if (viewRef.current !== "steps") {
          void say(v.verdict === "pro" ? "You can call a handyman from here." : "Tap show me the steps when you're ready.");
        }
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

  /* What a step says, in short pieces: the first is a small clip that
     starts at once, the rest follow. Prefetched when the verdict lands. */
  function stepLines(
    st: { check: string; how: string; caution?: string | null },
    i: number,
    total: number,
    tag: string | null
  ): string[] {
    return [
      `Step ${i + 1} of ${total}. ${st.check}.`,
      st.how,
      tag ? `Look for ${tag} on the photo.` : "",
      st.caution ? `Careful. ${st.caution}` : "",
    ].filter(Boolean);
  }

  async function speakStep(
    st: { check: string; how: string; part: string | null; caution?: string | null },
    i: number,
    total: number,
    leg: { label: string; tag?: string }[] = legend
  ): Promise<void> {
    const parts = stepLines(st, i, total, tagFor(st.part, leg));
    let last: Promise<void> = Promise.resolve();
    for (const p of parts) last = say(p);
    await last;
  }

  /* Muse Image highlight for one part, made once and reused. Requests
     run in two lanes, so the next step's is not stuck behind another. */
  function fetchHighlight(
    part: string,
    still: File,
    base: string,
    leg: { label: string; color: string; tag?: string }[]
  ): Promise<string | null> {
    const key = part.toLowerCase();
    const have = highlightRef.current.get(key);
    if (have) return have;
    const lane = highlightLane.current++ % highlightLanes.current.length;
    const job = highlightLanes.current[lane].then(async () => {
      const fd = new FormData();
      fd.append("file", still);
      fd.append("part", part);
      fd.append("legend", JSON.stringify(leg));
      mark("highlight requested", part);
      try {
        const d = await fetchJSON<{ status: string; overlay?: { image_b64: string; mime?: string; legend?: { label: string; color: string; tag?: string }[] } }>(
          `${base}/api/repair/highlight`,
          { method: "POST", body: fd },
          { label: `highlight ${part}`, timeoutMs: 60000 }
        );
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
    highlightLanes.current[lane] = job.catch(() => null);
    highlightRef.current.set(key, job);
    return job;
  }

  /* One step's picture for History: the photo with the part's SAM
     outline painted on, or the illustrated highlight as shown. */
  async function saveStepPicture(i: number, still: File, masks: Instance[], illustrated: string): Promise<void> {
    const id = jobId.current;
    if (!id) return;
    try {
      let blob: Blob | null = null;
      if (illustrated) {
        blob = await (await fetch(illustrated)).blob();
      } else if (masks.length) {
        const bmp = await createImageBitmap(still);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(bmp, 0, 0);
        await paintMasks(ctx, masks);
        ctx.strokeStyle = ORANGE;
        ctx.lineWidth = Math.max(2, c.width / 200);
        for (const m of masks) ctx.strokeRect(m.box.x * c.width, m.box.y * c.height, m.box.w * c.width, m.box.h * c.height);
        blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.8));
      }
      if (blob) await putMedia(id, `step${i}`, blob);
    } catch (_) {
      // History just shows the plain photo for this step.
    }
  }

  async function goStep(i: number): Promise<void> {
    if (i < 0 || i >= steps.length || !fileRef.current) return;
    hush(); // the previous step never talks over this one
    setStepIdx(i);
    stepRef.current = i;
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
      const job = fetchHighlight(st.part, fileRef.current, API, legend);
      // Ready already (prefetched while the verdict showed)?
      const ready = await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
      if (ready) {
        setOverlayURL(ready);
        void saveStepPicture(i, fileRef.current, [], ready);
        mark("step highlight", `${i + 1}: illustrated for ${st.part}`);
      } else {
        // Never an empty step: the nearest outlined part right away, the
        // illustration swapped in when it lands (if still on this step).
        const near = nearMask(st.part, sam);
        setOverlayURL("");
        if (near !== null) {
          const hide = new Set<number>(sam.map((_, k) => k).filter((k) => k !== near));
          setHidden(hide);
          void drawMasks(sam, hide);
          mark("step highlight", `${i + 1}: nearest outline ${sam[near].label} for ${st.part}, illustration coming`);
          setStepLoading(false);
        }
        const url = await job;
        if (stepRef.current === i && url) {
          setOverlayURL(url);
          void saveStepPicture(i, fileRef.current, [], url);
        }
        mark("step highlight", `${i + 1}: ${url ? "illustrated" : "none"} for ${st.part}`);
      }
    }
    // A late result for a step the owner already left must not clear the
    // loading state of the step now on screen.
    if (stepRef.current === i) setStepLoading(false);
    await spoken;
  }

  /* Last step done: camera re-check of the part, then the Done card. */
  /* `early`: the owner said "It's working" after this step (1-based).
     The after photo is still taken and compared, but they are not asked
     again: the run closes as fixed once the photo is in. */
  async function finishFix(early: number | null = null): Promise<void> {
    const part = focus || steps.find((s) => s.part)?.part || null;
    hush();
    const seconds = Math.round(turnElapsed());
    if (early !== null) {
      askedFixed.current = true;
      setFixedAt(early);
    }
    const closeFixed = () => {
      if (early === null) return;
      setFixed(true);
      if (jobId.current) updateJob(jobId.current, { outcome: "fixed", seconds });
      report({ outcome: "fixed", fixed_by: `step ${early}` });
      void say("Great. It's fixed.");
    };
    const after = onRecheck ? await onRecheck(part) : null;
    afterRef.current = after;
    if (!after) {
      setDone({ afterURL: "", state: "error", looksFixed: null, seen: "", next: null, seconds });
      closeFixed();
      return;
    }
    setDone({ afterURL: URL.createObjectURL(after), state: "checking", looksFixed: null, seen: "", next: null, seconds });
    mark("recheck sent", part || "");
    const fd = new FormData();
    fd.append("before", files[0], "before.jpg");
    fd.append("after", after, "after.jpg");
    const last = steps[early !== null ? early - 1 : steps.length - 1];
    fd.append("fix", `${verdict?.headline || ""} Last step: ${last ? `${last.check}. ${last.how}` : ""}`);
    if (part) fd.append("part", part);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await fetchJSON<any>(`${API}/api/recheck`, { method: "POST", body: fd }, { label: "recheck", timeoutMs: 40000 });
      mark("recheck", `${r.status} looks_fixed=${r.looks_fixed}`);
      outcomeRef.current.recheck = `${r.looks_fixed}: ${r.seen || r.next || ""}`;
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
      closeFixed();
    } catch (_) {
      setDone((d) => d && { ...d, state: "error" });
      closeFixed();
      return;
    }
  }

  /* Next on a step that is not the last: ask whether that already fixed
     it, unless the owner asked to be asked only at the end. */
  /* Scan one step: the camera frames the part (or the whole machine after
     a view change), the server checks the step against the new photo and
     says what to do now. After a step that changed the view the new photo
     becomes the working photo and the next steps are outlined on it. */
  async function scanStep(i: number, reason: "check" | "view"): Promise<boolean | null | undefined> {
    const st = steps[i];
    if (!st || !onLook) return;
    hush();
    const whole = machine || appliance || device || "machine";
    const target = reason === "view" ? whole : st.part || whole;
    const line =
      reason === "view"
        ? `Now show me the ${whole} again, as it looks now, so I can guide the next step.`
        : `Show me the ${target} so I can check this step.`;
    setStepScan({ i, state: "scanning" });
    mark("step scan", `${reason} step ${i + 1}: ${target}`);
    const still = await onLook(target, "", line);
    if (!still) {
      setStepScan({ i, state: "skipped" });
      return undefined;
    }
    setStepScan({ i, state: "checking" });
    const fd = new FormData();
    fd.append("file", still, "step.jpg");
    fd.append("machine", whole);
    fd.append("issue", issue);
    fd.append("step", JSON.stringify(st));
    if (steps[i + 1]) fd.append("next_step", JSON.stringify(steps[i + 1]));
    let r: { status?: string; done?: boolean | null; seen?: string; say?: string } = {};
    try {
      r = await fetchJSON(`${API}/api/step/check`, { method: "POST", body: fd }, { label: "step check", timeoutMs: 30000 });
    } catch (_) {
      r = {};
    }
    mark("step check", `step ${i + 1}: done=${r.done} "${(r.say || "").slice(0, 60)}"`);
    setStepScan({ i, state: "result", done: r.done ?? null, seen: r.seen || "", say: r.say || "" });
    if (r.say) void say(r.say);
    // Only a view that really changed replaces the working photo: a
    // "not done yet" (panel still closed) keeps the old one.
    if ((reason === "view" || st.rescan) && r.done !== false) adoptView(still, i);
    return r.done ?? null;
  }

  /* The machine looks different now: the new photo is the working photo
     for the remaining steps, and SAM outlines their parts on it. */
  function adoptView(still: File, fromStep: number): void {
    rescanned.current.add(fromStep);
    fileRef.current = still;
    setImgURL(URL.createObjectURL(still));
    setOverlayURL("");
    setInstances([]);
    highlightRef.current = new Map();
    // Each remaining part with its plain-words look ("memory module",
    // "round grey cap"): SAM finds parts by those far more often.
    const seen = new Set<string>();
    const labels = steps
      .slice(fromStep + 1)
      .filter((s) => s.part && !seen.has(s.part.toLowerCase()) && seen.add(s.part.toLowerCase()))
      .map((s) => ({ label: s.part as string, look: s.part_look || "" }))
      .slice(0, 4);
    mark("view adopted", `step ${fromStep + 1}; outlining ${labels.map((l) => l.label).join(", ") || "nothing"}`);
    samRef.current = labels.length
      ? (async () => {
          const sfd = new FormData();
          sfd.append("file", still);
          sfd.append("labels", JSON.stringify(labels));
          try {
            const sd = await fetchJSON<{ instances?: Instance[] }>(`${API}/api/segment`, { method: "POST", body: sfd }, { label: "segment (new view)", timeoutMs: 20000 });
            return sd.instances || [];
          } catch (_) {
            return [] as Instance[];
          }
        })()
      : Promise.resolve([]);
    void samRef.current.then((sam) => setInstances(sam));
  }

  async function viewScanThenNext(scan: boolean): Promise<void> {
    const i = viewAsk ?? stepIdx;
    setViewAsk(null);
    mark("tap", scan ? `rescan after step ${i + 1}` : `skipped rescan after step ${i + 1}`);
    if (!scan) {
      rescanned.current.add(i);
      nextStep(true);
      return;
    }
    const done = await scanStep(i, "view");
    // The photo shows the step is not done yet (panel still closed): stay
    // on it. The spoken line says what to do; Next asks for a new photo
    // again, and Skip in that prompt moves on regardless.
    if (done === false) {
      mark("stayed on step", `${i + 1}: not done yet`);
      return;
    }
    nextStep(true);
  }

  function nextStep(skipViewAsk = false): void {
    const i = stepIdx;
    // This step changed what the camera sees (a panel lifted, filters
    // out): a new photo first, so the next step points at the right spot.
    if (!skipViewAsk && steps[i]?.rescan && i < steps.length - 1 && !rescanned.current.has(i)) {
      hush();
      setViewAsk(i);
      mark("asked rescan", `after step ${i + 1} changed the view`);
      void say("The view has changed. Take a new picture so I can show you the next part.");
      return;
    }
    if (verdict?.verdict === "diy" && !onlyAtEnd) {
      hush();
      setOnlyAtEndTick(false);
      setMidAsk(i);
      mark("asked mid-fix", `after step ${i + 1}`);
      void say("Is it working now?");
      return;
    }
    void goStep(i + 1);
  }

  function midAnswer(working: boolean): void {
    const i = midAsk ?? stepIdx;
    if (onlyAtEndTick) setOnlyAtEnd(true);
    setMidAsk(null);
    mark("tap", `${working ? "working" : "not yet"} after step ${i + 1}${onlyAtEndTick ? " (ask at end only)" : ""}`);
    if (!working) {
      void goStep(i + 1);
      return;
    }
    // Fixed early: still take the exit photo (the same after-fix scan
    // as the last step), then close the run as fixed without asking again.
    void finishFix(i + 1);
  }

  /* This run's outcome for the feedback loop (sent only when shared). */
  function report(update: Partial<Pick<RunFeedback, "outcome" | "fixed_by" | "confirmed" | "recheck">> = {}): void {
    Object.assign(outcomeRef.current, update);
    if (!jobId.current) return;
    sendFeedback(API, {
      id: jobId.current,
      parent_id: parentId || null,
      machine: machine || appliance || device || "",
      said: issue,
      route: routeRef.current,
      finding: verdict?.headline || "",
      verdict: verdict?.verdict || "",
      rule: verdict?.rule || null,
      ...outcomeRef.current,
      tests: (agent?.rounds || []).map((r) => `${toolLabel(r.tool)}: ${r.label} -> ${r.result || ""}`),
      answers: answered.map((a) => `${a.ask} ${a.reply}`).join(" "),
      app: "web",
    });
  }

  /* "Find a pro" from a pro verdict: that is this job's outcome. */
  function openPro(): void {
    setBooking(true);
    if (jobId.current) updateJob(jobId.current, { outcome: "called a pro" });
    report({ outcome: "handyman" });
  }

  // After the run's re-check: ask out loud whether it is fixed.
  useEffect(() => {
    if (!done || done.state === "checking" || askedFixed.current) return;
    askedFixed.current = true;
    void say("Is it working now?");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done?.state]);

  async function confirmFixed(yes: boolean): Promise<void> {
    if (jobId.current) updateJob(jobId.current, { outcome: yes ? "fixed" : "still broken" });
    report({ outcome: yes ? "fixed" : "still broken", fixed_by: yes ? `all ${steps.length} steps` : "" });
    if (yes) {
      setFixed(true);
      void say("Great. It's fixed.");
      return;
    }
    if (attempt >= MAX_RUNS || !onRetry) {
      // Enough runs on this machine: a technician is the answer now.
      setBooking(true);
      if (jobId.current) updateJob(jobId.current, { outcome: "called a pro" });
      report({ outcome: "handyman" });
      await say(`That's the quick checks and ${attempt} tries. Leave it to a handyman. Here's who can help nearby.`);
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


  /* Phase 0: fetch the quick checks, show and say them, and start phase
     1's diagnosis in the background. Without checks, straight to phase 1. */
  async function startQuick(): Promise<void> {
    setQuick({ state: "loading", checks: [] });
    let checks: { check: string; how: string }[] = [];
    try {
      const r = await fetch(`${API}/api/quick-checks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine: machine || "", issue }),
        signal: AbortSignal.timeout(20000),
      });
      const d = await r.json();
      checks = d.status === "ok" ? d.checks || [] : [];
    } catch (_) {
      checks = [];
    }
    mark("quick checks", `${checks.length}: ${checks.map((c) => c.check).join(" | ")}`);
    if (!checks.length) {
      setQuick({ state: "off", checks: [] });
      void run(files, issue, API);
      return;
    }
    quickTried.current =
      `Quick checks already tried, still not working: ${checks.map((c) => c.check).join("; ")}. ` +
      "Do not repeat them.";
    earlyRef.current = requestDiagnosis(
      API,
      files,
      `${issue}. ${quickTried.current}`,
      perception,
      heard?.summary || "",
      "",
      false,
      acceptRisk?.rule || ""
    ).catch(() => null);
    setQuick({ state: "ready", checks });
    void say("Before we dig in, try these quick checks.");
    checks.forEach((c, i) => void say(`${i + 1}. ${c.check}. ${c.how}`));
  }

  function quickResult(fixedIt: boolean): void {
    hush();
    mark("tap", fixedIt ? "quick check fixed it" : "still not working after quick checks");
    if (!fixedIt) {
      setQuick((q) => ({ ...q, state: "off" }));
      void run(files, issue, API);
      return;
    }
    earlyRef.current = null;
    setQuick((q) => ({ ...q, state: "fixed" }));
    const id = newJobId();
    jobId.current = id;
    saveJob({
      id,
      date: new Date().toISOString(),
      device: machine || "device",
      issue,
      verdict: "diy",
      rule: null,
      ruleTitle: null,
      headline: "Fixed by a quick check.",
      trade: null,
      steps: quick.checks.map((c) => ({ check: c.check, how: c.how, caution: null, part: null })),
      answers: [],
      outcome: "fixed",
      finding: "Fixed by a quick check",
      sound: heard ? heard.summary : null,
      media: {},
      machine: machine || "device",
      attempt: 1,
      parentId,
      riskAccepted: acceptRisk ? { rule: acceptRisk.rule, title: acceptRisk.title } : null,
    });
    void putMedia(id, "before", files[0]);
    // fixed_by is set when the owner says which check did it.
    report({ outcome: "fixed by quick check", fixed_by: "" });
    void say("Great. Fixed with a quick check.");
  }

  function showSteps(): void {
    mark("tap", "show me the steps");
    viewRef.current = "steps";
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
  const name = appliance || machine || device || "your device";
  const removed = verdict?.blocked_steps.length || 0;
  const trade = verdict?.trade || "technician";
  const screen: "quick" | "fail" | "pros" | "done" | "steps" | "verdict" | "question" | "agent" | "working" =
    quick.state !== "off"
    ? "quick"
    : failure
    ? "fail"
    : booking
      ? "pros"
      : done
        ? "done"
        : view === "steps" && steps.length
          ? "steps"
          : verdict
            ? "verdict"
            : agent && !agent.stop
              ? "agent"
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
            {screen === "quick"
              ? " · quick checks"
              : ` · ${attempt === 1 ? "fix" : `try ${attempt} of ${MAX_RUNS}`}`}
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
            <figcaption>An illustration of where to look, not traced from your photo</figcaption>
          ) : instances.length > 0 && screen !== "steps" ? (
            <figcaption>
              Parts found{" "}
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

      <div className={`walk-body${screen === "done" ? " confirm-body" : ""}`}>
        {screen === "quick" && quick.state === "loading" && (
          <Busy
            label="Finding the usual quick checks…"
            hint="Listing what most people try first. A few seconds."
            slowAfter={12}
          />
        )}
        {screen === "quick" && quick.state === "ready" && (
          <section className="step-card quick-card">
            <p className="sheet-label">Quick checks first</p>
            <p className="instruction">Try these before we dig in</p>
            <ol className="quick-list">
              {quick.checks.map((c, i) => (
                <li key={i}>
                  <strong>{c.check}</strong>
                  {c.how && <span>{c.how}</span>}
                </li>
              ))}
            </ol>
          </section>
        )}
        {screen === "quick" && quick.state === "fixed" && (
          <section className="verdict-card diy">
            <p className="verdict-title">Fixed</p>
            <p className="verdict-finding">A quick check did it. Saved to History.</p>
            {quick.checks.length > 1 && (
              // Which check did it: saved with the run, and (when shared)
              // it moves that check up for the next owner with this fault.
              <div className="which-check">
                <p className="was-it-q">Which one did it?</p>
                <div className="chips">
                  {quick.checks.map((c) => (
                    <button
                      key={c.check}
                      type="button"
                      className={`chip${whichCheck === c.check ? " on" : ""}`}
                      onClick={() => {
                        setWhichCheck(c.check);
                        mark("tap", `quick check that fixed it: ${c.check}`);
                        if (jobId.current) updateJob(jobId.current, { finding: `Fixed by: ${c.check}` });
                        report({ fixed_by: c.check });
                      }}
                    >
                      {c.check}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

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

        {screen === "agent" && agent && (
          <HypothesisBoard
            hyps={agent.hyps}
            rounds={agent.rounds}
            thinking={agent.thinking}
            note={agent.rounds.length === 0 ? "More than one cause fits, so a few quick tests first." : ""}
          >
            {agent.asking && (
              <section className="question-card agent-ask" aria-live="polite">
                <p className="question">{agent.asking.question}</p>
                <div className="chips">
                  {agent.asking.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className="chip"
                      onClick={() => {
                        mark("tap", `agent answer: ${o}`);
                        agentAnswer.current?.(o);
                        agentAnswer.current = null;
                      }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {agent.doing && <p className="instruction agent-doing">{agent.doing}…</p>}
          </HypothesisBoard>
        )}
        {screen === "working" && agent && agent.hyps.length > 0 && (
          <HypothesisBoard hyps={agent.hyps} rounds={agent.rounds} thinking={false} compact />
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
                {verdict.verdict === "pro" ? "Call a handyman" : acceptRisk ? "At your own risk" : "You can fix this"}
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
              {agent?.stop?.reason === "blocked" && (
                <p className="callout callout-caution agent-blocked">
                  Next test blocked by rule: {agent.stop.title}
                </p>
              )}
            </section>
            {agent && agent.rounds.length > 0 && (
              <details className="workings agent-workings">
                <summary>How I got here ({agent.rounds.length} test{agent.rounds.length === 1 ? "" : "s"})</summary>
                <HypothesisBoard hyps={agent.hyps} rounds={agent.rounds} thinking={false} compact />
              </details>
            )}
            {heard && (
              <p className="evidence-note heard-line">
                Heard: {heard.features.beeps} beep{heard.features.beeps === 1 ? "" : "s"}
                {heard.features.beep_interval_ms ? ` every ${(heard.features.beep_interval_ms / 1000).toFixed(1)} s` : ""}
                {heard.wonder ? ` · second listen ${heard.wonder.beeps ?? "?"} beeps` : ""}
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
          <section className={`step-card${step.caution ? " has-caution" : ""}`}>
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
            {stepScan && stepScan.i === stepIdx && stepScan.state === "checking" && (
              <Busy compact label="Checking this step…" hint="Looking at your new photo. A few seconds." slowAfter={10} />
            )}
            {stepScan && stepScan.i === stepIdx && stepScan.state === "result" && (
              <div className={`step-scan ${stepScan.done === true ? "ok" : stepScan.done === false ? "bad" : ""}`} role="status">
                <p className="step-scan-head">
                  {stepScan.done === true ? "✓ Looks done" : stepScan.done === false ? "✗ Not done yet" : "Couldn't tell from the photo"}
                  {stepScan.seen ? `. ${stepScan.seen.replace(/\.$/, "")}.` : ""}
                </p>
                {stepScan.say && <p className="step-scan-say">{stepScan.say}</p>}
              </div>
            )}
            {onLook && (!stepScan || stepScan.i !== stepIdx || stepScan.state !== "checking") && (
              <button type="button" className="link-btn step-scan-btn" onClick={() => void scanStep(stepIdx, "check")}>
                Scan to check this step
              </button>
            )}
            {step.caution && <CautionPin text={step.caution} />}
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
          <>
            {/* Looks like the camera screen: the after photo fills the
                frame, the before photo sits in the corner, the result
                reads along the bottom, and the bar below answers. */}
            <div className={`cutout confirm-frame ${done.looksFixed === true || fixed ? "ok" : done.looksFixed === false ? "bad" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="confirm-img" src={done.afterURL || stillURLs[0] || imgURL} alt={done.afterURL ? "after the fix" : "your photo"} />
              {done.afterURL && (
                <figure className="confirm-before">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={stillURLs[0] || imgURL} alt="before the fix" />
                  <figcaption>Before</figcaption>
                </figure>
              )}
              <span className="crop tl" />
              <span className="crop tr" />
              <span className="crop bl" />
              <span className="crop br" />
              {done.state === "checking" && (
                <div className="live-busy">
                  <Busy compact label="Checking the fix…" hint="Comparing before and after. Usually 5 to 10 s." slowAfter={15} />
                </div>
              )}
              <div className="cutout-bar" role="status">
                {fixed
                  ? `Fixed${fixedAt ? ` after step ${fixedAt}` : ""}. ${done.seconds < 60 ? `${done.seconds} s` : `${Math.floor(done.seconds / 60)} min ${done.seconds % 60} s`}, ₹0.`
                  : done.state === "checking"
                    ? "Checking the fix…"
                    : done.state === "error"
                      ? "Couldn't check the photo. Is it working now?"
                      : done.looksFixed === true
                        ? `Looks fixed. ${sentence(done.seen)} Is it working now?`
                        : done.looksFixed === false
                          ? `${sentence(done.next || done.seen)} Is it working now?`
                          : "Couldn't see it clearly. Is it working now?"}
              </div>
            </div>
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
                  placeholder="Like “still blowing warm air”"
                  autoComplete="off"
                />
              </form>
            )}
          </>
        )}

        {screen === "done" && done && done.state !== "checking" && fixed && verdict?.headline && (
          // The owner confirms the finding: the strongest signal the
          // learning loop gets (lib/feedback.ts).
          <section className="share-result">
            <div className="was-it">
              <p className="was-it-q">Was it {verdict.headline.replace(/^Looks like /i, "").replace(/\.$/, "").toLowerCase()}?</p>
              <div className="chips">
                {[
                  { label: "Yes", v: true },
                  { label: "Not quite", v: false },
                ].map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    className={`chip${wasIt === o.v ? " on" : ""}`}
                    onClick={() => {
                      setWasIt(o.v);
                      mark("tap", `was it the finding: ${o.label}`);
                      report({ confirmed: o.v });
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
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
              onFound={(pros) => {
                if (jobId.current) updateJob(jobId.current, { pros, prosTrade: trade });
                mark("technicians found", `${pros.length} ${trade}`);
              }}
              onContact={(p, how) => {
                if (jobId.current) {
                  updateJob(jobId.current, {
                    outcome: "called a pro",
                    contacted: { name: p.name, phone: p.phone, how, at: new Date().toISOString() },
                  });
                }
                mark("tap", `${how} ${p.name}`);
              }}
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
      <div className={`walk-cta${screen === "done" ? " confirm-bar" : ""}`}>
        {screen === "quick" && quick.state === "ready" && (
          <>
            <button type="button" className="btn-success" onClick={() => quickResult(true)}>
              That fixed it
            </button>
            <button type="button" className="btn-primary" onClick={() => quickResult(false)}>
              Still not working
            </button>
          </>
        )}
        {screen === "quick" && quick.state === "fixed" && (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        )}
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
              Find a handyman
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
                if (stepIdx < steps.length - 1) nextStep();
                else if (verdict?.verdict === "pro") openPro();
                else void finishFix(null);
              }}
              disabled={stepLoading}
            >
              {stepLoading
                ? "Highlighting…"
                : stepIdx < steps.length - 1
                  ? "Next step"
                  : verdict?.verdict === "pro"
                    ? "Find a handyman"
                    : "Done, check it"}
            </button>
          </>
        )}
        {screen === "done" && done && done.state !== "checking" && !fixed && stillWrong === null && (
          <>
            <button type="button" className="btn-success" onClick={() => void confirmFixed(true)}>
              It&apos;s working
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
              Try again (try {attempt + 1} of {MAX_RUNS})
            </button>
          </>
        )}
        {screen === "done" && fixed && (
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
      {viewAsk !== null && (
        <div className="mid-backdrop">
          <div className="mid-card" role="dialog" aria-modal="true" aria-labelledby="view-q">
            <p className="sheet-label">After step {viewAsk + 1} of {steps.length}</p>
            <p id="view-q" className="instruction">The view has changed</p>
            <p className="mid-why">
              Take a new picture of the {machine || appliance || device || "machine"} as it looks now, so I can check
              this step and point at the next part.
            </p>
            <div className="mid-actions">
              <button type="button" className="btn-outline" onClick={() => void viewScanThenNext(false)}>
                Skip
              </button>
              <button type="button" className="btn-primary" onClick={() => void viewScanThenNext(true)}>
                Scan now
              </button>
            </div>
          </div>
        </div>
      )}
      {midAsk !== null && (
        <div className="mid-backdrop">
          <div className="mid-card" role="dialog" aria-modal="true" aria-labelledby="mid-q">
            <p className="sheet-label">After step {midAsk + 1} of {steps.length}</p>
            <p id="mid-q" className="instruction">Is it working now?</p>
            <p className="mid-why">Sometimes one step is all it takes.</p>
            <label className="risk-check">
              <input
                type="checkbox"
                checked={onlyAtEndTick}
                onChange={(e) => setOnlyAtEndTick(e.target.checked)}
              />
              <span>Only ask me after the last step</span>
            </label>
            <div className="mid-actions">
              <button type="button" className="btn-success" onClick={() => midAnswer(true)}>
                It&apos;s working
              </button>
              <button type="button" className="btn-primary" onClick={() => midAnswer(false)}>
                Next step
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
