"use client";

/* Live machine detection on the camera view.

   While the owner points the phone, every time the view settles on a
   new scene one frame goes to /api/detect: Muse Spark names the machine,
   SAM 3.1 outlines it. The outline is drawn over the live stream until
   the view moves away, then it clears and the next settled view is
   checked. The turn's photo is that same frame (see `liveRef`), so the
   "Is this your…?" card shows the outline at once.

   Calls happen only on a settled, changed view, never on a timer, so a
   phone held still costs one call. */

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { drawStill } from "../lib/still";
import { mark } from "../lib/timeline";
import { ORANGE } from "../lib/masks";
import type { SamInstance } from "../lib/masks";

export interface LiveDetection {
  name: string;
  instance: SamInstance | null;
  frame: File;
  at: number;
}

// Scene signature: 32x24 grey thumbnail, compared by mean absolute
// difference (0-255). Hand shake measures under ~8; turning to another
// object is well over 20.
const SIG_W = 32;
const SIG_H = 24;
const SETTLED = 8; // frame-to-frame change below this = holding still
const SETTLE_MS = 600; // ...for this long before asking
const MOVED = 22; // change vs the detected frame above this = new scene
const SAMPLE_MS = 250;
const MIN_GAP_MS = 2500; // between detect calls
const MAX_CALLS = 120; // per page load; the turn still works after

function signature(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D
): Uint8Array {
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
  active,
  apiBase,
  liveRef,
  onChange,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  // False during a turn, the confirm card, the walkthrough or History.
  active: boolean;
  apiBase: () => string;
  // Current detection for the page (null once the view moves away).
  liveRef: MutableRefObject<LiveDetection | null>;
  onChange: (d: LiveDetection | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [det, setDet] = useState<LiveDetection | null>(null);
  const [scanning, setScanning] = useState<boolean>(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const apiRef = useRef(apiBase);
  apiRef.current = apiBase;

  // Sampling + detect loop.
  useEffect(() => {
    if (!active) {
      setScanning(false);
      return;
    }
    // Back on the camera after a turn: whatever was outlined before may
    // be gone, so start from nothing.
    liveRef.current = null;
    setDet(null);
    onChangeRef.current(null);
    const sig = document.createElement("canvas");
    sig.width = SIG_W;
    sig.height = SIG_H;
    const sctx = sig.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    let alive = true;
    let prev: Uint8Array | null = null;
    let stillSince = 0;
    let detSig: Uint8Array | null = null; // scene of the current outline
    let checkedSig: Uint8Array | null = null; // last scene asked about
    let inFlight = false;
    let lastCall = 0;
    let calls = 0;

    const clear = () => {
      detSig = null;
      liveRef.current = null;
      setDet(null);
      onChangeRef.current(null);
    };

    const ask = async (now: Uint8Array) => {
      const video = videoRef.current;
      if (!video?.videoWidth) return;
      inFlight = true;
      lastCall = performance.now();
      calls++;
      checkedSig = now;
      setScanning(true);
      try {
        const frame = await drawStill(video, video.videoWidth, video.videoHeight, "live.jpg");
        if (!frame) return;
        const fd = new FormData();
        fd.append("file", frame, "frame.jpg");
        const t0 = performance.now();
        const r = await fetch(`${apiRef.current()}/api/detect`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(20000),
        });
        const d = await r.json();
        mark(
          "live detect",
          `${d.status} "${d.name || ""}" ${d.instance ? `outlined ${Math.round((d.instance.score || 0) * 100)}%` : "no outline"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`
        );
        if (!alive || d.status !== "ok") return;
        // Still the same view? Otherwise the answer is stale.
        const v = videoRef.current;
        if (!v?.videoWidth) return;
        const cur = signature(v, sctx);
        if (distance(cur, now) > MOVED) return;
        if (!d.name) {
          clear();
          return;
        }
        const next: LiveDetection = {
          name: String(d.name),
          instance: d.instance || null,
          frame,
          at: Date.now(),
        };
        detSig = now;
        liveRef.current = next;
        setDet(next);
        onChangeRef.current(next);
      } catch (_) {
        // Network or timeout: the next settled view tries again.
      } finally {
        inFlight = false;
        if (alive) setScanning(false);
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
      if (detSig && distance(now, detSig) > MOVED) clear();
      const settled = t - stillSince >= SETTLE_MS;
      const fresh = !checkedSig || distance(now, checkedSig) > MOVED;
      if (settled && fresh && !detSig && !inFlight && calls < MAX_CALLS && t - lastCall >= MIN_GAP_MS) {
        void ask(now);
      }
    };
    stillSince = performance.now();
    const id = window.setInterval(tick, SAMPLE_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [active, videoRef, liveRef]);

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
      const inst = det?.instance;
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
      // Corner brackets around the box.
      const k = Math.max(10, Math.min(w, h) * 0.18);
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [px, py, dx, dy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x, y + h, 1, -1],
        [x + w, y + h, -1, -1],
      ]) {
        ctx.moveTo(px + dx * k, py);
        ctx.lineTo(px, py);
        ctx.lineTo(px, py + dy * k);
      }
      ctx.stroke();
    };

    (async () => {
      const inst = det?.instance;
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
  }, [det, videoRef]);

  if (!active) return null;
  const box = det?.instance?.box;
  return (
    <>
      <canvas ref={canvasRef} className="live-detect" aria-hidden="true" />
      {det ? (
        <p className="live-tag" role="status">
          <span className="live-tag-dot" aria-hidden="true" />
          {det.name}
          <span className="live-tag-src">
            {box
              ? `Spark · SAM 3.1 ${Math.round((det.instance?.score || 0) * 100)}%`
              : "Spark"}
          </span>
        </p>
      ) : scanning ? (
        <p className="live-tag live-tag-scan" role="status">
          <span className="live-tag-dot" aria-hidden="true" />
          Scanning…
        </p>
      ) : null}
    </>
  );
}
