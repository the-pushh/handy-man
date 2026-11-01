"use client";

/* Single flow: point the camera, tap the orb, say what you need. The
   system captures a frame, detects the device, highlights it and asks
   for confirmation. On yes it captures the intake stills itself and
   opens screen #2 — the repair overlay. */

import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognition } from "./lib/speech";
import type { SpeechRecognitionLike } from "./lib/speech";
import { resolveApiBase } from "./lib/apiBase";
import { kb, mark, turnStart } from "./lib/timeline";
import { drawStill, shrinkPhoto } from "./lib/still";
import { composeMasks } from "./lib/masks";
import type { SamInstance } from "./lib/masks";
import { requestDiagnosis } from "./lib/diagnosis";
import Orb from "./components/Orb";
import type { OrbState } from "./components/Orb";
import RepairWalkthrough from "./components/RepairWalkthrough";

interface Overlay {
  files: File[];
  text: string;
  key: number;
  // The first look's Spark perception of files[0]; reused so the
  // walkthrough goes straight to diagnosis. Null once views are added.
  perception: unknown;
  prefetched: Promise<unknown> | null;
}

interface Confirm {
  device: string;
  overlayURL: string;
  frameURL: string;
  frame: File;
  perception: unknown;
  // Diagnosis for (frame, issue), started while the user confirms.
  diagnosis: Promise<unknown> | null;
  // Who drew the highlight: SAM 3.1 masks, a muse-image illustration,
  // or nothing yet (plain photo).
  highlight: "sam" | "illustrative" | "none";
}


function apiBase(): string {
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
  const confirmRef = useRef<Confirm | null>(null);
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
  const [orb, setOrb] = useState<OrbState>("idle");
  const [listening, setListening] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [transcript, setTranscript] = useState<string>("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [typeOpen, setTypeOpen] = useState<boolean>(false);
  const [beEdit, setBeEdit] = useState<boolean>(false);
  const [beHost, setBeHost] = useState<string>("");

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
    if (!file || confirmRef.current || overlay) return;
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

  // First action: detect the device in a captured frame, highlight it,
  // and ask until the user confirms it.
  async function startTurn(text: string, provided: File | null = null) {
    const said = text.trim();
    if (!said || confirmRef.current || overlay) return;
    stopListeningInner();
    setTranscript(said);
    issueRef.current = said;
    turnStart("turn start (issue heard)");
    // Only picks the narration voice; never blocks the look.
    void detectIssueLang(said).then(() => mark("detect-language done"));
    setOrb("thinking");
    setStatusMsg("Looking at what I can see…");
    const frame = provided || pendingFrameRef.current || (await captureStillAsync());
    pendingFrameRef.current = null;
    mark("frame captured", frame ? kb(frame.size) : "none");
    if (!frame) {
      setStatusMsg("Camera not ready yet — try again.");
      setOrb("idle");
      return;
    }
    // Caption: a tiny minimal-effort call in parallel with perception,
    // shown the moment it lands (target < 4s on prod).
    let perceived = false;
    const cfd = new FormData();
    cfd.append("file", frame, "frame.jpg");
    void fetch(`${apiBase()}/api/caption`, { method: "POST", body: cfd })
      .then((cr) => cr.json())
      .then((cd) => {
        if (cd.status === "ok" && !perceived) {
          mark("caption shown", JSON.stringify(cd.caption));
          setStatusMsg(cd.caption);
        } else mark("caption skipped", cd.status);
      })
      .catch(() => undefined);
    try {
      const fd = new FormData();
      fd.append("file", frame, "frame.jpg");
      fd.append("text", "");
      const r = await fetch(`${apiBase()}/api/repair/analyze`, {
        method: "POST",
        body: fd,
      });
      const data = await r.json();
      perceived = true;
      mark("analyze(1 still, no text) returned", `trace=${(data.trace || []).length} calls`);
      const device: string =
        data.device ||
        (data.notes || "").replace("The appliance is ", "").replace(/\.$/, "") ||
        "this appliance";
      const label = (data.components || [])[0]?.label || device;
      const frameURL = URL.createObjectURL(frame);
      const curl: Confirm = {
        device,
        overlayURL: frameURL,
        frameURL,
        frame,
        perception: data.perception || null,
        // Start diagnosing now: by the time the user says yes, the
        // verdict is mostly done. Dropped if they say no.
        diagnosis: data.perception
          ? requestDiagnosis(apiBase(), [frame], said, data.perception).catch(() => null)
          : null,
        highlight: "none",
      };
      // SAM 3.1 masks for the appliance arrive ~2s later in their own
      // request; muse-image (labelled illustrative) only if SAM finds
      // nothing. Neither delays the card or the question.
      const swap = (patch: Partial<Confirm>) => {
        const cur = confirmRef.current;
        if (!cur || cur.frameURL !== frameURL) return;
        const next = { ...cur, ...patch };
        confirmRef.current = next;
        setConfirm(next);
      };
      const segLabels: string[] = data.segment_labels || [];
      void (async () => {
        let sam: SamInstance[] = [];
        if (segLabels.length) {
          const sfd = new FormData();
          sfd.append("file", frame, "frame.jpg");
          sfd.append("labels", JSON.stringify(segLabels));
          try {
            const sd = await (await fetch(`${apiBase()}/api/segment`, { method: "POST", body: sfd })).json();
            sam = sd.instances || [];
          } catch (_) {
            sam = [];
          }
        }
        mark("sam returned", `${sam.length} masks`);
        if (sam.length) {
          swap({ overlayURL: await composeMasks(frameURL, sam), highlight: "sam" });
          return;
        }
        const hfd = new FormData();
        hfd.append("file", frame, "frame.jpg");
        hfd.append("part", label);
        mark("highlight requested", label);
        try {
          const hdata = await (await fetch(`${apiBase()}/api/repair/highlight`, { method: "POST", body: hfd })).json();
          mark("highlight returned", hdata.status);
          if (hdata.overlay?.image_b64) {
            swap({
              overlayURL: `data:${hdata.overlay.mime || "image/webp"};base64,${hdata.overlay.image_b64}`,
              highlight: "illustrative",
            });
          }
        } catch (_) {
          // The plain photo stays; the question still works.
        }
      })();
      confirmRef.current = curl;
      setConfirm(curl);
      setStatusMsg("");
      setOrb("asking");
      mark("confirm card rendered");
      await say(`Is this your ${device}?`);
      listenForConfirm();
    } catch (e) {
      setStatusMsg("Failed: " + (e as Error).message);
      setOrb("error");
      await say("Something went wrong looking at the device. Try again.");
      setOrb("idle");
    }
  }

  async function confirmYes() {
    const c = confirmRef.current;
    if (!c) return;
    mark("user said yes");
    stopListeningInner();
    confirmRef.current = null;
    setConfirm(null);
    setOrb("idle");
    setStatusMsg("");
    // One still by default: the frame the user just confirmed, with its
    // perception. More views only on demand (addView).
    void say("Got it.");
    turnRef.current += 1;
    setOverlay({
      files: [c.frame],
      text: issueRef.current,
      key: turnRef.current,
      perception: c.perception,
      prefetched: c.diagnosis,
    });
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
      files: still ? [...prev.files, still] : prev.files,
      text: prev.text,
      key: turnRef.current,
      perception: null,
      prefetched: null,
    });
  }

  async function confirmNo() {
    stopListeningInner();
    confirmRef.current = null;
    setConfirm(null);
    setOrb("idle");
    setStatusMsg("");
    await say("No problem. Point at the device you mean and tap the orb.");
  }

  const turnCb = useRef(startTurn);
  turnCb.current = startTurn;
  const confirmCb = useRef({ yes: confirmYes, no: confirmNo });
  confirmCb.current = { yes: confirmYes, no: confirmNo };

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
      if (confirmRef.current) {
        const low = heard.toLowerCase();
        if (/\byes\b|\byep\b|\byeah\b|\bcorrect\b|\bright\b/.test(low)) {
          void confirmCb.current.yes();
        } else if (/\bno\b|\bnot\b|\bwrong\b/.test(low)) {
          void confirmCb.current.no();
        } else {
          void say("Say yes if that is your device, or no to point again.");
          listenForConfirm();
        }
      } else {
        void turnCb.current(heard);
      }
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

  function listenForConfirm(): void {
    const SR = getSpeechRecognition();
    if (!SR) return;
    stopListeningInner();
    const recog = new SR();
    recog.lang = langRef.current.stt;
    recog.interimResults = false;
    recog.onresult = (e) => {
      const heard = (e.results[0][0].transcript as string).toLowerCase();
      if (/\byes\b|\byep\b|\byeah\b|\bcorrect\b|\bright\b/.test(heard)) {
        void confirmCb.current.yes();
      } else if (/\bno\b|\bnot\b|\bwrong\b/.test(heard)) {
        void confirmCb.current.no();
      } else {
        void say("Say yes if that is your device, or no to point again.");
        listenForConfirm();
      }
    };
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
      listen(recog);
    } catch (_) {
      // Voice unavailable; the Yes/No buttons still work.
    }
  }

  const cutoutLine =
    statusMsg ||
    (confirm
      ? `Is this your ${confirm.device}? Say yes or no.`
      : "Point at the device, then tap the orb and say what you need.");

  function collapseType(): void {
    setTypeOpen(false);
  }

  return (
    <main className="stage stage-camera">
      <div className="titleframe gridbars">HANDYMAN</div>

      <div className="cutout">
        <video ref={videoRef} className="live" autoPlay playsInline muted />

        <span className="crop tl" />
        <span className="crop tr" />
        <span className="crop bl" />
        <span className="crop br" />

        {!confirm && (
          <div className="cutout-bar" role="status">
            {cutoutLine}
          </div>
        )}

        {confirm && (
          <div className="confirm-card">
            <p className="sheet-label">Is this your device?</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={confirm.overlayURL} alt={`highlighted ${confirm.device}`} />
            {confirm.highlight !== "none" && (
              <p className="evidence-note">
                {confirm.highlight === "sam"
                  ? "Outlined by SAM 3.1 segmentation"
                  : "Illustrative highlight (muse-image), not a measured outline"}
              </p>
            )}
            <p className="instruction">{confirm.device}</p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn-success" onClick={() => void confirmYes()}>
                Yes
              </button>
              <button type="button" className="btn-outline" onClick={() => void confirmNo()}>
                No
              </button>
            </div>
          </div>
        )}
      </div>

      <section className="panel">
        {transcript && (
          <p className="transcript">&ldquo;{transcript}&rdquo;</p>
        )}
        <BackendRow
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
        />
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
              <span className="cb-label">TAP + SPEAK</span>
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
        <div className="overlay">
          <RepairWalkthrough
            key={overlay.key}
            files={overlay.files}
            issue={overlay.text}
            perception={overlay.perception}
            prefetched={overlay.prefetched}
            onMoreViews={() => void addView(overlay)}
            onClose={() => setOverlay(null)}
          />
        </div>
      )}

      <canvas ref={grabRef} hidden />
    </main>
  );
}
