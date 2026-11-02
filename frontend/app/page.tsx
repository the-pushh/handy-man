"use client";

/* Single flow: tap the orb and say what needs fixing. The camera then
   looks for the machine you named, outlines it on the live view and
   asks you to move until it is framed well; that frame is the picture.
   A machine the rules say not to open is flagged first (go on at your
   own risk, or find a technician). Then screen #2: the repair
   walkthrough, run after run until it is fixed or a technician is
   the answer. */

import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognition } from "./lib/speech";
import type { SpeechRecognitionLike } from "./lib/speech";
import { IS_PROD, resolveApiBase } from "./lib/apiBase";
import { kb, mark, setLogBase, turnStart } from "./lib/timeline";
import { drawStill, shrinkPhoto } from "./lib/still";
import { SOUND_WORDS, recordClip } from "./lib/recorder";
import type { Heard } from "./lib/recorder";
import Waveform from "./components/Waveform";
import Orb from "./components/Orb";
import type { OrbState } from "./components/Orb";
import RepairWalkthrough from "./components/RepairWalkthrough";
import History from "./components/History";
import LiveDetect from "./components/LiveDetect";
import type { ScanWarning, SeekResult } from "./components/LiveDetect";
import CallAPro from "./components/CallAPro";
import Busy from "./components/Busy";

// Who is working during the camera-screen waits.
const PAGE_BUSY: Record<string, string> = {
  "Looking at your photo…": "Muse Spark is finding the machine you named.",
  "Checking the sound…": "Measuring the beeps and asking Muse Wonder. A few seconds.",
};

interface Overlay {
  files: File[];
  // What the owner said (shown, and the issue every run works on).
  text: string;
  // Run 2 onwards: what was tried and what is still wrong.
  followUp: string;
  key: number;
  // {owner_says: the item named}, so diagnosis and the rules use the
  // owner's word for the machine. Null once views are added.
  perception: unknown;
  prefetched: Promise<unknown> | null;
  heard: Heard | null;
  // The item named ("air conditioner"): History groups runs by it.
  machine: string;
  attempt: number;
  // The previous run's History entry (run 2 onwards).
  parentId: string | null;
  // The scan-time warning the owner chose to override, if any.
  acceptRisk: ScanWarning | null;
}

const LISTEN_SECONDS = 4;
// Failed framings before "Use this view" is offered.
const STUCK_AFTER = 4;

interface Seek {
  tries: number;
  lastHint: string;
  lastHintAt: number;
  item: string;
  warned: boolean;
  uploaded: boolean;
  acceptRisk: ScanWarning | null;
  last: SeekResult | null;
}

// "a mechanic", "an electrician".
const aOrAn = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

const freshSeek = (): Seek => ({
  tries: 0,
  lastHint: "",
  lastHintAt: 0,
  item: "",
  warned: false,
  uploaded: false,
  acceptRisk: null,
  last: null,
});


function apiBase(): string {
  if (IS_PROD) return "";
  if (typeof window === "undefined") return "http://127.0.0.1:8000";
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem("handyman-api-base");
  } catch (_) {
    // Ignore; fall through to the default.
  }
  return resolveApiBase(
    process.env.NEXT_PUBLIC_API_BASE,
    saved,
    window.location.hostname
  );
}

function BackendRow({
  host,
  editing,
  onToggle,
  onSave,
}: {
  host: string;
  editing: boolean;
  onToggle: () => void;
  onSave: (url: string) => void;
}) {
  return (
    <div className="backendrow">
      <button type="button" className="backendlink" onClick={onToggle}>
        BACKEND: {host || "tap to set"}
      </button>
      {editing && (
        <form
          className="typeForm"
          onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get("be")?.toString().trim();
            if (v) onSave(v.replace(/\/$/, ""));
          }}
        >
          <input
            name="be"
            type="url"
            inputMode="url"
            placeholder="https://backend-tunnel-url"
            autoComplete="off"
          />
          <button type="submit">Set</button>
        </form>
      )}
    </div>
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const turnRef = useRef<number>(0);
  const seekRef = useRef<Seek>(freshSeek());
  const issueRef = useRef<string>("");
  const langRef = useRef<{ tts: string; stt: string }>({ tts: "en", stt: "en-US" });
  const uploadRef = useRef<HTMLInputElement>(null);
  const pendingFrameRef = useRef<File | null>(null);
  // Voice-level plumbing for the orb: mic analyser for the human layer,
  // TTS-element analyser (or a stand-in oscillation for the browser
  // voice) for the AI layer.
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const aiAnalyserRef = useRef<AnalyserNode | null>(null);
  const aiOscRef = useRef<boolean>(false);

  const [overlay, setOverlay] = useState<Overlay | null>(null);
  // Final camera re-check: the walkthrough stays mounted (its state
  // survives) but is hidden so the camera shows while the owner aims.
  const [peek, setPeek] = useState<string>("");
  // What the camera is looking for (the owner's words); null = idle.
  const [seekWant, setSeekWant] = useState<string | null>(null);
  const [stuck, setStuck] = useState<boolean>(false);
  // Taking the picture: outline held on the live view, then a shutter
  // flash with the frozen frame shrinking away.
  const [hold, setHold] = useState<boolean>(false);
  const [snap, setSnap] = useState<string>("");
  const snapToken = useRef<number>(0);
  // Scan-time warning, before any diagnosis.
  const [warn, setWarn] = useState<{ w: ScanWarning; res: SeekResult; url: string } | null>(null);
  const [riskOk, setRiskOk] = useState<boolean>(false);
  const [warnPro, setWarnPro] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [orb, setOrb] = useState<OrbState>("idle");
  const [listening, setListening] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");
  const [typeOpen, setTypeOpen] = useState<boolean>(false);
  const [beEdit, setBeEdit] = useState<boolean>(false);
  const [beHost, setBeHost] = useState<string>("");
  // The backend row only shows until an address is configured (env or
  // saved), so it stays out of recordings; the walkthrough offers to
  // paste one if the server can't be reached.
  useEffect(() => {
    const base = apiBase();
    if (base !== `http://${window.location.hostname}:8000` || window.location.port === "3000") setBeHost(base);
  }, []);
  const [mic, setMic] = useState<AnalyserNode | null>(null);

  // App timeline -> backend logs (see lib/timeline.ts).
  useEffect(() => {
    setLogBase(apiBase());
  }, []);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let live = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: { echoCancellation: true },
        });
        micStreamRef.current = stream;
        if (live && videoRef.current) videoRef.current.srcObject = stream;
        else stream?.getTracks().forEach((t) => t.stop());
      } catch (_) {
        if (live) setStatusMsg("Camera blocked — allow camera access and reload.");
      }
    })();
    return () => {
      live = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function detectIssueLang(text: string): Promise<void> {
    try {
      const r = await fetch(`${apiBase()}/api/detect-language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      const narration = String(d.narration || "en");
      langRef.current = {
        tts: ["en", "hi", "hinglish"].includes(narration) ? narration : "en",
        stt: String(d.stt || "en-US"),
      };
    } catch (_) {
      langRef.current = { tts: "en", stt: "en-US" };
    }
  }

  function sharedCtx(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AC) return null;
        audioCtxRef.current = new AC();
      }
      if (audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => undefined);
      }
      return audioCtxRef.current;
    } catch (_) {
      return null;
    }
  }

  function analyserLevel(an: AnalyserNode | null): number {
    if (!an) return 0;
    try {
      const buf = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 3);
    } catch (_) {
      return 0;
    }
  }

  function ensureMicAnalyser(): void {
    if (micAnalyserRef.current || !micStreamRef.current) return;
    const c = sharedCtx();
    if (!c) return;
    try {
      const src = c.createMediaStreamSource(micStreamRef.current);
      const an = c.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      micAnalyserRef.current = an;
    } catch (_) {
      // Mic levels unavailable; the orb still animates while listening.
    }
  }

  const getHumanLevel = useCallback(
    () => analyserLevel(micAnalyserRef.current),
    []
  );
  const getAiLevel = useCallback(() => {
    const live = analyserLevel(aiAnalyserRef.current);
    if (live > 0) return live;
    if (aiOscRef.current)
      return 0.35 + 0.3 * Math.sin(performance.now() / 180);
    return 0;
  }, []);

  async function say(line: string): Promise<void> {
    mark("tts request", JSON.stringify(line.slice(0, 40)));
    try {
      const r = await fetch(`${apiBase()}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, lang: langRef.current.tts }),
      });
      const data = await r.json();
      mark("tts audio received", data.audio_b64 ? kb(data.audio_b64.length * 0.75) : "fallback");
      if (data.audio_b64) {
        const bytes = Uint8Array.from(atob(data.audio_b64), (c) =>
          c.charCodeAt(0)
        );
        const url = URL.createObjectURL(
          new Blob([bytes], { type: data.mime || "audio/wav" })
        );
        await new Promise<void>((res) => {
          const finish = () => {
            aiAnalyserRef.current = null;
            res();
          };
          const a = new Audio(url);
          const c = sharedCtx();
          if (c) {
            try {
              const src = c.createMediaElementSource(a);
              const an = c.createAnalyser();
              an.fftSize = 512;
              src.connect(an);
              an.connect(c.destination);
              aiAnalyserRef.current = an;
            } catch (_) {
              aiOscRef.current = true;
            }
          }
          a.onended = () => {
            aiOscRef.current = false;
            mark("tts playback ended");
            finish();
          };
          a.onerror = () => {
            aiOscRef.current = false;
            finish();
          };
          setTimeout(() => {
            aiOscRef.current = false;
            finish();
          }, 60000);
          a.play().catch(() => {
            aiOscRef.current = false;
            finish();
          });
        });
        URL.revokeObjectURL(url);
        return;
      }
    } catch (_) {
      // Fall through to the browser voice.
    }
    await new Promise<void>((res) => {
      const done = () => {
        aiOscRef.current = false;
        res();
      };
      try {
        const u = new SpeechSynthesisUtterance(line);
        u.lang = langRef.current.stt;
        u.onend = done;
        u.onerror = done;
        setTimeout(done, 60000);
        aiOscRef.current = true;
        window.speechSynthesis.speak(u);
      } catch (_) {
        done();
      }
    });
  }

  function captureStillAsync(): Promise<File | null> {
    const video = videoRef.current;
    const grab = grabRef.current;
    if (!video?.videoWidth || !grab) return Promise.resolve(null);
    return drawStill(video, video.videoWidth, video.videoHeight, "still.jpg", grab);
  }

  // Pull one still frame out of an uploaded video file.
  function videoFrame(file: File): Promise<File | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (f: File | null) => {
        if (!done) {
          done = true;
          URL.revokeObjectURL(url);
          resolve(f);
        }
      };
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.muted = true;
      (v as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
      v.preload = "auto";
      v.src = url;
      v.onloadeddata = () => {
        try {
          v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
        } catch (_) {
          finish(null);
        }
      };
      v.onseeked = () => {
        if (!v.videoWidth) {
          finish(null);
          return;
        }
        void drawStill(v, v.videoWidth, v.videoHeight, "upload.jpg").then(finish);
      };
      v.onerror = () => finish(null);
      setTimeout(() => finish(null), 15000);
    });
  }

  // Photo/video picked from the library: hold the frame, then ask for
  // the issue by voice (the type bubble stays open as backup).
  async function handleUpload(file: File | undefined) {
    if (!file || seekWant || warn || overlay) return;
    setTypeOpen(true);
    setStatusMsg("Reading your photo…");
    const frame = file.type.startsWith("video")
      ? await videoFrame(file)
      : file.type.startsWith("image")
        ? await shrinkPhoto(file)
        : null;
    if (!frame) {
      setStatusMsg("Could not read that file — try a photo or video.");
      return;
    }
    pendingFrameRef.current = frame;
    setStatusMsg("Photo ready — say or type the issue.");
    setOrb("asking");
    startListening();
  }

  // First action: the owner said what needs fixing. Look for that
  // machine on the live camera (or in the photo they picked).
  async function startTurn(text: string, provided: File | null = null) {
    const said = text.trim();
    if (!said || seekWant || warn || overlay) return;
    stopListeningInner();
    setTranscript(said);
    issueRef.current = said;
    turnStart("turn start (issue heard)");
    // Only picks the narration voice; never blocks the look.
    void detectIssueLang(said).then(() => mark("detect-language done"));
    seekRef.current = freshSeek();
    setStuck(false);
    setRiskOk(false);
    setWarnPro(false);
    setOrb("thinking");
    const photo = provided || pendingFrameRef.current;
    pendingFrameRef.current = null;
    if (photo) {
      // A picked photo: one look for the item and the warning, then on.
      seekRef.current.uploaded = true;
      setStatusMsg("Looking at your photo…");
      try {
        const fd = new FormData();
        fd.append("file", photo, "frame.jpg");
        fd.append("want", said);
        fd.append("start", "1");
        const d = await (await fetch(`${apiBase()}/api/detect`, { method: "POST", body: fd })).json();
        if (d.status === "rate-limited") {
          setStatusMsg(d.detail);
          setOrb("idle");
          return;
        }
        onSeek({
          item: String(d.item || ""),
          name: String(d.name || ""),
          instance: d.instance || null,
          framing: String(d.framing || ""),
          ready: true, // the owner chose this photo
          hint: "",
          warning: d.warning || null,
          frame: photo,
        });
      } catch (_) {
        void capture(photo, "", null);
      }
      return;
    }
    setStatusMsg("Looking for it…");
    setSeekWant(said);
  }

  // Each answer from the live search: warn, take the picture, or ask the
  // owner to move.
  function onSeek(res: SeekResult): void {
    const s = seekRef.current;
    s.last = res;
    if (res.item) s.item = res.item;
    if (res.warning && !s.warned) {
      s.warned = true;
      setSeekWant(null);
      setStuck(false);
      setWarn({ w: res.warning, res, url: URL.createObjectURL(res.frame) });
      setOrb("asking");
      setStatusMsg("");
      mark("scan warning", res.warning.rule);
      void say(`${res.warning.spoken} Call ${aOrAn(res.warning.trade)}, or go on at your own risk.`);
      return;
    }
    if (res.ready) {
      setStuck(false);
      takePicture(res.frame, res.item || s.item, s.acceptRisk, res.name);
      return;
    }
    s.tries += 1;
    setStatusMsg(res.hint);
    const now = Date.now();
    if (res.hint && (res.hint !== s.lastHint || now - s.lastHintAt > 12000)) {
      s.lastHint = res.hint;
      s.lastHintAt = now;
      void say(res.hint);
    }
    if (s.tries >= STUCK_AFTER) setStuck(true);
  }
  const seekCb = useRef(onSeek);
  seekCb.current = onSeek;

  // Framed: keep the outline on the live view a moment ("Got it, hold
  // still"), flash the shutter, then open the walkthrough.
  function takePicture(frame: File, item: string, acceptRisk: ScanWarning | null, name = "") {
    const token = ++snapToken.current;
    setHold(true);
    setStatusMsg(`Got the ${name || item || "picture"}. Hold still…`);
    mark("framed", name || item);
    window.setTimeout(() => {
      if (token !== snapToken.current) return;
      const url = URL.createObjectURL(frame);
      setSnap(url);
      mark("picture taken", `${name || item}`);
      window.setTimeout(() => {
        if (token !== snapToken.current) return;
        setSnap("");
        URL.revokeObjectURL(url);
        setHold(false);
        setSeekWant(null);
        void capture(frame, item, acceptRisk);
      }, 750);
    }, 1100);
  }

  // The owner gave up on framing: take the picture as the view is now.
  async function useThisView(): Promise<void> {
    const s = seekRef.current;
    const frame = (await captureStillAsync()) || s.last?.frame || null;
    setStuck(false);
    if (!frame) {
      setSeekWant(null);
      setStatusMsg("Camera not ready yet. Try again.");
      setOrb("idle");
      return;
    }
    mark("owner chose this view");
    takePicture(frame, s.item, s.acceptRisk);
  }

  function cancelSeek(): void {
    snapToken.current++;
    setHold(false);
    setSnap("");
    setSeekWant(null);
    setStuck(false);
    setWarn(null);
    setOrb("idle");
    setStatusMsg("");
  }

  // Warning answered "go on at my own risk": resume (or take the
  // picture that was already framed well).
  function acceptRiskAndGo(): void {
    const cur = warn;
    if (!cur) return;
    const s = seekRef.current;
    s.acceptRisk = cur.w;
    mark("risk accepted", cur.w.rule);
    URL.revokeObjectURL(cur.url);
    setWarn(null);
    if (s.uploaded) {
      void capture(cur.res.frame, cur.res.item, cur.w);
      return;
    }
    if (cur.res.ready) {
      setSeekWant(issueRef.current);
      takePicture(cur.res.frame, cur.res.item, cur.w, cur.res.name);
      return;
    }
    setOrb("thinking");
    setStatusMsg(cur.res.hint || "Looking for it…");
    setSeekWant(issueRef.current);
  }

  // The picture is taken: listen first when the sound is the evidence,
  // then open the walkthrough (run 1).
  async function capture(frame: File, item: string, acceptRisk: ScanWarning | null) {
    stopListeningInner();
    setOrb("idle");
    setStatusMsg("");
    let heard: Heard | null = null;
    if (SOUND_WORDS.test(issueRef.current)) {
      heard = await listenForSound();
    } else {
      void say("Got it.");
    }
    turnRef.current += 1;
    setOverlay({
      files: [frame],
      text: issueRef.current,
      followUp: "",
      key: turnRef.current,
      perception: item ? { owner_says: item } : null,
      prefetched: null,
      heard,
      machine: item,
      attempt: 1,
      parentId: null,
      acceptRisk,
    });
  }

  // "Still broken": another run on the same machine with what was tried
  // and what is still wrong (the walkthrough calls a technician after
  // the last allowed run).
  function retry(prev: Overlay, reply: string, tried: string[], after: File | null, jobId: string | null) {
    turnRef.current += 1;
    mark("another run", `${prev.attempt + 1}: ${reply}`);
    setOverlay({
      ...prev,
      files: after ? [after] : prev.files,
      followUp:
        `Run ${prev.attempt} already tried: ${tried.join("; ") || "nothing"}. ` +
        `It is still not fixed: ${reply}. Do not repeat a fix that was ` +
        `already tried; if no owner fix is left, say a technician is needed.`,
      key: turnRef.current,
      prefetched: null,
      attempt: prev.attempt + 1,
      parentId: jobId,
    });
  }

  // Record a few seconds only while nothing is being spoken (say()
  // resolves when playback ends), measure it and cross-check with Muse
  // Wonder. If they disagree on the beep count, record once more.
  async function listenForSound(): Promise<Heard | null> {
    let last: Heard | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await say(attempt ? "Couldn't hear it clearly. Once more." : "Quiet please, listening.");
      setOrb("listening");
      setStatusMsg("");
      try {
        const live = await recordClip(LISTEN_SECONDS);
        setMic(live.analyser);
        mark("listening", `${LISTEN_SECONDS}s`);
        const clip = await live.done;
        setMic(null);
        mark("clip recorded", `${clip.seconds.toFixed(1)}s ${kb(clip.file.size)}`);
        setOrb("thinking");
        setStatusMsg("Checking the sound…");
        const fd = new FormData();
        fd.append("file", clip.file, "clip.wav");
        last = (await (await fetch(`${apiBase()}/api/listen`, { method: "POST", body: fd })).json()) as Heard;
        if (last) last.clip = clip.file;
        mark("sound checked", `${last?.features?.beeps} beeps, wonder ${last?.wonder?.beeps}, agree ${last?.agree}`);
        if (last && !last.rerecord) break;
      } catch (_) {
        setMic(null);
        setStatusMsg("Microphone unavailable; going on without the sound.");
        break;
      }
    }
    setStatusMsg("");
    setOrb("idle");
    return last;
  }

  // On demand from the walkthrough: listen again and re-diagnose.
  async function listenAgain(prev: Overlay) {
    setOverlay(null);
    const heard = await listenForSound();
    turnRef.current += 1;
    // The walkthrough diagnoses again with the new recording.
    setOverlay({ ...prev, key: turnRef.current, heard, prefetched: null });
  }

  // On demand from the walkthrough: capture one more view of the faulty
  // area and re-run on all views (fresh perception of each).
  async function addView(prev: Overlay) {
    setOverlay(null);
    setOrb("thinking");
    setStatusMsg("Point closer at the faulty part…");
    void say("Point closer at the faulty part.");
    await new Promise((r) => setTimeout(r, 2000));
    const still = await captureStillAsync();
    mark("extra view", still ? kb(still.size) : "none");
    setStatusMsg("");
    setOrb("idle");
    turnRef.current += 1;
    setOverlay({
      ...prev,
      files: still ? [...prev.files, still] : prev.files,
      key: turnRef.current,
      // Extra views are perceived afresh; the item the owner named stays.
      perception: prev.machine ? { owner_says: prev.machine } : null,
      prefetched: null,
    });
  }

  // The walkthrough's final re-check: show the camera, let the owner aim
  // at the fixed part, grab one "after" still, then come back.
  async function recheckStill(part: string | null): Promise<File | null> {
    const aim = part ? `Point at the ${part}` : "Point at what you fixed";
    setPeek(aim);
    setStatusMsg(aim);
    await new Promise((r) => setTimeout(r, 3000));
    const still = await captureStillAsync();
    mark("recheck still", still ? kb(still.size) : "none");
    setStatusMsg("");
    setPeek("");
    return still;
  }

  const turnCb = useRef(startTurn);
  turnCb.current = startTurn;

  function stopListeningInner(): void {
    if (recogRef.current) {
      try {
        recogRef.current.abort();
      } catch (_) {
        // Already stopped.
      }
      recogRef.current = null;
    }
    setListening(false);
    if (orb === "listening") setOrb("idle");
  }

  function listen(recognizer: SpeechRecognitionLike): void {
    recogRef.current = recognizer;
    setListening(true);
  }

  function startListening(): void {
    ensureMicAnalyser();
    const SR = getSpeechRecognition();
    if (!SR) {
      setStatusMsg("No built-in voice recognition — type what you need below.");
      return;
    }
    stopListeningInner();
    const recog = new SR();
    recog.lang = "en-US";
    recog.interimResults = false;
    setOrb("listening");
    recog.onresult = (e) => {
      const heard = e.results[0][0].transcript as string;
      void turnCb.current(heard);
    };
    recog.onend = () => {
      recogRef.current = null;
      setListening(false);
      setOrb((o) => (o === "listening" ? "idle" : o));
    };
    recog.onerror = () => {
      recogRef.current = null;
      setListening(false);
      setOrb((o) => (o === "listening" ? "idle" : o));
    };
    try {
      recog.start();
      listen(recog);
    } catch (e) {
      setStatusMsg("Voice error: " + (e as Error).message);
      setOrb("idle");
    }
  }

  const cutoutLine =
    statusMsg ||
    (seekWant
      ? "Looking for it…"
      : "Tap the button and tell me what needs fixing.");
  // What the app is doing right now, always visible during a turn.
  const phase = mic || orb === "listening"
    ? "Listening"
    : orb === "thinking"
      ? statusMsg.startsWith("I'm looking at") ? "Thinking" : "Seeing"
      : null;

  function collapseType(): void {
    setTypeOpen(false);
  }

  return (
    <main className="stage stage-camera">
      <div className="titleframe gridbars">
        HANDYMAN
        {!overlay && !seekWant && !warn && (
          <button type="button" className="history-open" onClick={() => setShowHistory(true)}>
            History
          </button>
        )}
      </div>

      <div className="cutout">
        <video ref={videoRef} className="live" autoPlay playsInline muted />
        <LiveDetect
          videoRef={videoRef}
          want={overlay || showHistory || peek ? null : seekWant}
          apiBase={apiBase}
          onResult={(r) => seekCb.current(r)}
          hold={hold}
        />
        {snap && (
          <div className="shutter" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snap} alt="" className="snap-img" />
          </div>
        )}

        <span className="crop tl" />
        <span className="crop tr" />
        <span className="crop bl" />
        <span className="crop br" />

        {orb === "thinking" && !seekWant && !warn && statusMsg && PAGE_BUSY[statusMsg] !== undefined && (
          <div className="live-busy">
            <Busy compact label={statusMsg} hint={PAGE_BUSY[statusMsg]} slowAfter={12} />
          </div>
        )}
        {phase && !warn && !seekWant && !(orb === "thinking" && PAGE_BUSY[statusMsg] !== undefined) && (
          <p className="status-chip scan-chip" role="status">
            <span className="dot" aria-hidden="true" /> {phase}
          </p>
        )}
        {!warn && !mic && (
          <div className="cutout-bar" role="status">
            {cutoutLine}
          </div>
        )}
        {mic && <Waveform analyser={mic} seconds={LISTEN_SECONDS} />}

        {warn && (
          <div className="confirm-card warn-card" role="alertdialog" aria-labelledby="warn-q">
            <p className="sheet-label">Before you start</p>
            <p id="warn-q" className="instruction confirm-q">{warn.w.spoken}</p>
            {warn.res.name && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={warn.url} alt={warn.res.name} />
            )}
            <p className="warn-why">{warn.w.title}</p>
            {warnPro ? (
              <CallAPro
                api={apiBase()}
                trade={warn.w.trade}
                brief={{
                  device: warn.res.name || warn.res.item,
                  issue: issueRef.current,
                  finding: "Not opened: flagged before any repair",
                  rule: warn.w.title,
                  checks: [],
                  sound: null,
                  photo: warn.res.name ? warn.res.frame : null,
                  clip: null,
                }}
              />
            ) : (
              <>
                <button type="button" className="btn-primary" onClick={() => setWarnPro(true)}>
                  Find {aOrAn(warn.w.trade)}
                </button>
                <label className="risk-check">
                  <input
                    type="checkbox"
                    checked={riskOk}
                    onChange={(e) => setRiskOk(e.target.checked)}
                  />
                  I understand the risk. If I go on, it is my own risk.
                </label>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={!riskOk}
                  onClick={acceptRiskAndGo}
                >
                  Continue at my own risk
                </button>
              </>
            )}
            <button type="button" className="btn-outline" onClick={cancelSeek}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <section className="panel">
        {transcript && (
          <p className="transcript">&ldquo;{transcript}&rdquo;</p>
        )}
        {seekWant && (
          <div className="seek-actions">
            {stuck && (
              <button type="button" className="btn-primary" onClick={() => void useThisView()}>
                Use this view
              </button>
            )}
            <button type="button" className="btn-outline" onClick={cancelSeek}>
              Cancel
            </button>
          </div>
        )}
        {!IS_PROD && (beEdit || !beHost) && <BackendRow
          host={beHost}
          editing={beEdit}
          onToggle={() => {
            setBeHost(apiBase());
            setBeEdit((v) => !v);
          }}
          onSave={(url) => {
            try {
              window.localStorage.setItem("handyman-api-base", url);
            } catch (_) {
              // Private mode; the entry just won't persist.
            }
            setBeHost(url);
            setBeEdit(false);
          }}
        />}
      </section>

      <nav
        className={`controlbar gridbars${typeOpen ? " typing" : ""}`}
        aria-label="Input options"
      >
        <input
          ref={uploadRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            void handleUpload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {typeOpen ? (
          <>
            <div
              className="cb-left"
              onClick={collapseType}
              role="button"
              aria-label="Back to voice and photo"
            >
              <div className="cb-cell">
                <button
                  type="button"
                  className="cb-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    collapseType();
                    uploadRef.current?.click();
                  }}
                  aria-label="Send a photo or video from your library"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" />
                    <circle cx="9" cy="10" r="1.5" />
                    <path d="M3 17l5-5 4 4 3-3 6 6" />
                  </svg>
                </button>
              </div>

              <div className="cb-cell">
                <Orb
                  state={orb}
                  onTap={() => {
                    collapseType();
                    if (listening) stopListeningInner();
                    else startListening();
                  }}
                  label={listening ? "Stop listening" : "Tap and speak"}
                  getHuman={getHumanLevel}
                  getAi={getAiLevel}
                />
              </div>
            </div>

            <div className="cb-cell cb-type">
              <form
                className="typeForm typeinline"
                onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget).get("issue")?.toString().trim();
                  if (v) {
                    e.currentTarget.reset();
                    collapseType();
                    void startTurn(v);
                  }
                }}
              >
                <input name="issue" type="text" placeholder="Type what you need…" autoComplete="off" />
                <button type="submit">Send</button>
              </form>
            </div>
          </>
        ) : (
          <>
            <div className="cb-cell">
              <button
                type="button"
                className="cb-btn"
                onClick={() => uploadRef.current?.click()}
                aria-label="Send a photo or video from your library"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" />
                  <circle cx="9" cy="10" r="1.5" />
                  <path d="M3 17l5-5 4 4 3-3 6 6" />
                </svg>
              </button>
              <span className="cb-label">PHOTO</span>
            </div>

            <div className="cb-cell">
              <Orb
                state={orb}
                onTap={() => (listening ? stopListeningInner() : startListening())}
                label={listening ? "Stop listening" : "Tap and speak"}
                getHuman={getHumanLevel}
                getAi={getAiLevel}
              />
              <span className="cb-label cb-main">WHAT&apos;S BROKEN?</span>
            </div>

            <div className="cb-cell">
              <button
                type="button"
                className="cb-btn"
                onClick={() => setTypeOpen(true)}
                aria-label="Type your issue instead of speaking"
                aria-expanded={false}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M4 5h16v10H9l-5 4V5z" />
                  <path d="M8 9h8M8 12h5" />
                </svg>
              </button>
              <span className="cb-label">TYPE</span>
            </div>
          </>
        )}
      </nav>

      {overlay && (
        <div className="overlay mat overlay-walk" hidden={!!peek}>
          <RepairWalkthrough
            key={overlay.key}
            files={overlay.files}
            issue={overlay.text}
            followUp={overlay.followUp}
            machine={overlay.machine}
            attempt={overlay.attempt}
            parentId={overlay.parentId}
            acceptRisk={overlay.acceptRisk}
            onRetry={(reply, tried, after, jobId) => retry(overlay, reply, tried, after, jobId)}
            perception={overlay.perception}
            prefetched={overlay.prefetched}
            heard={overlay.heard}
            onListen={() => void listenAgain(overlay)}
            onMoreViews={() => void addView(overlay)}
            onRecheck={recheckStill}
            onClose={() => setOverlay(null)}
          />
        </div>
      )}

      {showHistory && (
        <div className="overlay mat">
          <History onClose={() => setShowHistory(false)} />
        </div>
      )}

      <canvas ref={grabRef} hidden />
    </main>
  );
}
