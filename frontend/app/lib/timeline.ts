/* Turn timeline: one console line per hop, relative to the turn start.
   Read in DevTools (filter "[hm]") or window.__hm for the raw list. */

type Mark = { t: number; hop: string; detail?: string };

const marks: Mark[] = [];
let t0 = 0;

export function turnStart(label: string): void {
  marks.length = 0;
  t0 = performance.now();
  mark(label);
}

export function mark(hop: string, detail?: string): void {
  if (!t0) t0 = performance.now();
  const t = (performance.now() - t0) / 1000;
  marks.push({ t, hop, detail });
  if (typeof window !== "undefined") {
    (window as unknown as { __hm?: Mark[] }).__hm = marks;
  }
  console.log(`[hm] +${t.toFixed(2)}s ${hop}${detail ? " " + detail : ""}`);
}

export function kb(n: number): string {
  return `${Math.round(n / 1024)}KB`;
}
