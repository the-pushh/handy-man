"use client";

/* Live waveform while listening: the mic's time-domain signal, drawn
   every frame, so the user sees the beep being caught. */

import { useEffect, useRef } from "react";

export default function Waveform({ analyser, seconds }: { analyser: AnalyserNode; seconds: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    let raf = 0;
    const draw = () => {
      const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
      const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
      analyser.getByteTimeDomainData(buf);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "#ff6a1a";
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * w;
        const y = (buf[i] / 255) * h;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      const rest = Math.max(0, seconds - (performance.now() - t0) / 1000);
      if (left.current) left.current.textContent = `${rest.toFixed(1)}s`;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser, seconds]);

  return (
    <div className="waveform">
      <div className="waveform-head">
        <span className="status-chip listening">Listening</span>
        <span ref={left} className="waveform-left" />
      </div>
      <canvas ref={ref} />
      <p className="evidence-note">Stay quiet; let it beep or click.</p>
    </div>
  );
}
