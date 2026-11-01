"""Model-input normalisation: every still becomes <=768px JPEG q70.

The browser already downscales before upload (less over the tunnel);
this is the server-side guarantee for photos from the library or any
client that does not.
"""

import io

from PIL import Image, ImageOps

MAX_SIDE = 768
QUALITY = 70


def normalize(data: bytes) -> bytes:
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        img = img.convert("RGB")
    except Exception:
        return data  # not an image we can read; let the model call fail
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=QUALITY)
    return buf.getvalue()


def normalize_all(images: list) -> list:
    return [normalize(b) for b in images]
