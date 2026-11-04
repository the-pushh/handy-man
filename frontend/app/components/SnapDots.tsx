"use client";

/* The snapshot moment: the frozen frame with the machine SAM found
   highlighted as a net of dots that light up in a wave from top to
   bottom and fade out behind it, over a faint tint of its shape. Only
   points inside SAM's mask get a dot, so the net takes the machine's
   own outline. Without a mask (SAM found nothing) the frame shows plain.
   Reduced motion: the dots are drawn once, without the wave. */

import { useEffect, useRef } from "react";
import type { SamInstance } from "../lib/masks";

const ORANGE = "#ff6a1a";
const GAP = 9; // px between dots on screen
const WAVE_MS = 900; // the band crosses the machine top to bottom
const LIFE_MS = 420; // each dot fades in and out over this

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

export default function SnapDots({ url, inst }: { url: string; inst: SamInstance | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !inst) return;
    let raf = 0;
    let alive = true;
    (async () => {
      let frame: HTMLImageElement, mask: HTMLImageElement;
      try {
        [frame, mask] = await Promise.all([loadImage(url), loadImage(`data:image/png;base64,${inst.mask_png_b64}`)]);
      } catch {
        return;
      }
      if (!alive) return;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Same object-fit: cover mapping as the frozen frame under it.
      const scale = Math.max(cw / frame.naturalWidth, ch / frame.naturalHeight);
      const dw = frame.naturalWidth * scale;
      const dh = frame.naturalHeight * scale;
      const ox = (cw - dw) / 2;
      const oy = (ch - dh) / 2;
      const bx = ox + inst.box.x * dw;
      const by = oy + inst.box.y * dh;
      const bw = inst.box.w * dw;
      const bh = inst.box.h * dh;
      // Read the mask once at screen resolution: which grid points are
      // on the machine.
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(bw));
      off.height = Math.max(1, Math.round(bh));
      const o = off.getContext("2d", { willReadFrequently: true });
      if (!o) return;
      o.drawImage(mask, 0, 0, off.width, off.height);
      const px = o.getImageData(0, 0, off.width, off.height).data;
      const dots: { x: number; y: number; t0: number }[] = [];
      for (let y = Math.max(0, -by) + GAP / 2; y < bh; y += GAP) {
        for (let x = GAP / 2; x < bw; x += GAP) {
          const i = (Math.floor(y) * off.width + Math.floor(x)) * 4;
          // White (or opaque) mask pixel = on the machine.
          if ((px[i + 3] ?? 0) > 100 && (px[i] ?? 0) > 100) {
            const sy = by + y;
            if (sy < 0 || sy > ch) continue;
            dots.push({ x: bx + x, y: sy, t0: (y / bh) * WAVE_MS });
          }
        }
      }
      // A faint tint of the shape under the dots.
      const tint = document.createElement("canvas");
      tint.width = off.width;
      tint.height = off.height;
      const t = tint.getContext("2d");
      if (t) {
        t.drawImage(mask, 0, 0, off.width, off.height);
        t.globalCompositeOperation = "source-in";
        t.fillStyle = ORANGE + "33";
        t.fillRect(0, 0, tint.width, tint.height);
      }
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const start = performance.now();
      const frameDraw = (now: number) => {
        if (!alive) return;
        const el = now - start;
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(tint, bx, by, bw, bh);
        for (const d of dots) {
          let a: number;
          if (still) a = 0.9;
          else {
            const k = (el - d.t0) / LIFE_MS; // 0..1 across a dot's life
            if (k <= 0 || k >= 1) continue;
            a = Math.sin(Math.PI * k); // fade in, then out
          }
          ctx.fillStyle = `rgba(255, 106, 26, ${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1.6 + 1.2 * a, 0, Math.PI * 2);
          ctx.fill();
        }
        if (!still && el < WAVE_MS + LIFE_MS) raf = requestAnimationFrame(frameDraw);
      };
      raf = requestAnimationFrame(frameDraw);
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [url, inst]);

  return (
    <div className="shutter" aria-hidden="true">
      <div className="snap-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="snap-img" />
        <canvas ref={canvasRef} className="snap-dots" />
      </div>
    </div>
  );
}
