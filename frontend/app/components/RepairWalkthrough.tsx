"use client";

/* Photo repair walkthrough: image in -> Muse Spark names components,
   Muse Image highlights them step by step with an IKEA-style legend,
   spoken thinking throughout. Embedded in the main app's repair view. */

import { useEffect, useRef, useState } from "react";

interface Instance {
  label: string;
  score: number;
  box: { x: number; y: number; w: number; h: number };
  mask_png_b64: string;
  mask_w: number;
  mask_h: number;
}

const COLORS = ["#ffc53d", "#4cc38a", "#5aa9e6", "#ef6461", "#b388eb"];

export default function RepairWalkthrough({
  file,
  issue,
  onClose,
}: {
  file: File;
  issue: string;
  onClose: () => void;
}) {
  const [imgURL, setImgURL] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [instances, setInstances] = useState<Instance[]>([]);
  const [status, setStatus] = useState<string>("");
  const [overlayURL, setOverlayURL] = useState<string>("");
  const [causes, setCauses] = useState<string[]>([]);
  const [steps, setSteps] = useState<
    { check: string; how: string; part: string | null; caution?: string | null }[]
  >([]);
  const [legend, setLegend] = useState<{ label: string; color: string; tag?: string }[]>([]);
  const [aids, setAids] = useState<{ title: string; url: string; kind?: string; videos?: { id: string; url: string }[] }[]>([]);
  const [resolution, setResolution] = useState<string>("");
  const [device, setDevice] = useState<string>("");
  const [ask, setAsk] = useState<string>("");
  const [safety, setSafety] = useState<string[]>([]);
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
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<File | null>(null);

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
      const color = COLORS[i % COLORS.length];
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
        `${inst.label} ${Math.round(inst.score * 100)}%`,
        b.x * canvas.width + 4,
        Math.max(14, b.y * canvas.height - 6)
      );
    }
  }

  // Same host as the page (works from a phone on the LAN, not just
  // localhost) — the backend port is fixed at 8000 by `make`.
  const API =
    typeof window === "undefined"
      ? "http://127.0.0.1:8000"
      : `http://${window.location.hostname}:8000`;

  const [said, setSaid] = useState<string[]>([]);
  // Serial speech: every line waits for the previous audio to finish,
  // so lines never overlap.
  const speechQueue = useRef<Promise<void>>(Promise.resolve());

  function say(line: string): Promise<void> {
    setSaid((prev) => [...prev, line]);
    speechQueue.current = speechQueue.current
      .then(() => speakOnce(line))
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

  async function speakOnce(line: string): Promise<void> {
    try {
      const r = await fetch(`${API}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, lang: "en" }),
      });
      const data = await r.json();
      if (data.audio_b64) {
        const bytes = Uint8Array.from(atob(data.audio_b64), (c) =>
          c.charCodeAt(0)
        );
        const url = URL.createObjectURL(
          new Blob([bytes], { type: data.mime || "audio/wav" })
        );
        await new Promise<void>((res) => {
          const done = () => res();
          const a = new Audio(url);
          a.onended = done;
          a.onerror = done;
          setTimeout(done, 120000);
          a.play().catch(done);
        });
        URL.revokeObjectURL(url);
        return;
      }
    } catch (_) {
      // Fall through to the browser voice.
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

  // System-captured still: analysis starts on its own, no buttons.
  useEffect(() => {
    fileRef.current = file;
    setImgURL(URL.createObjectURL(file));
    void run(file, issue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(f: File, t: string) {
    setStatus("Analyzing…");
    setInstances([]);
    setNotes("");
    setOverlayURL("");
    setCauses([]);
    setSteps([]);
    setLegend([]);
    setAids([]);
    setSaid([]);
    setStepIdx(0);
    setResolution("");
    setDevice("");
    setDetails({});
    setAsk("");
    setInventory([]);
    setSafety([]);
    await say("Looking at your photo now. Figuring out the appliance and its parts.");
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("text", t);
      const r = await fetch(`${API}/api/repair/analyze`, { method: "POST", body: fd });
      const data = await r.json();
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
      setHidden(new Set());
      const overlay = data.overlay as
        | { image_b64: string; mime: string; legend: { label: string; color: string; tag?: string }[] }
        | null
        | undefined;
      setLegend(data.legend || overlay?.legend || []);
      setAids(data.aids || []);
      setInventory(data.components || []);
      if (overlay?.image_b64) {
        setOverlayURL(
          `data:${overlay.mime || "image/webp"};base64,${overlay.image_b64}`
        );
      } else {
        setOverlayURL("");
      }
      setStatus(
        list.length
          ? `${list.length} masks`
          : overlay?.image_b64
            ? "Highlighted image"
            : "No masks came back."
      );
      const foundSafety: string[] = data.safety || [];
      setSafety(foundSafety);
      if (foundSafety.length) {
        await say(`Before you touch anything: ${foundSafety.join(". ")}`);
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
      if (data.device) {
        setDevice(data.device);
        await say(`I can see this is a ${data.device}.`);
      }
      if (data.details && typeof data.details === "object") {
        setDetails(data.details);
        const bits = [
          data.details.color ? `in ${data.details.color}` : "",
          data.details.condition ? `looking ${data.details.condition}` : "",
          data.details.serial ? `serial ${data.details.serial}` : "",
        ].filter(Boolean);
        if (bits.length) await say(`Details: ${bits.join(", ")}.`);
      }
      if (data.issue) {
        await say(`I understand the issue as: ${data.issue}`);
      }
      const firstTag = (data.legend || overlay?.legend || [])[0]?.tag;
      const hasParts =
        list.length > 0 || (data.components || []).length > 0;
      await say(
        `${data.notes || "Analysis done."} ${
          overlay?.image_b64
            ? firstTag
              ? `I have marked the first part as ${firstTag} on your photo.`
              : `I have marked the parts on your photo.`
            : hasParts
              ? `I found the parts, but could not draw the highlights.`
              : "But no parts came back to highlight."
        }`
      );
      if (foundCauses.length) {
        await say(`Likely causes: ${foundCauses.join(". ")}`);
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
      await drawMasks(list, new Set());
    } catch (e) {
      const msg = "Failed: " + (e as Error).message;
      setStatus(msg);
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
    await say(
      `Step ${i + 1} of ${total}: check ${st.check}.` +
        (st.how ? ` How: ${st.how}` : "") +
        (tag ? ` Look for ${tag} on the photo.` : "") +
        (st.caution ? ` Careful: ${st.caution}` : "")
    );
  }

  async function goStep(i: number): Promise<void> {
    if (i < 0 || i >= steps.length || !fileRef.current) return;
    setStepIdx(i);
    const st = steps[i];
    if (st.part) {
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
        Still captured from your camera. Naming the parts, highlighting
        them step by step, talking you through the fix.
      </p>
      <p>
        You said: <em>&ldquo;{issue}&rdquo;</em>{" "}
        <button type="button" onClick={onClose}>
          Close and point the camera again
        </button>
      </p>
      {status && <p role="status">{status}</p>}
      {notes && <p><em>{notes}</em></p>}
      {device && <p><strong>Detected device:</strong> {device}</p>}
      {ask && (
        <p style={{ fontWeight: "bold" }}>
          {ask} (Close this and describe the problem, then I will dig in.)
        </p>
      )}
      {inventory.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p><strong>What I see — every part</strong></p>
          <ul>
            {inventory.map((c, i) => (
              <li key={i}>
                <strong>{c.label}</strong>
                {[c.color, c.condition, c.position].filter(Boolean).join(" · ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(details.serial || details.color || details.condition ||
        (details.markings || []).length > 0 || (details.other || []).length > 0) && (
        <div style={{ marginTop: 8 }}>
          <p><strong>Every little detail</strong></p>
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
        <div style={{ marginTop: 8 }}>
          <p><strong>Thinking aloud</strong></p>
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
          <p>Highlighted by Muse Image:</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={overlayURL} alt="highlighted" style={{ width: "100%", display: "block" }} />
        </div>
      )}
      {safety.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p><strong>Handle with care</strong></p>
          <ul>
            {safety.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {causes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p><strong>Likely causes</strong></p>
          <ul>
            {causes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {steps.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p><strong>What to do next — step {stepIdx + 1} of {steps.length}</strong></p>
          {(() => {
            const s = steps[stepIdx];
            if (!s) return null;
            const tag = legend.find(
              (e) => s.part && e.label.toLowerCase() === s.part.toLowerCase()
            )?.tag;
            return (
              <div>
                <div><strong>Check:</strong> {s.check}</div>
                {s.how && <div><strong>How:</strong> {s.how}</div>}
                {s.caution && <div><strong>Do not touch:</strong> {s.caution}</div>}
                {s.part && (
                  <div>
                    <strong>Part:</strong>{" "}
                    {tag && (
                      <span
                        style={{
                          display: "inline-block",
                          minWidth: 22,
                          textAlign: "center",
                          fontWeight: "bold",
                          color: "#fff",
                          background:
                            legend.find(
                              (e) =>
                                s.part &&
                                e.label.toLowerCase() === s.part.toLowerCase()
                            )?.color || "#666",
                          borderRadius: 4,
                          marginRight: 6,
                        }}
                      >
                        {tag}
                      </span>
                    )}{" "}
                    {s.part}
                  </div>
                )}
                {aids
                  .filter((a) => a.title.startsWith(`Step ${stepIdx + 1} video`))
                  .map((a, j) => (
                    <div key={j}>
                      <a href={a.url} target="_blank" rel="noreferrer">Video for this step</a>
                    </div>
                  ))}
              </div>
            );
          })()}
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void goStep(stepIdx - 1)}
              disabled={stepIdx === 0 || stepLoading}
            >
              Back
            </button>
            <button
              type="button"
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
          <p><strong>Legend</strong></p>
          {legend.map((e, i) => (
            <div key={i}>
              <span
                style={{
                  display: "inline-block",
                  minWidth: 22,
                  textAlign: "center",
                  fontWeight: "bold",
                  color: "#fff",
                  background: e.color,
                  borderRadius: 4,
                  marginRight: 6,
                }}
              >
                {e.tag || String.fromCharCode(65 + i)}
              </span>
              {e.label}
            </div>
          ))}
        </div>
      )}
      {resolution && (
        <div style={{ marginTop: 8 }}>
          <p><strong>Did it work?</strong></p>
          <p>{resolution}</p>
          <button
            type="button"
            onClick={() => void say(`Resolution check: ${resolution}`)}
          >
            Read the resolution check aloud
          </button>
        </div>
      )}
      {aids.filter((a) => !a.title.startsWith("Step ")).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p><strong>Watch and learn</strong></p>
          {aids
            .filter((a) => !a.title.startsWith("Step "))
            .map((a, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                {(a.videos || []).map((v) => (
                  <div key={v.id} style={{ marginBottom: 8 }}>
                    <iframe
                      width="100%"
                      height="240"
                      src={`https://www.youtube-nocookie.com/embed/${v.id}`}
                      title={a.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                ))}
                <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
              </div>
            ))}
        </div>
      )}
      {instances.map((inst, i) => (
        <label key={i} style={{ display: "block", marginTop: 4 }}>
          <input type="checkbox" checked={!hidden.has(i)} onChange={() => toggle(i)} />{" "}
          <span style={{ color: COLORS[i % COLORS.length] }}>■</span> {inst.label}{" "}
          ({Math.round(inst.score * 100)}%)
        </label>
      ))}
    </section>
  );
}
