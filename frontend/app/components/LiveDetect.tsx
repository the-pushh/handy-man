"use client";

/* Looks for the machine the owner named, on the live camera.

   After the owner says what is wrong ("my AC is not cooling"), each
   settled view goes to /api/detect: Muse Spark finds the item they mean
   and judges the framing, SAM 3.1 outlines it, the safety rules check
   the machine. The outline is drawn over the live stream; the page
   decides what to do with each result (take the picture, ask the owner
   to move, warn). Inactive (no calls) whenever `want` is null.

   A call goes out when the view has settled and either changed or sat
   unchanged for a while, never faster than MIN_GAP_MS. */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { drawStill } from "../lib/still";
import { mark } from "../lib/timeline";
import { ORANGE } from "../lib/masks";
import Busy from "./Busy";
import type { SamInstance } from "../lib/masks";

export interface ScanWarning {
  rule: string;
  title: string;
  spoken: string;
  trade: string;
}

export interface SeekResult {
  item: string;
  name: string;
  instance: SamInstance | null;
  framing: string;
  ready: boolean;
  hint: string;
  warning: ScanWarning | null;
  frame: File;
}

// Scene signature: 32x24 grey thumbnail, compared by mean absolute
// difference (0-255). Hand shake measures under ~8; turning to another
// object is well over 20.
const SIG_W = 32;
const SIG_H = 24;
const SETTLED = 8; // frame-to-frame change below this = holding still
const SETTLE_MS = 500; // ...for this long before asking
const MOVED = 22; // the outline's scene is gone: clear it
const RESEEK = 12; // enough change (closer, further) to ask again
const REASK_MS = 6000; // or the same view, asked again after this
const SAMPLE_MS = 250;
const MIN_GAP_MS = 2000; // between detect calls
const MAX_CALLS = 30; // per search; the page offers "use this view"

function signature(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): Uint8Array {
  ctx.drawImage(video, 0, 0, SIG_W, SIG_H);
  const px = ctx.getImageData(0, 0, SIG_W, SIG_H).data;
  const out = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    out[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  }
  return out;
}

function distance(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export default function LiveDetect({
  videoRef,
  want,
  apiBase,
  onResult,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  // What the owner said; null = not searching (no calls, nothing drawn).
  want: string | null;
  apiBase: () => string;
  onResult: (r: SeekResult) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<SeekResult | null>(null);
  const [item, setItem] = useState<string>("");
  // A check is on its way to the models (drives the scan line + timer).
  const [checking, setChecking] = useState<boolean>(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const apiRef = useRef(apiBase);
  apiRef.current = apiBase;

  useEffect(() => {
    setShown(null);
    setItem("");
    setChecking(false);
    if (!want) return;
    const sig = document.createElement("canvas");
    sig.width = SIG_W;
    sig.height = SIG_H;
    const sctx = sig.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    let alive = true;
    let prev: Uint8Array | null = null;
    let stillSince = performance.now();
    let shownSig: Uint8Array | null = null; // scene of the drawn outline
    let askedSig: Uint8Array | null = null; // last scene asked about
    let inFlight = false;
    let lastCall = 0;
    let calls = 0;

    const ask = async (now: Uint8Array) => {
      const video = videoRef.current;
      if (!video?.videoWidth) return;
      inFlight = true;
      setChecking(true);
      lastCall = performance.now();
      calls++;
      askedSig = now;
      try {
        const frame = await drawStill(video, video.videoWidth, video.videoHeight, "live.jpg");
        if (!frame) return;
        const fd = new FormData();
        fd.append("file", frame, "frame.jpg");
        fd.append("want", want);
        if (calls === 1) fd.append("start", "1");
        const t0 = performance.now();
        const r = await fetch(`${apiRef.current()}/api/detect`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(20000),
        });
        const d = await r.json();
        mark(
          "seek",
          `${d.status} item="${d.item || ""}" name="${d.name || ""}" ${d.framing || ""}${d.instance ? ` outlined ${Math.round((d.instance.score || 0) * 100)}%` : ""}${d.warning ? ` WARN ${d.warning.rule}` : ""} in ${((performance.now() - t0) / 1000).toFixed(1)}s`
        );
        if (!alive) return;
        if (d.status !== "ok") {
          // Rate limit or model error: tell the page once, stop asking.
          if (d.status === "rate-limited") calls = MAX_CALLS;
          return;
        }
        const res: SeekResult = {
          item: String(d.item || ""),
          name: String(d.name || ""),
          instance: d.instance || null,
          framing: String(d.framing || "not_visible"),
          ready: !!d.ready,
          hint: String(d.hint || ""),
          warning: d.warning || null,
          frame,
        };
        setItem(res.item);
        // Draw only if the view is still the one that was sent.
        const v = videoRef.current;
        if (v?.videoWidth && distance(signature(v, sctx), now) <= MOVED) {
          shownSig = res.name ? now : null;
          setShown(res.name ? res : null);
        }
        onResultRef.current(res);
      } catch (_) {
        // Network or timeout: the next settled view tries again.
      } finally {
        inFlight = false;
        if (alive) setChecking(false);
      }
    };

    const tick = () => {
      if (!alive) return;
      const video = videoRef.current;
      if (!video?.videoWidth || document.hidden) return;
      const now = signature(video, sctx);
      const t = performance.now();
      const motion = prev ? distance(now, prev) : 0;
      prev = now;
      if (motion > SETTLED) stillSince = t;
      if (shownSig && distance(now, shownSig) > MOVED) {
        shownSig = null;
        setShown(null);
      }
      if (inFlight || calls >= MAX_CALLS || t - lastCall < MIN_GAP_MS) return;
      const first = calls === 0;
      const settled = t - stillSince >= SETTLE_MS;
      const changed = !askedSig || distance(now, askedSig) > RESEEK;
      if (first || (settled && (changed || t - lastCall >= REASK_MS))) void ask(now);
    };
    const id = window.setInterval(tick, SAMPLE_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [want, videoRef]);

  // Paint the outline over the live video (object-fit: cover mapping).
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    let cancelled = false;
    let maskTint: HTMLCanvasElement | null = null;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const inst = shown?.instance;
      if (!inst || !video.videoWidth) return;
      const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
      const dw = video.videoWidth * scale;
      const dh = video.videoHeight * scale;
      const ox = (cw - dw) / 2;
      const oy = (ch - dh) / 2;
      const x = ox + inst.box.x * dw;
      const y = oy + inst.box.y * dh;
      const w = inst.box.w * dw;
      const h = inst.box.h * dh;
      if (maskTint) ctx.drawImage(maskTint, x, y, w, h);
      // Corner brackets, kept inside the visible frame.
      const bx = Math.max(4, x);
      const by = Math.max(4, y);
      const bw = Math.min(cw - 4, x + w) - bx;
      const bh = Math.min(ch - 4, y + h) - by;
      const k = Math.max(10, Math.min(bw, bh) * 0.18);
      ctx.strokeStyle = shown?.ready ? ORANGE : "#e8dfc4";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const [px, py, dx, dy] of [
        [bx, by, 1, 1],
        [bx + bw, by, -1, 1],
        [bx, by + bh, 1, -1],
        [bx + bw, by + bh, -1, -1],
      ]) {
        ctx.moveTo(px + dx * k, py);
        ctx.lineTo(px, py);
        ctx.lineTo(px, py + dy * k);
      }
      ctx.stroke();
    };

    (async () => {
      const inst = shown?.instance;
      if (inst) {
        try {
          const m = await loadImage(`data:image/png;base64,${inst.mask_png_b64}`);
          const off = document.createElement("canvas");
          off.width = inst.mask_w;
          off.height = inst.mask_h;
          const o = off.getContext("2d");
          if (o) {
            o.drawImage(m, 0, 0);
            o.globalCompositeOperation = "source-in";
            o.fillStyle = ORANGE + "66";
            o.fillRect(0, 0, off.width, off.height);
            maskTint = off;
          }
        } catch (_) {
          maskTint = null; // brackets alone
        }
      }
      if (!cancelled) draw();
    })();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    video.addEventListener("loadedmetadata", draw);
    return () => {
      cancelled = true;
      ro.disconnect();
      video.removeEventListener("loadedmetadata", draw);
    };
  }, [shown, videoRef]);

  if (!want) return null;
  const what = item ? `the ${item}` : "it";
  return (
    <>
      <canvas ref={canvasRef} className="live-detect" aria-hidden="true" />
      {checking && <div className="scan-sweep" aria-hidden="true" />}
      {checking ? (
        <div className="live-busy">
          <Busy
            compact
            label={shown ? `Checking the view of ${what}…` : `Looking for ${what}…`}
            hint="Muse Spark looks, SAM 3.1 outlines. Hold the phone steady."
            slowAfter={9}
            slowHint="Still checking. The model is slow right now; keep holding steady."
          />
        </div>
      ) : shown ? (
        <p className="live-tag" role="status">
          <span className="live-tag-dot" aria-hidden="true" />
          {shown.name}
          <span className="live-tag-src">
            {shown.instance
              ? `Spark · SAM 3.1 ${Math.round((shown.instance.score || 0) * 100)}%`
              : "Spark"}
          </span>
        </p>
      ) : (
        <p className="live-tag live-tag-scan" role="status">
          <span className="live-tag-dot" aria-hidden="true" />
          {item ? `Hold steady on the ${item}` : "Hold the phone steady"}
        </p>
      )}
    </>
  );
}
