"""SAM 3.1 via Meta's hosted model API (repair flow).

Same gateway as Muse Spark: MUSE_SPARK_API_URL + MUSE_SPARK_API_KEY,
model id "sam-3.1". No local weights, no gated download.

WIRE FORMAT (verified 2026-10-30 against the live gateway):
  - Path: POST {base}{MUSE_SAM_PATH} (default: /responses; the base URL
    already ends in /v1, so /v1/segment would double the prefix and 404).
  - The gateway itself says: "The model `sam-3.1` is not available on
    [chat/completions]. Use /v1/responses."
  - Request: OpenAI Responses shape {"model": "sam-3.1",
    "input": [{role, content: [{input_text, input_image}]}]}.
  - OPEN: what makes the model emit masks/boxes instead of empty text.
    If your Meta dashboard shows a sample sam-3.1 /responses request
    (tool type, modalities flag, or output schema), paste it in and only
    _request()/_extract_text() change.
"""

import base64
import io
import json
import os
import re
import urllib.request
import urllib.error

from PIL import Image

from . import trace

MODEL_ID = "sam-3.1"
DEFAULT_PATH = "/responses"


def _config() -> tuple:
    url = os.environ.get("MUSE_SPARK_API_URL", "").rstrip("/")
    key = os.environ.get("MUSE_SPARK_API_KEY", "")
    path = os.environ.get("MUSE_SAM_PATH") or DEFAULT_PATH
    if not url or not key:
        raise RuntimeError(
            "Model API is not configured: set MUSE_SPARK_API_URL and "
            "MUSE_SPARK_API_KEY in .env."
        )
    return url + path, key


def _request(endpoint: str, key: str, payload: dict,
             timeout: int = 180) -> dict:
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"SAM 3.1 API error {exc.code}: {body}") from exc
    except Exception as exc:
        raise RuntimeError(f"SAM 3.1 request failed: {exc}") from exc


def _extract_text(reply: dict) -> str:
    for item in reply.get("output", []):
        if item.get("type") == "message":
            for part in item.get("content", []):
                if part.get("type") == "output_text" and part.get("text"):
                    return part["text"]
    return ""


def segment(image_bytes: bytes, labels: list, threshold: float = 0.3) -> list:
    """Cut one mask per label via the hosted API. See module docstring."""
    endpoint, key = _config()
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": MODEL_ID,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text",
                 "text": (
                     "Segment each of these appliance parts in the image: "
                     + ", ".join(labels) + ". Respond with a single JSON "
                     'object {"instances": [{"label", "score", "box": '
                     '{"x","y","w","h"} normalized top-left origin, '
                     '"polygon": [[x,y],...] normalized}]} and nothing else.'
                 )},
                {"type": "input_image",
                 "image_url": f"data:image/jpeg;base64,{b64}"},
            ],
        }],
    }
    with trace.call(MODEL_ID, "segment: " + ", ".join(labels),
                    image_bytes) as rec:
        reply = _request(endpoint, key, payload)
        rec["usage"] = reply.get("usage")
        rec["raw_text"] = json.dumps(reply)[:2000]
    text = _extract_text(reply)
    if not text.strip():
        raise RuntimeError(
            "SAM 3.1 returned empty text on /responses — the dashboard's "
            "sample request (tool type / modalities / output schema) is "
            "needed to trigger mask output."
        )
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        try:
            parsed = json.loads(match.group(0)) if match else {}
        except (json.JSONDecodeError, AttributeError):
            parsed = {}
    instances = parsed.get("instances", []) if isinstance(parsed, dict) else []
    return [_parse(inst, labels) for inst in instances]


def _parse(inst: dict, labels: list) -> dict:
    label = str(inst.get("label", labels[0] if labels else "part"))
    box = inst.get("box") or {"x": 0, "y": 0, "w": 1, "h": 1}
    out = {
        "label": label,
        "score": float(inst.get("score", 1.0)),
        "box": {k: float(box.get(k, 0)) for k in ("x", "y", "w", "h")},
    }
    if inst.get("mask_png_b64"):
        out["mask_png_b64"] = inst["mask_png_b64"]
        out["mask_w"] = int(inst.get("mask_w", 96))
        out["mask_h"] = int(inst.get("mask_h", 96))
    elif inst.get("polygon"):
        out.update(_rasterize(inst["polygon"]))
    else:
        raise RuntimeError(
            f"SAM 3.1 reply for {label!r} has neither mask_png_b64 nor "
            "polygon — check the endpoint's response format."
        )
    return out


def _rasterize(polygon: list, size: int = 96) -> dict:
    """Fallback: burn a normalized polygon into a small mask bitmap."""
    from PIL import ImageDraw
    img = Image.new("L", (size, size), 0)
    pts = [(x * size, y * size) for x, y in polygon]
    ImageDraw.Draw(img).polygon(pts, fill=255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {"mask_png_b64": base64.b64encode(buf.getvalue()).decode(),
            "mask_w": size, "mask_h": size}
