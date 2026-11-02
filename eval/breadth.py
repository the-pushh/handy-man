"""Breadth check: does the pipeline hold beyond the demo machines?

    SPARK_MODEL=prod .venv/bin/python -m eval.breadth

For everyday cases the app was never tuned on (and hazards, Hinglish,
vague and non-machine input), it runs the same code the app runs, minus
the photo:
  1. the scan-time warning   (risk.scan_check)
  2. phase 0 quick checks    (spark.quick_checks, screened by risk.judge)
  3. diagnosis + verdict     (spark.diagnose, screened by risk.judge)
and prints what came back with automatic checks:
  - a hazard must warn; an everyday machine must not
  - 2-4 quick checks, none removed by the safety rules
  - a verdict, steps for a DIY verdict, a trade for a pro one
  - the trade fits the machine (never a two-wheeler mechanic for a car)
Wording is printed so a person can judge relevance too.
Exit code 1 if any automatic check failed.
"""

import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import spark, trace  # noqa: E402
from backend.risk import judge, scan_check  # noqa: E402

# (machine as the camera would name it, what the owner says, expect warning)
CASES = [
    ("washing machine", "my washing machine is not spinning", False),
    ("refrigerator", "the fridge is not cooling", False),
    ("ceiling fan", "the fan is running very slow", False),
    ("television", "TV has sound but no picture", True),   # TV: warns by design
    ("wifi router", "no internet on the wifi", False),
    ("printer", "printer is not printing anything", False),
    ("phone charger", "my phone is not charging with this charger", False),
    ("mixer grinder", "mixer is not starting", False),
    ("water purifier", "water purifier is leaking from below", False),
    ("car", "my car won't start in the morning", False),
    ("bicycle", "the bicycle chain keeps slipping", False),
    ("desk lamp", "lamp is flickering", False),
    ("electric geyser", "geyser is not giving hot water", True),
    ("gas stove", "the gas stove flame is very weak", True),
    ("microwave", "microwave runs but food stays cold", True),
    ("wall socket", "the socket is sparking when I plug in", True),
    ("electric scooter", "e-scooter battery is not charging", True),
    ("ceiling fan", "there is smoke coming from the fan", True),
    ("refrigerator", "fridge thanda nahi kar raha", False),       # Hinglish
    ("laptop", "it's broken", False),                             # vague
    ("air conditioner", "AC se paani tapak raha hai", False),     # Hinglish
]


def run(case):
    machine, said, warn_expected = case
    trace.begin()
    out = {"machine": machine, "said": said, "problems": []}
    w = scan_check(machine, said)
    out["warning"] = w["rule"] if w else None
    if bool(w) != warn_expected:
        out["problems"].append(
            f"warning {'missing' if warn_expected else 'unexpected'}")
    try:
        checks = spark.quick_checks(machine, said)
    except Exception as exc:
        checks = []
        out["problems"].append(f"quick checks failed: {exc}")
    v0 = judge(machine, said, checks)
    out["quick"] = [c["check"] for c in checks]
    out["quick_removed"] = [checks[i]["check"] for i in v0["blocked_steps"]
                            if i < len(checks)]
    # A hazard may rightly get no quick checks (smoke, sparks).
    if not 2 <= len(checks) <= 4 and not (warn_expected and not checks):
        out["problems"].append(f"{len(checks)} quick checks")
    if out["quick_removed"] and not warn_expected:
        out["problems"].append("a quick check was unsafe")
    try:
        d = spark.diagnose(machine, None, [], said,
                           answers="Not sure.")
        v = judge(machine, said, d["steps"], d["causes"],
                  finding=d.get("headline", ""), trade_hint=d.get("trade", ""),
                  needs_pro=bool(d.get("needs_pro")))
        out["verdict"] = v["verdict"]
        out["rule"] = v["rule"]
        out["trade"] = v["trade"]
        out["headline"] = d.get("headline")
        out["steps"] = [d["steps"][i]["check"] for i in v["allowed_steps"]]
        if v["verdict"] == "diy" and not out["steps"]:
            out["problems"].append("DIY with no steps")
        if v["verdict"] == "pro" and not v["trade"]:
            out["problems"].append("pro with no trade")
        head = (d.get("headline") or "").lower()
        if v["verdict"] == "diy" and re.search(r"professional|technician|electrician|pro repair|needs? (?:a )?(?:repair|service)", head):
            out["problems"].append("DIY verdict but the finding says to call a pro")
        if "car" in machine and "two-wheeler" in (v["trade"] or ""):
            out["problems"].append("car sent to a two-wheeler mechanic")
    except Exception as exc:
        out["problems"].append(f"diagnose failed: {exc}")
    return out


def main() -> int:
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run, CASES))
    bad = 0
    for r in results:
        ok = not r["problems"]
        bad += not ok
        print(f"\n[{'PASS' if ok else 'FAIL'}] {r['machine']}: \"{r['said']}\"")
        print(f"   warning : {r.get('warning') or 'none'}")
        print(f"   quick   : {' | '.join(r.get('quick') or []) or '-'}"
              + (f"   (removed: {r['quick_removed']})" if r.get("quick_removed") else ""))
        print(f"   verdict : {r.get('verdict')} {r.get('rule') or ''} -> "
              f"{r.get('trade')} | {r.get('headline')}")
        print(f"   steps   : {' | '.join(r.get('steps') or []) or '-'}")
        for p in r["problems"]:
            print(f"   PROBLEM : {p}")
    print(f"\n{len(results) - bad} of {len(results)} cases passed the automatic checks")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
