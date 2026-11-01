/* Stills sent to the models: longest side 768px, JPEG q0.7 (~50KB),
   so uploads over the tunnel stay small. The backend normalises again. */

export const STILL_MAX_SIDE = 768;
export const STILL_QUALITY = 0.7;

export function drawStill(
  source: CanvasImageSource,
  width: number,
  height: number,
  name = "still.jpg",
  canvas: HTMLCanvasElement = document.createElement("canvas")
): Promise<File | null> {
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, STILL_MAX_SIDE / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob(
      (b) => resolve(b ? new File([b], name, { type: "image/jpeg" }) : null),
      "image/jpeg",
      STILL_QUALITY
    )
  );
}

/* A photo picked from the library, downscaled the same way. */
export async function shrinkPhoto(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const out = await drawStill(bmp, bmp.width, bmp.height, "upload.jpg");
    bmp.close();
    return out || file;
  } catch (_) {
    return file;
  }
}

/* Mean brightness 0-255 of a still (64px sample). The real demo photos
   measure 94-149, a dim inverter cupboard included; a dark room is < 30. */
export const TOO_DARK = 30;

export async function meanLuma(file: Blob): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = Math.max(1, Math.round((64 * bmp.height) / bmp.width));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    return sum / (px.length / 4);
  } catch (_) {
    return null;
  }
}
