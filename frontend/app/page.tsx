"use client";

/* Single flow: point the camera, Talk (or type) the issue, the system
   captures a still itself and opens screen #2 — the repair overlay —
   with images, spoken thinking transcript, steps, and videos. */

import { useEffect, useRef, useState } from "react";
import { getSpeechRecognition } from "./lib/speech";
import type { SpeechRecognitionLike } from "./lib/speech";
import RepairWalkthrough from "./components/RepairWalkthrough";

interface Overlay {
  files: File[];
  text: string;
  key: number;
}

const INTAKE_STILLS = 3;
const INTAKE_GAP_MS = 1500;

function speakPrompt(line: string): void {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(line);
    u.lang = "en-US";
    window.speechSynthesis.speak(u);
  } catch (_) {
    // Voice unavailable; the on-screen prompt still guides.
  }
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const turnRef = useRef<number>(0);

  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [listening, setListening] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");

  useEffect(() => {
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
  }, []);

  function captureStillAsync(): Promise<File | null> {
    const video = videoRef.current;
    const grab = grabRef.current;
    if (!video?.videoWidth || !grab) return Promise.resolve(null);
    grab.width = video.videoWidth;
    grab.height = video.videoHeight;
    grab.getContext("2d")?.drawImage(video, 0, 0);
    return new Promise((resolve) =>
      grab.toBlob(
        (b) => resolve(b ? new File([b], "still.jpg", { type: "image/jpeg" }) : null),
        "image/jpeg",
        0.85
      )
    );
  }

  async function startTurn(text: string) {
    const said = text.trim();
    if (!said) return;
    stopListeningInner();
    setTranscript(said);
    // Intake: the system asks for repositioning and captures the stills
    // itself — as many as it needs for the analysis.
    const stills: File[] = [];
    const prompts = [
      "Hold steady, capturing the first view.",
      "Now move a little closer to the faulty area.",
      "One more — a slightly different angle.",
    ];
    for (let i = 0; i < INTAKE_STILLS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, INTAKE_GAP_MS));
      const msg = `Capturing view ${i + 1} of ${INTAKE_STILLS}…`;
      setStatusMsg(msg);
      speakPrompt(prompts[i] || msg);
      const still = await captureStillAsync();
      if (still) stills.push(still);
    }
    if (!stills.length) {
      setStatusMsg("Camera not ready yet — try again.");
      return;
    }
    setStatusMsg("");
    turnRef.current += 1;
    // Screen #2: the repair overlay over the live camera.
    setOverlay({ files: stills, text: said, key: turnRef.current });
  }

  const recogCb = useRef(startTurn);
  recogCb.current = startTurn;

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
    recog.lang = "en-US";
    recog.interimResults = false;
    setListening(true);
    recog.onresult = (e) => void recogCb.current(e.results[0][0].transcript);
    recog.onend = () => {
      recogRef.current = null;
      setListening(false);
    };
    recog.onerror = () => {
      recogRef.current = null;
      setListening(false);
    };
    try {
      recog.start();
      recogRef.current = recog;
    } catch (e) {
      setStatusMsg("Voice error: " + (e as Error).message);
    }
  }

  return (
    <main className="stage">
      <video ref={videoRef} className="live" autoPlay playsInline muted />

      {statusMsg && <div className="status" role="status">{statusMsg}</div>}

      <section className="panel">
        {transcript && (
          <p className="transcript">&ldquo;{transcript}&rdquo;</p>
        )}

        <div className="controls">
          <button
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
              void startTurn(v);
            }
          }}
        >
          <input name="issue" type="text" placeholder="Or type the issue…" autoComplete="off" />
          <button type="submit">Send</button>
        </form>

        <p className="hint">Point at the device, tap Talk, describe the issue — I capture stills and take it from there.</p>
      </section>

      {overlay && (
        <div className="overlay">
          <RepairWalkthrough
            key={overlay.key}
            files={overlay.files}
            issue={overlay.text}
            onClose={() => setOverlay(null)}
          />
        </div>
      )}

      <canvas ref={grabRef} hidden />
    </main>
  );
}
