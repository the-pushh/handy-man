"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { popIn, reducedMotion, riseIn, stillIn } from "./lib/anim";

async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

function stopSpeech() {
  try {
    window.speechSynthesis.cancel();
  } catch (_) {}
}

async function speak(text) {
  try {
    const data = await postJSON("/api/tts", { text });
    if (data.audio_b64) {
      const bytes = Uint8Array.from(atob(data.audio_b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: data.mime || "audio/wav" }));
      await new Audio(url).play();
      return;
    }
  } catch (_) {
    // Fall through to the browser voice.
  }
  stopSpeech();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

export default function Home() {
  const videoRef = useRef(null);
  const grabRef = useRef(null);
  const stillRef = useRef(null);
  const wrapRef = useRef(null);
  const recogRef = useRef(null);
  const tagCountRef = useRef(0);
  const boxesRef = useRef(null);
  const causesBlockRef = useRef(null);
  const stepsBlockRef = useRef(null);
  const captionRef = useRef(null);
  const transcriptRef = useRef(null);
  const statusRef = useRef(null);
  const micRef = useRef(null);
  const pulseRef = useRef(null);

  const [mode, setMode] = useState("live");
  const [components, setComponents] = useState([]);
  const [causes, setCauses] = useState([]);
  const [cause, setCause] = useState(null);
  const [steps, setSteps] = useState([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [caption, setCaption] = useState("");
  const [listening, setListening] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Latest values for use inside recognition callbacks.
  const live = useRef({ mode, steps, transcript });
  live.current = { mode, steps, transcript };

  useEffect(() => {
    let stream;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (_) {
        setStatusMsg("Camera blocked — allow camera access and reload.");
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  const highlightLabel = steps.length
    ? steps[stepIndex]?.highlightLabel
    : cause?.relatedComponentLabel;

  const refreshCaptionAndSpeech = useCallback(async (theCause, theSteps, idx) => {
    if (!theCause) return;
    const step = theSteps.length ? theSteps[idx] : null;
    const ov = await postJSON("/api/overlay", {
      cause: theCause,
      components: live.current.components ?? [],
    }).catch(() => null);
    const text = step
      ? `Step ${idx + 1}: ${step.instruction}`
      : ov?.caption || `Possible cause: ${theCause.title}.`;
    setCaption(text);
    await speak(text);
  }, []);

  const diagnose = useCallback(async (text, comps) => {
    setStatusMsg("Asking Glimmer…");
    try {
      const data = await postJSON("/api/diagnose", {
        transcript: text,
        components: comps,
      });
      setMode("diagnosing");
      const found = data.causes || [];
      setCauses(found);
      const first = found[0] || null;
      setCause(first);
      setSteps([]);
      setStepIndex(0);
      await refreshCaptionAndSpeech(first, [], 0);
      setStatusMsg("");
    } catch (e) {
      setStatusMsg("Diagnosis failed: " + e.message);
    }
  }, [refreshCaptionAndSpeech]);

  const capture = useCallback(async (text) => {
    const video = videoRef.current;
    if (!video?.videoWidth) {
      setStatusMsg("Camera not ready yet.");
      return;
    }
    setStatusMsg("Capturing…");
    try {
      const grab = grabRef.current;
      grab.width = video.videoWidth;
      grab.height = video.videoHeight;
      grab.getContext("2d").drawImage(video, 0, 0);
      const blob = await new Promise((res) => grab.toBlob(res, "image/jpeg", 0.85));
      const bmp = await createImageBitmap(blob);
      const still = stillRef.current;
      still.width = bmp.width;
      still.height = bmp.height;
      still.getContext("2d").drawImage(bmp, 0, 0);

      const fd = new FormData();
      fd.append("file", blob, "still.jpg");
      const r = await fetch("/api/detect", { method: "POST", body: fd });
      const data = await r.json();
      const comps = data.components || [];
      tagCountRef.current = 0;
      setComponents(comps);
      setMode("still");
      const spoken = text ?? live.current.transcript;
      if (!spoken) {
        setStatusMsg("Still captured. Describe the issue — tap Talk.");
        startListening();
      } else {
        await diagnose(spoken, comps);
      }
    } catch (e) {
      setStatusMsg("Capture failed: " + e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnose]);

  const handleTranscript = useCallback(async (text) => {
    stopListeningInner();
    setTranscript(text);
    const { mode: m, steps: s } = live.current;
    if (/^\s*next\s*\.?$/i.test(text) && s.length) {
      advanceStepInner();
      return;
    }
    if (m === "live") await capture(text);
    else await diagnose(text, live.current.components ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, diagnose]);

  const recogCb = useRef(handleTranscript);
  recogCb.current = handleTranscript;

  function stopListeningInner() {
    if (recogRef.current) {
      try {
        recogRef.current.abort();
      } catch (_) {}
      recogRef.current = null;
    }
    setListening(false);
  }

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatusMsg("No built-in voice recognition — type the issue below.");
      return;
    }
    stopListeningInner();
    const recog = new SR();
    recog.lang = "en-US";
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
      setStatusMsg("Voice error: " + e.message);
    }
  }

  // Drives step advance from both the button and the "next" voice command.
  const advRef = useRef(null);

  function advanceStepInner() {
    advRef.current?.();
  }

  async function advanceStep() {
    if (!steps.length) return;
    const idx = Math.min(stepIndex + 1, steps.length - 1);
    setStepIndex(idx);
    await refreshCaptionAndSpeech(cause, steps, idx);
  }
  advRef.current = advanceStep;

  async function selectCause(c) {
    setCause(c);
    try {
      const data = await postJSON("/api/steps", { cause: c, components });
      const s = data.steps || [];
      setSteps(s);
      setStepIndex(0);
      await refreshCaptionAndSpeech(c, s, 0);
    } catch (e) {
      setStatusMsg("Steps failed: " + e.message);
    }
  }

  function backToLive() {
    stopListeningInner();
    stopSpeech();
    setMode("live");
    setComponents([]);
    setCauses([]);
    setCause(null);
    setSteps([]);
    setStepIndex(0);
    setTranscript("");
    setCaption("");
    setStatusMsg("");
  }

  function tagPart(e) {
    if (mode === "live" || e.target.closest(".box")) return;
    const r = wrapRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    tagCountRef.current += 1;
    const n = tagCountRef.current;
    const next = [
      ...components,
      {
        label: "part-" + n,
        x: Math.max(0, x - 0.1),
        y: Math.max(0, y - 0.1),
        w: 0.2,
        h: 0.2,
        confidence: 0.9,
      },
    ];
    setComponents(next);
    live.current.components = next;
    setStatusMsg("Tagged part-" + n + ". Describe the issue when ready.");
  }

  // Keep the callback snapshot in sync (components change outside setState flows).
  useEffect(() => {
    live.current.components = components;
  }, [components]);

  // ---- GSAP motion (all skipped under prefers-reduced-motion) ----
  useEffect(() => {
    if (mode !== "live") stillIn(wrapRef.current);
  }, [mode]);

  useEffect(() => {
    const boxEls = boxesRef.current?.querySelectorAll(":scope > .box");
    if (boxEls?.length) popIn(boxEls);
  }, [components]);

  useEffect(() => {
    if (causes.length) riseIn(causesBlockRef.current);
  }, [causes]);

  useEffect(() => {
    if (steps.length) riseIn(stepsBlockRef.current);
  }, [steps, stepIndex]);

  useEffect(() => {
    if (caption) riseIn(captionRef.current);
  }, [caption]);

  useEffect(() => {
    if (transcript) riseIn(transcriptRef.current);
  }, [transcript]);

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

  return (
    <main className="stage">
      <video ref={videoRef} className="live" autoPlay playsInline muted />

      {mode !== "live" && (
        <div ref={wrapRef} className="stillWrap" onClick={tagPart}>
          <canvas ref={stillRef} className="still" />
          <div ref={boxesRef} className="boxes">
            {components.map((c) => (
              <button
                key={c.label}
                type="button"
                className={"box" + (c.label === highlightLabel ? " hl" : "")}
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
      )}

      {statusMsg && <div ref={statusRef} className="status" role="status">{statusMsg}</div>}

      <section className="panel">
        {transcript && <p ref={transcriptRef} className="transcript">&ldquo;{transcript}&rdquo;</p>}
        {caption && <p ref={captionRef}>{caption}</p>}

        {!!causes.length && (
          <div ref={causesBlockRef} className="causes">
            <p>Possible causes — tap one:</p>
            {causes.map((c, i) => (
              <button
                key={i}
                type="button"
                className={"cause" + (cause?.title === c.title ? " sel" : "")}
                onClick={() => selectCause(c)}
              >
                <div>{c.title}</div>
                <small>{c.explanation}</small>
              </button>
            ))}
          </div>
        )}

        {!!steps.length && (
          <div ref={stepsBlockRef} className="steps">
            <p>Step {stepIndex + 1} of {steps.length}: {steps[stepIndex]?.instruction}</p>
            <button type="button" onClick={advanceStep}>Next</button>
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
          <button type="button" className="capBtn" onClick={() => capture()}>
            Capture
          </button>
          {mode !== "live" && (
            <button type="button" onClick={backToLive}>Live</button>
          )}
        </div>

        <form
          className="typeForm"
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget).get("issue")?.toString().trim();
            if (v) {
              e.currentTarget.reset();
              handleTranscript(v);
            }
          }}
        >
          <input name="issue" type="text" placeholder="Or type the issue…" autoComplete="off" />
          <button type="submit">Send</button>
        </form>

        <p className="hint">Point at the appliance, tap Capture, then describe the issue.</p>
      </section>

      <canvas ref={grabRef} hidden />
    </main>
  );
}
