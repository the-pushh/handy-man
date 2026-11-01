/* SAM 3.1 instance masks composited onto a still (orange tint + edge),
   matching the monochrome-plus-orange evidence treatment. */

export interface SamInstance {
  label: string;
  score: number | null;
  source?: string;
  box: { x: number; y: number; w: number; h: number };
  mask_png_b64: string;
  mask_w: number;
  mask_h: number;
}

export const ORANGE = "#e86a17";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* Draw each mask, tinted, at its box on ctx (canvas sized to the still). */
export async function paintMasks(
  ctx: CanvasRenderingContext2D,
  list: SamInstance[],
  color: string = ORANGE
): Promise<void> {
  const { width: W, height: H } = ctx.canvas;
  for (const inst of list) {
    const m = await loadImage(`data:image/png;base64,${inst.mask_png_b64}`);
    const off = document.createElement("canvas");
    off.width = inst.mask_w;
    off.height = inst.mask_h;
    const o = off.getContext("2d");
    if (!o) continue;
    o.drawImage(m, 0, 0);
    o.globalCompositeOperation = "source-in";
    o.fillStyle = color + "99";
    o.fillRect(0, 0, off.width, off.height);
    const b = inst.box;
    ctx.drawImage(off, b.x * W, b.y * H, b.w * W, b.h * H);
  }
}

/* Still + masks -> JPEG data URL (for cards that show a single image). */
export async function composeMasks(
  stillURL: string,
  list: SamInstance[]
): Promise<string> {
  const base = await loadImage(stillURL);
  const c = document.createElement("canvas");
  c.width = base.naturalWidth;
  c.height = base.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) return stillURL;
  ctx.drawImage(base, 0, 0);
  await paintMasks(ctx, list);
  return c.toDataURL("image/jpeg", 0.85);
}
