"""Run the demo cases through the real backend and print a pass/fail table.

    SPARK_MODEL=prod .venv/bin/python -m eval.run            # all cases
    SPARK_MODEL=prod .venv/bin/python -m eval.run ac-not-cooling

Each case makes the same requests the app makes, in-process against
backend/server.py with live Meta model calls (no canned answers):
  1. /api/detect   the camera search: item named, framing, scan warning
  2. /api/repair/analyze   diagnosis with the item the owner named
  3. the same again with answers to the model's questions (if it asked)
Cases and expectations: eval/specs.json. Photos: eval/cases/ (private,
not committed); a case whose photo is missing is SKIP. Full replies land
in eval/out/results.json. Exit code 1 if any check failed.
"""

import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = ROOT / "eval"
# The app's per-IP limits would stop a full run; this is a local tool.
os.environ["RATE_TURNS_PER_HOUR"] = "100000"
os.environ["RATE_REQUESTS_PER_HOUR"] = "100000"
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from backend import config, server  # noqa: E402

CLIENT = TestClient(server.app)


def _headers(case_id: str) -> dict:
    h = {"x-client-ip": f"eval-{case_id}"}
    if config.PROXY_SECRET:
        h["x-handyman-proxy"] = config.PROXY_SECRET
    return h


def _still(path: Path) -> bytes:
    """The app's still: longest side 768px, JPEG q70."""
    im = Image.open(path).convert("RGB")
    im.thumbnail((768, 768))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=70)
    return buf.getvalue()


def _post(path: str, case_id: str, image: bytes, data: dict) -> dict:
    r = CLIENT.post(path, headers=_headers(case_id),
                    files={"file": ("still.jpg", image, "image/jpeg")},
                    data=data)
    return r.json()


def run_case(case: dict) -> dict:
    photo = HERE / "cases" / case["photo"]
    out = {"id": case["id"], "checks": [], "seconds": 0.0}
    if not photo.exists():
        out["skip"] = f"no photo {case['photo']}"
        return out
    t0 = time.time()
    image = _still(photo)
    exp = case["expect"]
    det = _post("/api/detect", case["id"], image,
                {"want": case["said"], "start": "1"})
    out["detect"] = {k: det.get(k) for k in
                     ("status", "item", "name", "framing", "ready", "hint",
                      "warning")}

    def check(name, ok, expected, got):
        out["checks"].append({"check": name, "ok": bool(ok),
                              "expected": expected, "got": got})

    item = f"{det.get('item') or ''} {det.get('name') or ''}".lower()
    if "item_has" in exp:
        check("item", any(w in item.split() or w in item
                          for w in exp["item_has"]),
              " / ".join(exp["item_has"]), item.strip() or "-")
    if "ready" in exp:
        check("framing", det.get("ready") == exp["ready"],
              "ready" if exp["ready"] else "not ready",
              f"{det.get('framing')} ({'ready' if det.get('ready') else 'not ready'})")
    if "warning" in exp:
        got = (det.get("warning") or {}).get("rule")
        check("scan warning", got == exp["warning"], exp["warning"] or "none",
              got or "none")
    if case.get("detect_only"):
        out["seconds"] = round(time.time() - t0, 1)
        return out

    owner = det.get("item") or ""
    form = {"text": case["said"],
            "perception": json.dumps({"owner_says": owner}) if owner else "",
            "owner": owner, "sound": case.get("sound", "")}
    data = _post("/api/repair/analyze", case["id"], image, form)
    questions = data.get("questions") or []
    prefer = [w.lower() for w in case.get("prefer", [])]
    if data.get("status") == "ok" and questions:
        replies = []
        for q in questions:
            opts = q.get("options") or ["Not sure"]
            reply = next((o for w in prefer for o in opts
                          if w in o.lower().split() or w in o.lower()),
                         opts[0])
            replies.append(f"{q['ask']} {reply}.")
        out["answered"] = replies
        data = _post("/api/repair/analyze", case["id"], image,
                     {**form, "answers": " ".join(replies)})
    v = data.get("verdict") or {}
    out["verdict"] = {"status": data.get("status"), "verdict": v.get("verdict"),
                      "rule": v.get("rule"), "headline": v.get("headline"),
                      "steps": [s.get("check") for s in data.get("steps") or []],
                      "detail": data.get("detail")}
    check("analysis ran", data.get("status") == "ok", "ok",
          data.get("status") or "-")
    if "verdict" in exp:
        check("verdict", v.get("verdict") == exp["verdict"], exp["verdict"],
              v.get("verdict") or "-")
    if "rule" in exp:
        check("rule", v.get("rule") == exp["rule"], exp["rule"] or "none",
              v.get("rule") or "none")
    if "headline_has" in exp:
        head = (v.get("headline") or "").lower()
        check("finding", any(w in head for w in exp["headline_has"]),
              " / ".join(exp["headline_has"]), v.get("headline") or "-")
    if v.get("verdict") == "diy":
        check("has steps", len(data.get("steps") or []) > 0, "> 0",
              len(data.get("steps") or []))
    out["seconds"] = round(time.time() - t0, 1)
    return out


def main(argv: list) -> int:
    specs = json.loads((HERE / "specs.json").read_text())["cases"]
    if argv:
        specs = [c for c in specs if c["id"] in argv]
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run_case, specs))

    rows = [("case", "check", "expected", "got", "result")]
    passed = failed = skipped = 0
    for r in results:
        if r.get("skip"):
            rows.append((r["id"], "-", "-", r["skip"], "SKIP"))
            skipped += 1
            continue
        for c in r["checks"]:
            rows.append((r["id"], c["check"], str(c["expected"]),
                         str(c["got"])[:48], "PASS" if c["ok"] else "FAIL"))
        if all(c["ok"] for c in r["checks"]):
            passed += 1
        else:
            failed += 1
    widths = [max(len(row[i]) for row in rows) for i in range(5)]
    for n, row in enumerate(rows):
        print("  ".join(col.ljust(widths[i]) for i, col in enumerate(row)))
        if n == 0:
            print("  ".join("-" * w for w in widths))
    print(f"\ncases: {passed} passed, {failed} failed, {skipped} skipped "
          f"(model: {os.environ.get('SPARK_MODEL', 'from .env')})")
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / "results.json").write_text(json.dumps(results, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
