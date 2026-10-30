"""Staged repair analysis streamed as events (SAM 3.1 hook points inside).

One call, many outputs as they are gathered — the frontend speaks each
"thinking" line while its overlays land, so narration and SAM highlights
run simultaneously:

  lang -> heard -> capturing -> finding_device -> device(+box, crop) ->
  region -> logo(+box, crop) -> components(+boxes, crops) ->
  pinpoint(+cause, highlight) -> done(+steps)

Geometry fallback: until SAM 3.1 weights land, boxes are deterministic
proposals derived from the frame (whole-unit device box, top-center logo
candidate, three appliance zones). Every box carries a stable `id` plus a
localized `label`; the evidence crops are REAL splices of the uploaded
still (PIL), showing exactly which portion each inference came from.
"""

import base64
import io

from PIL import Image

from .lang import detect_language
from .voice_lines import cause_for, infer_device, line, steps_for


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def crop_b64(img: Image.Image, box: dict, max_side: int = 320) -> str:
    w, h = img.size
    x0 = int(_clamp(box["x"]) * w)
    y0 = int(_clamp(box["y"]) * h)
    x1 = int(_clamp(box["x"] + box["w"]) * w)
    y1 = int(_clamp(box["y"] + box["h"]) * h)
    region = img.crop((x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)))
    region.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    region.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


ZONE_GEOMETRY = {
    # TODO(SAM31): replace these proposals with segmented masks/boxes.
    "control": {"x": 0.08, "y": 0.08, "w": 0.84, "h": 0.20},
    "body": {"x": 0.08, "y": 0.30, "w": 0.84, "h": 0.40},
    "inlet": {"x": 0.08, "y": 0.72, "w": 0.84, "h": 0.20},
}

ZONE_NAMES = {
    "control": ("control panel", "कंट्रोल पैनल", "control panel"),
    "body": ("drum / body", "ड्रम / बॉडी", "drum / body"),
    "inlet": ("inlet / base", "इनलेट / निचला हिस्सा", "inlet / base"),
}

LOGO_GEOMETRY = {"x": 0.35, "y": 0.06, "w": 0.30, "h": 0.12}
LOGO_NAMES = ("brand logo (candidate)", "ब्रांड लोगो (संभावित)", "brand logo (candidate)")

# symptom family -> zone that usually hosts it
FAMILY_ZONE = {"leak": "inlet", "noise": "body", "power": "control", "fallback": "body"}


def _family(transcript: str) -> str:
    t = (transcript or "").lower()
    if ("leak" in t or "water" in t or "leakage" in t
            or "पानी" in t or "रिसाव" in t or "लीक" in t):
        return "leak"
    if any(w in t for w in ("noise", "loud", "vibrat", "shak", "आवाज़", "आवाज", "शोर")):
        return "noise"
    if "power" in t or "not turning on" in t or "dead" in t or "बिजली" in t:
        return "power"
    return "fallback"


def _box(id: str, label: str, geom: dict, confidence: float) -> dict:
    return {"id": id, "label": label, **geom, "confidence": confidence}


def analyze_events(still_bytes: bytes, transcript: str, override: str = ""):
    """Yield staged events, narrated in the transcript's own language.

    Authored en/hi/hinglish stream directly; every other narration language
    is built in English then translated string-by-string (cached on disk).
    `override` (MMS code or en/hi/hinglish) skips detection when valid.
    """
    from . import i18n as i18n_mod
    from .lang import mms_codes

    over = (override or "").strip()
    detected = detect_language(transcript)
    if over in ("en", "hi", "hinglish"):
        narration, code = over, over
    elif over in mms_codes():
        # Prefer authored templates where they exist (eng/hin).
        narration = {"eng": "en", "hin": "hi"}.get(over, over)
        code = over
    else:
        narration, code = detected["narration"], detected["code"]
    lang_info = {"narration": narration, "code": code,
                 "stt": detected["stt"], "src": detected.get("src", "")}
    stt = lang_info["stt"]
    src = lang_info.get("src", "")
    if narration in ("hi", "hinglish") or (
            narration == "en" and src in ("", "eng_Latn")):
        match = transcript
    else:
        # Symptom/device keywords only exist in English: match against a
        # reverse translation (translated narration AND English fallback).
        match = i18n_mod.to_english_from(transcript, src)
    if narration in ("en", "hi", "hinglish"):
        gen = _stages(still_bytes, transcript, narration, stt, match)
    else:
        gen = (_localize(ev, code, i18n_mod)
               for ev in _stages(still_bytes, transcript, "en", stt, match))
    for ev in gen:
        if ev.get("type") == "lang":
            ev = dict(ev)
            ev["lang"] = narration
            ev["detected"] = code
            ev["translated"] = narration not in ("en", "hi", "hinglish")
        yield ev


def _localize(ev: dict, code: str, i18n_mod) -> dict:
    tr = lambda s: i18n_mod.translate(s, code) if isinstance(s, str) and s else s  # noqa: E731
    ev = dict(ev)
    if "text" in ev:
        ev["text"] = tr(ev["text"])
    if "device" in ev:
        ev["device"] = tr(ev["device"])
    if "boxes" in ev:
        ev["boxes"] = [{**b, "label": tr(b.get("label", ""))} for b in ev["boxes"]]
    if "evidence" in ev:
        ev["evidence"] = [{**e, "label": tr(e.get("label", ""))} for e in ev["evidence"]]
    if "cause" in ev and isinstance(ev["cause"], dict):
        cause = dict(ev["cause"])
        cause["title"] = tr(cause.get("title", ""))
        cause["explanation"] = tr(cause.get("explanation", ""))
        ev["cause"] = cause
    if "steps" in ev:
        ev["steps"] = [{**s, "instruction": tr(s.get("instruction", ""))}
                       for s in ev["steps"]]
    return ev


def _stages(still_bytes: bytes, transcript: str, lang: str, stt: str,
            match: str | None = None):
    img = Image.open(io.BytesIO(still_bytes)).convert("RGB")
    match = transcript if match is None else match
    device = infer_device(match, lang)
    family = _family(match)

    yield {"type": "lang", "lang": lang, "stt_locale": stt}
    yield {"type": "thinking", "text": line("heard", lang)}
    yield {"type": "thinking", "text": line("capturing", lang)}
    yield {"type": "thinking", "text": line("finding_device", lang)}

    unit = _box("unit", device, {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}, 0.7)
    yield {"type": "device", "text": line("device_found", lang, device=device),
           "device": device, "boxes": [unit],
           "evidence": [{"id": "unit", "label": device,
                         "jpeg_b64": crop_b64(img, unit)}]}

    yield {"type": "thinking", "text": line("region", lang)}
    yield {"type": "thinking", "text": line("logo", lang)}

    logo = _box("logo", LOGO_NAMES[{"en": 0, "hi": 1, "hinglish": 2}[lang]],
                LOGO_GEOMETRY, 0.45)
    yield {"type": "logo", "text": line("logo_found", lang), "boxes": [logo],
           "evidence": [{"id": "logo", "label": logo["label"],
                         "jpeg_b64": crop_b64(img, logo)}]}

    yield {"type": "thinking", "text": line("components", lang)}
    lang_idx = {"en": 0, "hi": 1, "hinglish": 2}[lang]
    zones = [_box(zid, ZONE_NAMES[zid][lang_idx], ZONE_GEOMETRY[zid], 0.55)
             for zid in ("control", "body", "inlet")]
    yield {"type": "components", "boxes": zones,
           "evidence": [{"id": z["id"], "label": z["label"],
                         "jpeg_b64": crop_b64(img, z)} for z in zones]}

    yield {"type": "thinking", "text": line("pinpoint", lang)}
    highlight_id = FAMILY_ZONE[family]
    highlight_label = next(z["label"] for z in zones if z["id"] == highlight_id)
    cause = cause_for(match, lang, highlight_label)
    yield {"type": "pinpoint", "cause": cause, "highlight_id": highlight_id,
           "highlight_label": highlight_label}

    yield {"type": "thinking", "text": line("done", lang)}
    yield {"type": "done", "cause": cause, "highlight_id": highlight_id,
           "highlight_label": highlight_label,
           "steps": steps_for(lang, highlight_label)}
