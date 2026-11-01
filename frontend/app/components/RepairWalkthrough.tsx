"use client";

/* Photo repair walkthrough: image in -> Muse Spark names components,
   Muse Image highlights them step by step with an IKEA-style legend,
   spoken thinking throughout. Embedded in the main app's repair view. */

import { useEffect, useRef, useState } from "react";
import { resolveApiBase } from "../lib/apiBase";
import { mark } from "../lib/timeline";
import { requestDiagnosis } from "../lib/diagnosis";

interface Instance {
  label: string;
  score: number | null;
  box: { x: number; y: number; w: number; h: number };
  mask_png_b64: string;
  mask_w: number;
  mask_h: number;
}

const ORANGE = "#e86a17";

export default function RepairWalkthrough({
  files,
  issue,
  perception,
  prefetched,
  onMoreViews,
  onClose,
}: {
  files: File[];
  issue: string;
  perception?: unknown;
  // Diagnosis already started during the device confirmation.
  prefetched?: Promise<unknown> | null;
  onMoreViews?: () => void;
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
  const [risk, setRisk] = useState<{ level: string; hazard: string; reason: string } | null>(null);
  // riskOk: the user explicitly accepted responsibility for a high-risk job.
  const [riskOk, setRiskOk] = useState<boolean>(false);
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
  const [permit, setPermit] = useState<boolean>(false);
  const [contactName, setContactName] = useState<string>("");
  const [contactPhone, setContactPhone] = useState<string>("");
  const [contactAddr, setContactAddr] = useState<string>("");
  const [ticket, setTicket] = useState<{
    ref: string;
    summary: string;
    device: string;
    issue: string;
    name: string;
    phone: string;
    address: string;
  } | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
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

  function say(line: string): Promise<void> {
    setSaid((prev) => [...prev, line]);
    const audio = synthQueue.current.then(() => fetchSpeech(line));
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
  async function fetchSpeech(line: string): Promise<string | null> {
    mark("tts request", JSON.stringify(line.slice(0, 40)));
    try {
      const r = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, lang: "en" }),
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
    setRisk(null);
    setRiskOk(false);
    setFixed(false);
    setBooking(false);
    setPermit(false);
    setTicket(null);
    setContactName("");
    setContactPhone("");
    setContactAddr("");
    // Spoken while the analysis runs, not before it starts.
    void say("Working out what's wrong.");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any =
        (prefetched ? await prefetched : null) ||
        (await requestDiagnosis(base, fs, t, perception));
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
      const segLabels: string[] = data.segment_labels || [];
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
      const foundRisk = data.risk && typeof data.risk === "object" ? data.risk : null;
      setRisk(foundRisk);
      setRiskOk(false);
      if (foundRisk && foundRisk.level === "high") {
        await say(
          `Safety warning. ${foundRisk.reason} This could be dangerous. ` +
            "I can pull in a handyman for you, or you can proceed at your " +
            "own risk. Tap your choice on the screen."
        );
      }
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
      if (foundSteps.length && !(foundRisk && foundRisk.level === "high")) {
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

  async function acceptRisk(): Promise<void> {
    setRiskOk(true);
    await say(
      "Understood — you are proceeding at your own risk. Follow each step " +
        "exactly, and stop straight away if anything sparks, smokes or " +
        "smells burnt."
    );
  }

  async function confirmFixed(yes: boolean): Promise<void> {
    if (yes) {
      setFixed(true);
      await say("Great, glad it is fixed. Closing the loop here.");
    } else {
      setBooking(true);
      await say(
        "Sorry it is still broken. I can book a handyman visit with " +
          "everything I found. Do you want me to go ahead?"
      );
    }
  }

  async function startBooking(yes: boolean): Promise<void> {
    if (!yes) {
      await say("No problem, I will not book anyone.");
      return;
    }
    setPermit(true);
    await say(
      "Thanks. Tell me your name, phone number, and where the handyman should come."
    );
  }

  async function raiseTicket(): Promise<void> {
    const now = new Date();
    const ref = `HM-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`;
    const t = {
      ref,
      summary: `Visit for: ${issue}`,
      device: device || "unknown device",
      issue,
      name: contactName.trim() || "not given",
      phone: contactPhone.trim() || "not given",
      address: contactAddr.trim() || "not given",
    };
    setTicket(t);
    await say(
      `Booking request ${ref} is ready. ${t.summary}, for ${t.device}. ` +
        "No service provider is connected yet, so share this request with your handyman."
    );
  }

  async function shareTicket(): Promise<void> {
    if (!ticket) return;
    const text =
      `${ticket.ref}: ${ticket.summary}\nDevice: ${ticket.device}\n` +
      `Contact: ${ticket.name} (${ticket.phone})\nAddress: ${ticket.address}`;
    try {
      const nav = window.navigator as Navigator & {
        share?: (d: { title: string; text: string }) => Promise<void>;
      };
      if (nav.share) {
        await nav.share({ title: ticket.ref, text });
        return;
      }
    } catch (_) {
      // Fall through to clipboard.
    }
    try {
      await window.navigator.clipboard.writeText(text);
      await say("Request copied. Paste it to your handyman.");
    } catch (_) {
      await say("Sharing is not available here. Note down the reference.");
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
      {risk?.level === "high" && !riskOk && !booking && !ticket && (
        <div className="consent-sheet">
          <p className="sheet-label">Risky job — your call</p>
          <div className="callout callout-dont-touch">
            <p className="sheet-label">Warning</p>
            <p>{risk.reason}</p>
          </div>
          <p>Want me to pull in people who can help, or proceed at your own risk?</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={() => setBooking(true)}>
              Get help
            </button>
            <button type="button" className="btn-outline" onClick={() => void acceptRisk()}>
              I proceed at my own risk
            </button>
          </div>
        </div>
      )}
      {steps.length > 0 && !(risk?.level === "high" && !riskOk) && (
        <div style={{ marginTop: 8 }}>
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
              onClick={() => void goStep(stepIdx + 1)}
              disabled={stepIdx >= steps.length - 1 || stepLoading}
            >
              {stepLoading ? "Highlighting…" : stepIdx >= steps.length - 1 ? "Done" : "Next step"}
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
      {resolution && (
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
      {booking && !ticket && (
        <div className="consent-sheet">
          <p className="sheet-label">Book a handyman?</p>
          <table>
            <tbody>
              <tr><td>Device</td><td>{device || "as identified above"}</td></tr>
              <tr><td>Issue</td><td>{issue}</td></tr>
              <tr><td>Shares</td><td>photos, findings and contact you enter below</td></tr>
            </tbody>
          </table>
          <p>May I go ahead?</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={() => void startBooking(true)}>
              Yes, book one
            </button>
            <button type="button" className="btn-ink" onClick={() => setBooking(false)}>
              No thanks
            </button>
          </div>
        </div>
      )}
      {booking && !ticket && permit && (
        <div className="consent-sheet" style={{ marginTop: 8, display: "grid", gap: 8 }}>
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Your name"
            className="text-input"
            autoComplete="off"
          />
          <input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="Phone number"
            className="text-input"
            autoComplete="off"
          />
          <input
            value={contactAddr}
            onChange={(e) => setContactAddr(e.target.value)}
            placeholder="Visit address / note"
            className="text-input"
            autoComplete="off"
          />
          <button type="button" className="btn-primary" onClick={() => void raiseTicket()}>
            Raise booking request
          </button>
        </div>
      )}
      {ticket && (
        <div className="consent-sheet">
          <p className="sheet-label">Booking request {ticket.ref}</p>
          <p>{ticket.summary}</p>
          <table>
            <tbody>
              <tr><td>Device</td><td>{ticket.device}</td></tr>
              <tr><td>Issue</td><td>{ticket.issue}</td></tr>
              <tr><td>Contact</td><td>{ticket.name} ({ticket.phone})</td></tr>
              <tr><td>Address</td><td>{ticket.address}</td></tr>
            </tbody>
          </table>
          <p>
            No provider is connected yet, so this request is ready to send —
            share it with your handyman or service center.
          </p>
          <button type="button" className="btn-ink" onClick={() => void shareTicket()}>
            Share booking request
          </button>
        </div>
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
