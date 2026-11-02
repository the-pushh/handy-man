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
