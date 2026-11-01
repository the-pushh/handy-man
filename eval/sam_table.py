"""SAM 3.1 phrase table on real photos: phrase, match, confidence.

    .venv/bin/python -m eval.sam_table eval/cases/ac_front_1.jpeg "air conditioner" "vent"
    .venv/bin/python -m eval.sam_table --all        # every photo, phrases by file prefix

Each phrase goes to the live SAM 3.1 API as a noun phrase, on the same
768px q70 still the app sends. For a miss it tries, in order:
  1. shorter phrases (the last word, then the first word),
  2. a box prompt: Muse Spark is asked where the part is (pixel box),
     and SAM gets that box as an object prompt instead of a phrase.
Columns: phrase tried, matches over the app's 0.3 floor, top
confidence (including sub-floor records), latency. Overlays of every
match are written to eval/out/ for a visual check.
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend import images, sam31, spark  # noqa: E402

CASES = ROOT / "eval" / "cases"
OUT = ROOT / "eval" / "out"

# Phrases per device, picked by the photo's filename prefix.
PHRASES = {
    "ac_front": ["air conditioner", "front panel", "vent", "display"],
    "ac_panel": ["white mesh", "grey mesh", "dusty filter", "air filter",
                 "mesh filter", "filter", "front panel", "coil"],
    "ac_filter": ["white mesh", "grey mesh", "dusty filter", "air filter",
                  "mesh filter", "filter", "front panel", "coil"],
    "inverter_front": ["inverter", "display", "LED", "switch", "socket",
                       "power cable"],
    "inverter_back": ["inverter", "display", "LED", "switch", "socket",
                      "power cable"],
    "inverter_battery": ["battery", "float indicator", "vent cap",
                         "battery terminal"],
    "battery_top": ["battery", "float indicator", "vent cap",
                    "battery terminal"],
    "scooter": ["scooter", "kill switch", "brake lever", "side stand",
                "start button", "horn button", "side panel"],
    "laptop_internals": ["fan", "battery", "RAM stick", "SSD"],
}

_CONF = re.compile(r"c=([0-9.]+)")
USE_BOX = True


def phrases_for(path: Path) -> list:
    stem = path.stem.lower()
    best = max((k for k in PHRASES if stem.startswith(k)), key=len,
               default=None)
    return PHRASES.get(best, [])


def _sam(image: bytes, input_text: str) -> tuple:
    """(instances over the floor, top raw confidence, records, seconds)."""
    endpoint, key = sam31._config()
    payload = {
        "model": sam31.MODEL_ID,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": input_text},
            {"type": "input_image", "image_url": "data:image/jpeg;base64,"
             + base64.b64encode(image).decode()},
        ]}],
        "metadata": sam31.METADATA,
    }
    t = time.time()
    text = sam31._output_text(sam31._request(endpoint, key, payload))
    secs = time.time() - t
    confs = [float(c) for c in _CONF.findall(text)]
    kept = sam31.prefilter(text) if text.strip() else ""
    inst = sam31.parse_output(kept, input_text) if kept else []
    return inst, (max(confs) if confs else None), len(confs) // 2, secs


def _spark_box(image: bytes, phrase: str) -> dict | None:
    """Ask Muse Spark for the pixel box of `phrase`; None if not visible."""
    w, h = Image.open(io.BytesIO(image)).size
    url, key, model = spark._config()
    prompt = (
        f"The image is {w}x{h} pixels. Find the {phrase}. Reply with one "
        'JSON object only: {"visible": true, "x1": 0, "y1": 0, "x2": 0, '
        '"y2": 0} giving the tight pixel bounding box of the single most '
        'prominent one, or {"visible": false} if none is visible.')
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {
                "url": "data:image/jpeg;base64,"
                + base64.b64encode(image).decode()}}]}],
        "max_tokens": 2000, "reasoning_effort": "low",
        "response_format": {"type": "json_object"},
    }
    box = spark._complete(url, key, payload, ["visible"],
                          purpose=f"locate: {phrase}", image=image)
    if not box.get("visible"):
        return None
    try:
        x1, y1, x2, y2 = (int(box[k]) for k in ("x1", "y1", "x2", "y2"))
    except (KeyError, TypeError, ValueError):
        return None
    x1, x2 = sorted((max(0, min(w - 1, x1)), max(0, min(w - 1, x2))))
    y1, y2 = sorted((max(0, min(h - 1, y1)), max(0, min(h - 1, y2))))
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "w": w, "h": h}


def _box_prompt(b: dict) -> str:
    return (f"<0f>1<|box;x1={b['x1']};y1={b['y1']};x2={b['x2']};"
            f"y2={b['y2']};w={b['w']};h={b['h']}|>")


def _shorter(phrase: str) -> list:
    words = phrase.split()
    if len(words) < 2:
        return []
    return list(dict.fromkeys([words[-1], words[0]]))


def run_phrase(image: bytes, phrase: str) -> list:
    """Rows for one phrase: the phrase itself, then fallbacks on a miss."""
    rows = []
    inst, top, n, secs = _sam(image, phrase)
    rows.append({"phrase": phrase, "via": "phrase", "matches": len(inst),
                 "top_c": top, "records": n, "s": secs, "inst": inst})
    if inst:
        return rows
    for short in _shorter(phrase):
        inst, top, n, secs = _sam(image, short)
        rows.append({"phrase": short, "via": f"shorter ({phrase})",
                     "matches": len(inst), "top_c": top, "records": n,
                     "s": secs, "inst": inst})
        if inst:
            return rows
    if not USE_BOX:
        return rows
    t = time.time()
    box = _spark_box(image, phrase)
    spark_s = time.time() - t
    if box is None:
        rows.append({"phrase": phrase, "via": "box: Spark says not visible",
                     "matches": 0, "top_c": None, "records": 0,
                     "s": spark_s, "inst": []})
        return rows
    inst, top, n, secs = _sam(image, _box_prompt(box))
    rows.append({"phrase": phrase,
                 "via": f"box from Spark ({box['x1']},{box['y1']})-"
                        f"({box['x2']},{box['y2']})",
                 "matches": len(inst), "top_c": top, "records": n,
                 "s": spark_s + secs, "inst": inst, "box": box})
    return rows


def overlay(image: bytes, rows: list, dest: Path) -> None:
    inst = [i for r in rows for i in r["inst"][:1]]
    if not inst:
        return
    preview = sam31.mask_preview(image, inst, side=768)
    if preview:
        dest.write_bytes(base64.b64decode(preview.split(",", 1)[1]))


def table(path: Path, phrases: list) -> list:
    image = images.normalize(path.read_bytes())
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda p: run_phrase(image, p), phrases))
    OUT.mkdir(exist_ok=True)
    print(f"\n{path.name}  ({Image.open(io.BytesIO(image)).size[0]}x"
          f"{Image.open(io.BytesIO(image)).size[1]}, "
          f"model {spark.active_model()} for box fallback)")
    print(f"  {'phrase':<18} {'via':<38} {'match':>5} {'top c':>6} {'s':>5}")
    flat = []
    for phrase, rows in zip(phrases, results):
        for r in rows:
            c = f"{r['top_c']:.2f}" if r["top_c"] is not None else "-"
            print(f"  {r['phrase']:<18} {r['via'][:38]:<38} "
                  f"{r['matches']:>5} {c:>6} {r['s']:>5.1f}")
            flat.append({k: v for k, v in r.items() if k != "inst"}
                        | {"file": path.name, "asked": phrase,
                           "scores": [i["score"] for i in r["inst"]]})
        slug = re.sub(r"[^a-z0-9]+", "_", phrase.lower())
        overlay(image, rows, OUT / f"{path.stem}__{slug}.jpg")
    return flat


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("photo", nargs="?")
    ap.add_argument("phrases", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-box", action="store_true",
                    help="skip the Spark box-prompt fallback")
    a = ap.parse_args()
    global USE_BOX
    USE_BOX = not a.no_box
    if a.all:
        todo = [(p, phrases_for(p)) for p in sorted(CASES.glob("*.jp*g"))]
    else:
        p = Path(a.photo)
        todo = [(p, a.phrases or phrases_for(p))]
    out = []
    for path, phrases in todo:
        if phrases:
            out += table(path, phrases)
        else:
            print(f"\n{path.name}: no phrase list for this prefix, skipped")
    OUT.mkdir(exist_ok=True)
    (OUT / "sam_table.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    os.environ.setdefault("SPARK_MODEL", "prod")
    main()
