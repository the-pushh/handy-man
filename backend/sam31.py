"""SAM 3.1 via Meta's hosted Model API: noun phrase in, masks out.

Same gateway as Muse Spark (MUSE_SPARK_API_URL + MUSE_SPARK_API_KEY),
model id "sam-3.1" on /responses. Wire format per Meta's SAM 3 protocol
(github.com/meta-models/meta-sam, protocol/sam3.md), verified
2026-11-01 against the live API:

  - input_text is ONLY a noun phrase ("air filter", "kill switch") or
    box/point object prompts, never instructions. A sentence is read as
    a concept that matches nothing, which is why earlier probes that
    sent long instructions always came back empty.
  - An empty output_text is a valid answer: zero matches.
  - Output is special-token text, one line per frame:
      <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=W;h=H;c=0.88|><|mask;x=0;y=0;data=H,W,!payload|>
    The mask covers its box. Decoded with meta-sam-parser (Meta's
    reference parser), never by hand.
  - Responses metadata: mask_encoding="one_bit" (13x smaller payload,
    same pixels) and include_confidence="true" (adds c=).

One phrase per request; several phrases run in parallel (~2s each).

Decoding is pure Python (~0.5s per large mask, and the parser decodes
to validate). It runs in a worker process so it never holds the API
server's GIL (it starved the event loop and delayed TTS by ~9s), and
records under the confidence floor are dropped from the token text
before anything is decoded.
"""

import base64
import io
import json
import os
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

from . import trace

MODEL_ID = "sam-3.1"
DEFAULT_PATH = "/responses"
METADATA = {"mask_encoding": "one_bit", "include_confidence": "true"}
MIN_CONFIDENCE = 0.3
MAX_PER_PHRASE = 3


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


def concept(label: str) -> str:
    """Reduce a part label to the short noun phrase SAM expects.

    "the air filter (behind front grille)" -> "air filter".
    """
    text = re.sub(r"\(.*?\)", " ", str(label or "")).lower()
    text = re.sub(r"[^a-z0-9 \-/]", " ", text)
    words = [w for w in text.split() if w not in ("the", "a", "an", "its")]
    return " ".join(words[:4])


def _request(endpoint: str, key: str, payload: dict,
             timeout: int = 60) -> dict:
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


def _output_text(reply: dict) -> str:
    return "".join(
        part.get("text") or ""
        for item in reply.get("output", []) if item.get("type") == "message"
        for part in item.get("content", [])
        if part.get("type") == "output_text")


_RECORD = re.compile(r"\d+<\|box;[^|]*\|><\|mask;[^|]*\|>")
_CONF = re.compile(r"<\|box;[^|]*?;c=([0-9.]+)")


def prefilter(text: str) -> str:
    """Keep only the best MAX_PER_PHRASE records above MIN_CONFIDENCE.

    Works on the token text (box tokens carry c=), so masks we would
    throw away are never decoded. Records without c are kept.
    """
    out = []
    for line in text.splitlines():
        head = re.match(r"<\d+f>", line)
        if not head:
            continue
        recs = _RECORD.findall(line)
        scored = []
        for r in recs:
            m = _CONF.search(r)
            c = float(m.group(1)) if m else 1.0
            if c >= MIN_CONFIDENCE:
                scored.append((c, r))
        scored.sort(key=lambda x: -x[0])
        if scored:
            out.append(head.group(0) + ",".join(
                r for _, r in scored[:MAX_PER_PHRASE]))
    return "\n".join(out)


_POOL = None


def _pool():
    """One worker process for decoding, created on first use."""
    global _POOL
    if _POOL is None:
        from concurrent.futures import ProcessPoolExecutor
        _POOL = ProcessPoolExecutor(max_workers=2)
    return _POOL


def _warm_job(_: int) -> None:
    import time
    time.sleep(0.2)  # hold the worker so the next job spawns another


def warm() -> None:
    """Start every decode worker ahead of the first request.

    One warm job only started one worker; the second spawned during the
    first real segment call and slowed everything else on the machine.
    """
    from meta_sam_parser import image_segmentation_format  # noqa: F401
    list(_pool().map(_warm_job, range(2)))


def parse_output(text: str, label: str) -> list:
    """Token text -> [{label, score, box (normalised), mask PNG}]."""
    from meta_sam_parser import (CompletedOutcome, decode_mask_to_raster,
                                 image_segmentation_format)

    parser = image_segmentation_format().create_parser()
    list(parser.push(text))
    result = parser.finish(CompletedOutcome()).result
    boxes = {r.object_id: r for r in result.records if r.kind == "box"}
    size = re.search(r";w=(\d+);h=(\d+)", text)
    if not size:
        return []
    fw, fh = int(size.group(1)), int(size.group(2))
    out = []
    for rec in result.records:
        if rec.kind != "mask":
            continue
        box = boxes.get(rec.object_id)
        score = (box.confidence if box and box.confidence is not None
                 else rec.confidence)
        if score is not None and score < MIN_CONFIDENCE:
            continue
        b = rec.bounds
        out.append({
            "label": label,
            "source": MODEL_ID,
            "score": round(float(score), 3) if score is not None else None,
            "box": {"x": b.left / fw, "y": b.top / fh,
                    "w": (b.right - b.left) / fw,
                    "h": (b.bottom - b.top) / fh},
            "mask_png_b64": _mask_png(decode_mask_to_raster(rec.mask),
                                      rec.mask.width, rec.mask.height),
            "mask_w": rec.mask.width,
            "mask_h": rec.mask.height,
        })
    out.sort(key=lambda i: -(i["score"] or 0))
    return out[:MAX_PER_PHRASE]


def _mask_png(raster: bytes, width: int, height: int) -> str:
    """Binary raster -> RGBA PNG, opaque where the mask is on.

    The frontend tints by alpha (source-in), so off pixels must be
    transparent, not black.
    """
    alpha = Image.frombytes("L", (width, height),
                            bytes(255 if v else 0 for v in raster))
    img = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    img.putalpha(alpha)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def mask_preview(image_bytes: bytes, instances: list,
                 side: int = 240) -> str | None:
    """Thumbnail of the still with SAM masks in orange, for the trace."""
    try:
        base = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = base.size
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        for inst in instances:
            m = Image.open(io.BytesIO(
                base64.b64decode(inst["mask_png_b64"]))).getchannel("A")
            b = inst["box"]
            x, y = int(b["x"] * w), int(b["y"] * h)
            bw, bh = max(1, int(b["w"] * w)), max(1, int(b["h"] * h))
            tint = Image.new("RGBA", (bw, bh), (232, 106, 23, 150))
            layer.paste(tint, (x, y), m.resize((bw, bh)))
        out = Image.alpha_composite(base.convert("RGBA"), layer)
        out.thumbnail((side, side))
        buf = io.BytesIO()
        out.convert("RGB").save(buf, format="JPEG", quality=70)
        return ("data:image/jpeg;base64,"
                + base64.b64encode(buf.getvalue()).decode())
    except Exception:
        return None


def _query(image_bytes: bytes, phrase: str, label: str) -> list:
    """One SAM request for `phrase`; instances carry the part `label`."""
    endpoint, key = _config()
    payload = {
        "model": MODEL_ID,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": phrase},
            {"type": "input_image", "image_url": "data:image/jpeg;base64,"
             + base64.b64encode(image_bytes).decode()},
        ]}],
        "metadata": METADATA,
    }
    purpose = (f"segment: {phrase}" if phrase == concept(label)
               else f"segment: {phrase} (for {label})")
    with trace.call(MODEL_ID, purpose, image_bytes) as rec:
        reply = _request(endpoint, key, payload)
        text = _output_text(reply)
        rec["raw_text"] = text[:600]
        rec["request_text"] = phrase
        kept = prefilter(text) if text.strip() else ""
        instances = (_pool().submit(parse_output, kept, label).result()
                     if kept else [])
        rec["parsed"] = {
            "matches": len(instances),
            "instances": [{"score": i["score"],
                           "box": {k: round(v, 3)
                                   for k, v in i["box"].items()}}
                          for i in instances]}
        if instances:
            rec["mask_thumb"] = mask_preview(image_bytes, instances)
    return instances


def segment_one(image_bytes: bytes, label: str,
                look: str | list | None = None) -> list:
    """One part -> its instances (possibly none).

    SAM 3.1 finds plain visual nouns ("black panel", "green light",
    "round vent") far more often than trade names ("display", "LED",
    "fan"): on the real inverter photos 0 of 6 trade names matched and
    the visual phrases did. So the part's `look` (from Spark's
    perception) goes first and the part name is the fallback. Never a
    single word cut from a longer phrase: "wall" from "wall switch"
    matched the wall. `look` may be a list of phrases to try in order.
    """
    looks = look if isinstance(look, list) else [look or ""]
    phrases = [p for p in dict.fromkeys(
        [concept(x) for x in looks] + [concept(label)]) if p]
    for phrase in phrases:
        instances = _query(image_bytes, phrase, label)
        if instances:
            return instances
    return []


def _part(item) -> tuple:
    """A label string or {"label", "look"} -> (label, look)."""
    if isinstance(item, dict):
        label = str(item.get("label") or "").strip()
        look = item.get("look")
        if isinstance(look, list):
            look = [str(x).strip() for x in look if str(x).strip()] or None
            return label or (look[0] if look else ""), look
        look = str(look or "").strip() or None
        return label or (look or ""), look
    return str(item or "").strip(), None


def segment(image_bytes: bytes, labels: list, max_parts: int = 4) -> list:
    """Segment up to `max_parts` parts in parallel; flat instance list.

    Each item is a part label, or {"label", "look"} where `look` is the
    plain visual phrase SAM is asked first.
    """
    seen, todo = set(), []
    for item in labels:
        label, look = _part(item)
        phrase = concept(label)
        if phrase and phrase not in seen:
            seen.add(phrase)
            todo.append((label, look))
    todo = todo[:max_parts]
    if not todo:
        return []
    with ThreadPoolExecutor(max_workers=len(todo)) as pool:
        futures = [trace.run_in(pool, segment_one, image_bytes, label, look)
                   for label, look in todo]
        out = []
        for fut in futures:
            try:
                out.extend(fut.result())
            except Exception:
                pass  # one failed phrase never sinks the others
        return out
