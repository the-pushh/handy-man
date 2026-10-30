"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { popIn, reducedMotion, riseIn, stillIn } from "./lib/anim";
import { getSpeechRecognition } from "./lib/speech";
import type { SpeechRecognitionLike } from "./lib/speech";
import RepairWalkthrough from "./components/RepairWalkthrough";

interface StageBox {
  id: string;
  label: string;
  // Normalized box, origin top-left, 0..1 (matches backend schema).
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

interface Evidence {
  id: string;
  label: string;
  jpeg_b64: string;
}

interface Cause {
  title: string;
  explanation: string;
  relatedComponentLabel: string | null;
  confidence: number;
}

interface RepairStep {
  index: number;
  instruction: string;
  highlightLabel: string | null;
}

type Mode = "live" | "working";

interface LangOption {
  code: string;
  name: string;
}

const ALIAS_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  hinglish: "Hinglish",
};

const NEXT_WORDS =
  /^\s*(next|agla|अगला|siguiente|suivant|weiter|prossimo|próximo|volgende)\s*\.?$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postJSON(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function stopSpeech(): void {
  try {
    window.speechSynthesis.cancel();
  } catch (_) {
    // Speech synthesis unavailable; nothing to stop.
  }
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const recogLocale = useRef<string>("en-US");
  const overrideRef = useRef<string>("auto");
  const tagCountRef = useRef<number>(0);
  const boxesRef = useRef<HTMLDivElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const causeBlockRef = useRef<HTMLDivElement>(null);
  const stepsBlockRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const pulseRef = useRef<gsap.core.Tween | null>(null);

  // One speech queue: thinking lines are spoken in arrival order while
  // overlays land underneath them. turnId cancels stale audio on reset.
  const speechChain = useRef<Promise<void>>(Promise.resolve());
  const turnId = useRef<number>(0);

  const [mode, setMode] = useState<Mode>("live");
  const [view, setView] = useState<"live" | "repair">("live");
  const [boxes, setBoxes] = useState<StageBox[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [thinking, setThinking] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [cause, setCause] = useState<Cause | null>(null);
  const [steps, setSteps] = useState<RepairStep[]>([]);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [transcript, setTranscript] = useState<string>("");
  // Narration language: "en"/"hi"/"hinglish" or an MMS checkpoint code.
  const [lang, setLang] = useState<string>("en");
  const [langOptions, setLangOptions] = useState<LangOption[]>([]);
  const [langOverride, setLangOverride] = useState<string>("auto");
  const [langDetected, setLangDetected] = useState<string>("");
  const [langTranslated, setLangTranslated] = useState<boolean>(false);

  function badgeName(code: string): string {
    if (ALIAS_NAMES[code]) return ALIAS_NAMES[code];
    const found = langOptions.find((o) => o.code === code);
    return found ? found.name : code;
  }

  function badgeText(): string {
    const base = badgeName(lang);
    // Voice exists but narration isn't translatable: replies stay English.
    if (!ALIAS_NAMES[lang] && !langTranslated && langDetected && langDetected !== lang) {
      return `${badgeName(langDetected)} → English`;
    }
    return base;
  }

  function pickOverride(code: string): void {
    setLangOverride(code);
    overrideRef.current = code;
  }
  const [listening, setListening] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const live = useRef<{
    mode: Mode;
    steps: RepairStep[];
    stepIndex: number;
    transcript: string;
    boxes: StageBox[];
    lang: string;
  }>({ mode: "live", steps: [], stepIndex: 0, transcript: "", boxes: [], lang: "en" });
  live.current = {
    mode,
    steps,
    stepIndex,
    transcript,
    boxes: live.current.boxes,
    lang,
  };

  useEffect(() => {
    // Voice picker options: every MMS-TTS language.
    fetch("/api/languages")
      .then((r) => (r.ok ? r.json() : { languages: [] }))
      .then((d) => setLangOptions(d.languages || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (view !== "live") return;
    let stream: MediaStream | undefined;
    let live = true;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
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
  }, [view]);

  function say(text: string, useLang: string, turn: number): void {
    speechChain.current = speechChain.current
      .then(async () => {
        if (turn !== turnId.current) return;
        try {
          const data = await postJSON("/api/tts", { text, lang: useLang });
          if (turn !== turnId.current) return;
          if (data.audio_b64) {
            const bytes = Uint8Array.from(atob(data.audio_b64), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(
              new Blob([bytes], { type: data.mime || "audio/wav" })
            );
            await new Audio(url).play().catch(() => {});
            return;
          }
        } catch (_) {
          // Fall through to the browser voice.
        }
        if (turn !== turnId.current) return;
        stopSpeech();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = recogLocale.current;
        window.speechSynthesis.speak(u);
      })
      .catch(() => {});
  }

  const mergeBoxes = useCallback((incoming: StageBox[]) => {
    const ids = new Set(incoming.map((b) => b.id));
    setBoxes((prev) => [...prev.filter((b) => !ids.has(b.id)), ...incoming]);
    live.current.boxes = [
      ...live.current.boxes.filter((b) => !ids.has(b.id)),
      ...incoming,
    ];
  }, []);

  const handleEvent = useCallback(
    (ev: { type: string; [k: string]: unknown }, turn: number) => {
      const useLang = live.current.lang;
      switch (ev.type) {
        case "lang": {
          const l = (ev.lang as string) || "en";
          setLang(l);
          live.current.lang = l;
          setLangDetected((ev.detected as string) || "");
          setLangTranslated((ev.translated as boolean) || false);
          recogLocale.current = (ev.stt_locale as string) || "en-US";
          break;
        }
        case "thinking":
          setThinking((prev) => [...prev, ev.text as string]);
          say(ev.text as string, live.current.lang, turn);
          break;
        case "device":
        case "logo":
        case "components":
          mergeBoxes(ev.boxes as StageBox[]);
          setEvidence((prev) => [...prev, ...((ev.evidence as Evidence[]) || [])]);
          if (ev.text) say(ev.text as string, useLang, turn);
          break;
        case "pinpoint":
          setCause(ev.cause as Cause);
          setHighlightId((ev.highlight_id as string) || null);
          break;
        case "done": {
          const done = ev as unknown as {
            cause: Cause;
            steps: RepairStep[];
            highlight_id: string;
          };
          setCause(done.cause);
          setSteps(done.steps || []);
          setStepIndex(0);
          setHighlightId(done.highlight_id || null);
          const first = (done.steps || [])[0];
          if (done.cause) {
            say(`${done.cause.title}. ${done.cause.explanation}`, live.current.lang, turn);
          }
          if (first) say(first.instruction, live.current.lang, turn);
          break;
        }
        default:
          break;
      }
    },
    [mergeBoxes]
  );

  const runAnalysis = useCallback(
    async (text: string, turn: number) => {
      const video = videoRef.current;
      const grab = grabRef.current;
      const still = stillRef.current;
      if (!video?.videoWidth || !grab || !still) {
        setStatusMsg("Camera not ready yet — try again.");
        setMode("live");
        return;
      }
      try {
        // The system captures the still itself, the moment it has your words.
        grab.width = video.videoWidth;
        grab.height = video.videoHeight;
        grab.getContext("2d")?.drawImage(video, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) =>
          grab.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("still encode failed"))),
            "image/jpeg",
            0.85
          )
        );
        const bmp = await createImageBitmap(blob);
        still.width = bmp.width;
        still.height = bmp.height;
        still.getContext("2d")?.drawImage(bmp, 0, 0);

        const fd = new FormData();
        fd.append("file", blob, "still.jpg");
        fd.append("transcript", text);
        if (overrideRef.current !== "auto") {
          fd.append("lang_override", overrideRef.current);
        }
        const res = await fetch("/api/analyze", { method: "POST", body: fd });
        if (!res.ok || !res.body) throw new Error(`/api/analyze -> ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() || "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)), turn);
            } catch (_) {
              // Skip a malformed frame; the stream continues.
            }
          }
        }
      } catch (e) {
        if (turn === turnId.current) {
          setStatusMsg("Analysis failed: " + (e as Error).message);
          setMode("live");
        }
      }
    },
    [handleEvent]
  );

  const startTurn = useCallback(
    async (text: string) => {
      const turn = turnId.current + 1;
      turnId.current = turn;
      stopSpeech();
      speechChain.current = Promise.resolve();
      // Fresh turn: live feed stays underneath, still + findings reset.
      setMode("working");
      setBoxes([]);
      live.current.boxes = [];
      setHighlightId(null);
      setThinking([]);
      setEvidence([]);
      setCause(null);
      setSteps([]);
      setStepIndex(0);
      setTranscript(text);
      setStatusMsg("");
      await runAnalysis(text, turn);
    },
    [runAnalysis]
  );

  // Advance speaks the new step aloud.
  async function goToStep(idx: number): Promise<void> {
    const s = live.current.steps;
    if (!s.length) return;
    const clamped = Math.min(Math.max(idx, 0), s.length - 1);
    setStepIndex(clamped);
    say(s[clamped].instruction, live.current.lang, turnId.current);
  }

  const handleTranscript = useCallback(
    async (text: string) => {
      stopListeningInner();
      const { steps: s, stepIndex: cur } = live.current;
      if (NEXT_WORDS.test(text) && s.length) {
        await goToStep(cur + 1);
        return;
      }
      await startTurn(text);
    },
    [startTurn]
  );

  const recogCb = useRef(handleTranscript);
  recogCb.current = handleTranscript;

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
  }

  function startListening(): void {
    const SR = getSpeechRecognition();
    if (!SR) {
      setStatusMsg("No built-in voice recognition — type the issue below.");
      return;
    }
    stopListeningInner();
    const recog = new SR();
    recog.lang = recogLocale.current;
    recog.interimResults = false;
    setListening(true);
    recog.onresult = (e) => recogCb.current(e.results[0][0].transcript);
    recog.onend = () => {
      recogRef.current = null;
      setListening(false);
    };
    recog.onerror = (e) => setStatusMsg("Voice error: " + e.error);
    try {
      recog.start();
      recogRef.current = recog;
    } catch (e) {
      setStatusMsg("Voice error: " + (e as Error).message);
    }
  }

  function tagPart(e: React.MouseEvent<HTMLDivElement>): void {
    if (mode === "live" || (e.target as HTMLElement).closest(".box")) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    tagCountRef.current += 1;
    const n = tagCountRef.current;
    const part: StageBox = {
      id: "part-" + n,
      label: "part-" + n,
      x: Math.max(0, x - 0.1),
      y: Math.max(0, y - 0.1),
      w: 0.2,
      h: 0.2,
      confidence: 0.9,
    };
    mergeBoxes([part]);
  }

  // ---- GSAP motion (all skipped under prefers-reduced-motion) ----
  useEffect(() => {
    if (mode !== "live") stillIn(wrapRef.current);
  }, [mode]);

  useEffect(() => {
    const boxEls = boxesRef.current?.querySelectorAll(":scope > .box");
    if (boxEls?.length) popIn(boxEls);
  }, [boxes]);

  useEffect(() => {
    if (evidence.length) popIn(evidenceRef.current?.querySelectorAll(".ev") || []);
  }, [evidence]);

  useEffect(() => {
    if (cause) riseIn(causeBlockRef.current);
  }, [cause]);

  useEffect(() => {
    if (steps.length) riseIn(stepsBlockRef.current);
  }, [steps, stepIndex]);

  useEffect(() => {
    if (statusMsg) riseIn(statusRef.current);
  }, [statusMsg]);

  useEffect(() => {
    const btn = micRef.current;
    if (!btn) return;
    pulseRef.current?.kill();
    pulseRef.current = null;
    if (listening && !reducedMotion()) {
      pulseRef.current = gsap.to(btn, {
        scale: 1.07,
        duration: 0.45,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
    } else {
      gsap.set(btn, { scale: 1 });
    }
    return () => {
      pulseRef.current?.kill();
      pulseRef.current = null;
    };
  }, [listening]);

  if (view === "repair") {
    return (
      <main className="stage">
        <div className="controls" style={{ padding: 12 }}>
          <button type="button" onClick={() => setView("live")}>
            ← Back to live camera
          </button>
        </div>
        <RepairWalkthrough />
      </main>
    );
  }

  return (
    <main className="stage">
      <div className="controls" style={{ padding: 12 }}>
        <button type="button" onClick={() => setView("repair")}>
          Repair a photo →
        </button>
      </div>
      <video ref={videoRef} className="live" autoPlay playsInline muted />

      {/* Always mounted (hidden while live) so the system can draw its
          captured still before the overlay state flips. */}
      <div ref={wrapRef} className="stillWrap" onClick={tagPart} hidden={mode === "live"}>
        <canvas ref={stillRef} className="still" />
        <div ref={boxesRef} className="boxes">
          {boxes.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"box" + (c.id === highlightId ? " hl" : "")}
              style={{
                left: c.x * 100 + "%",
                top: c.y * 100 + "%",
                width: c.w * 100 + "%",
                height: c.h * 100 + "%",
              }}
            >
              <span>{c.label} {Math.round((c.confidence || 0) * 100)}%</span>
            </button>
          ))}
        </div>
      </div>

      {statusMsg && <div ref={statusRef} className="status" role="status">{statusMsg}</div>}

      <section className="panel">
        {transcript && (
          <p className="transcript">
            &ldquo;{transcript}&rdquo; <span className="langBadge">{badgeText()}</span>
          </p>
        )}

        {!!thinking.length && (
          <ol className="thinking">
            {thinking.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        )}

        {!!evidence.length && (
          <div ref={evidenceRef} className="evidence">
            {evidence.map((e) => (
              <figure key={e.id} className="ev">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/jpeg;base64,${e.jpeg_b64}`} alt={e.label} />
                <figcaption>{e.label}</figcaption>
              </figure>
            ))}
          </div>
        )}

        {cause && (
          <div ref={causeBlockRef} className="causes">
            <p>Probable cause:</p>
            <div className="cause sel">
              <div>{cause.title}</div>
              <small>{cause.explanation}</small>
            </div>
          </div>
        )}

        {!!steps.length && (
          <div ref={stepsBlockRef} className="steps">
            <p>Step {stepIndex + 1} of {steps.length}: {steps[stepIndex]?.instruction}</p>
            <button type="button" onClick={() => goToStep(stepIndex + 1)}>Next</button>
          </div>
        )}

        <div className="controls">
          <button
            ref={micRef}
            type="button"
            className={"micBtn" + (listening ? " live" : "")}
            onClick={() => (listening ? stopListeningInner() : startListening())}
          >
            {listening ? "Stop" : "Talk"}
          </button>
        </div>

        <form
          className="typeForm"
          onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get("issue")?.toString().trim();
            if (v) {
              e.currentTarget.reset();
              void handleTranscript(v);
            }
          }}
        >
          <input name="issue" type="text" placeholder="Or type the issue…" autoComplete="off" />
          <button type="submit">Send</button>
        </form>

        <label className="langPick">
          Voice
          <select
            value={langOverride}
            onChange={(e) => pickOverride(e.target.value)}
            aria-label="Reply language"
          >
            <option value="auto">Auto-detect</option>
            {langOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        <p className="hint">Tap Talk and describe the issue — I take it from there.</p>
      </section>

      <canvas ref={grabRef} hidden />
    </main>
  );
}
