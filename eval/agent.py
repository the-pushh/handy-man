"""Agent loop eval: the diagnostic loop on the demo cases, live models.

    SPARK_MODEL=prod .venv/bin/python -m eval.agent [case ...]

A simulated owner answers each test from the case's ground truth (a
small Muse Spark call that only knows those facts), so nothing is
scripted per question:
  ask_user     the owner picks a chip, or says a short answer
  look_closer  the case photo comes back as the close photo
  listen       the case's recorded sound summary (or "no unusual sound")
  segment      SAM 3.1 on the case photo, the real result
Prints every round (hypotheses, the test, why, its latency) and checks:
  ac-not-cooling   stops confident in 1-2 rounds
  scooter          at least 3 rounds, then escalates (blocked or max)
  inverter         stops (confident or escalated) within 5 tests
  every round      under 8 s on the model call
Photos live in eval/cases/ (not committed); a missing photo is a SKIP.
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import agent, spark, trace  # noqa: E402
from backend.images import normalize_all  # noqa: E402

CASES = {
    "ac-not-cooling": {
        "photo": "ac_front_1.jpeg", "machine": "air conditioner",
        "said": "the AC is running but the air is not cold",
        "truth": "The split AC runs and the fan blows, but the air is only "
                 "slightly cool and the airflow feels weaker than it used to. The filter behind the front cover is thick "
                 "with grey dust; it has not been cleaned in 6 months. The "
                 "outdoor unit fan spins. The remote is set to Cool, 24 C. "
                 "No ice, no water leak, no strange noise, no error code.",
        "check": lambda r: r["stop"] == "confident" and 1 <= r["tests"] <= 2 and not r["fix_blocked"],
        "want": "confident after 1-2 tests",
    },
    "inverter-beeping": {
        "photo": "inverter_front_1.jpeg", "machine": "inverter",
        "said": "the inverter keeps beeping",
        "sound": "3 beeps every ~1000 ms at ~2000 Hz",
        "truth": "The home inverter beeps 3 times every second. Mains power "
                 "is on and its green mains light is steady; the red "
                 "battery light blinks. Backup time has dropped to about "
                 "an hour from four. The battery's water level floats show red, below "
                 "the line; it was last topped up over a year ago. No smell, "
                 "no swelling, the load is a few fans and lights.",
        "check": lambda r: r["stop"] in ("confident", "blocked", "max-rounds"),
        "want": "stops within 5 tests",
    },
    "scooter-self-start": {
        "photo": "scooter_1.jpeg", "machine": "scooter",
        "said": "my scooter's self start is not working",
        "truth": "A petrol scooter, 4 years old. Pressing the start button "
                 "while holding the brake gives only a faint click. The horn "
                 "sounds weak and the headlight dims when pressing start. "
                 "Kick start works and the engine runs fine. The battery is "
                 "the original, about 4 years old. It sat unused for two "
                 "weeks. Fuel is half full. The side stand is up.",
        "check": lambda r: r["tests"] >= 3 and (
            r["stop"] in ("blocked", "max-rounds") or r["fix_blocked"]),
        "want": "3+ tests, then escalates (a blocked test or a fix the rules block)",
    },
}


def owner_answer(truth: str, action: dict) -> str:
    """A stand-in owner who knows only the case facts."""
    url, key, model = spark._config()
    prompt = (f"You are the owner of a machine. Facts you know: {truth}\n"
              f"The repair app asks: {action.get('question')}\n"
              f"Answer chips: {json.dumps(action.get('options') or [])}\n"
              "Answer as the owner would, from the facts only. If a chip "
              "fits, reply with that chip exactly; otherwise a short "
              "answer (under 12 words), or \"Not sure\" if the facts do "
              'not say. Reply with only JSON: {"answer": "..."}')
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
               "max_tokens": 400, "reasoning_effort": "minimal",
               "response_format": {"type": "json_object"}}
    return str(spark._complete(url, key, payload, ["answer"],
                               purpose="eval owner").get("answer", "Not sure"))


def run_tool(case: dict, photo: bytes, action: dict) -> tuple:
    """(result text, image to attach or None)."""
    tool = action["tool"]
    if tool == "ask_user":
        return owner_answer(case["truth"], action), None
    if tool == "listen":
        return case.get("sound") or "No beeps; no unusual sound.", None
    if tool == "look_closer":
        # The real app sends the owner's close photo; here the stand-in
        # owner says what that photo would show, from the case facts.
        seen = owner_answer(case["truth"], {
            "question": f"Point the camera at the {action['part']} "
                        f"({action.get('how') or 'as it is'}). Describe in "
                        "one sentence what a close photo would show.",
            "options": []})
        return f"Close photo of the {action['part']}: {seen}", None
    if tool == "segment":
        from backend import sam31
        inst = sam31.segment(photo, [{"label": action["part"],
                                      "look": action.get("look", "")}])
        if not inst:
            return f"The {action['part']} was not found on the photo.", None
        best = max(inst, key=lambda i: i.get("score") or 0)
        b = best["box"]
        return (f"Outlined the {action['part']} (score {best['score']:.2f}) "
                f"at x {b['x']:.2f}, y {b['y']:.2f}, size {b['w']:.2f} by "
                f"{b['h']:.2f} of the photo."), None
    return "no result", None


def run_case(cid: str) -> dict | None:
    case = CASES[cid]
    path = ROOT / "eval" / "cases" / case["photo"]
    if not path.exists():
        print(f"\n[SKIP] {cid}: no photo {path.name}")
        return None
    photo = normalize_all([path.read_bytes()])[0]
    print(f"\n=== {cid}: \"{case['said']}\"")
    # As in the app: phase 0 quick checks come first, the owner says
    # "Still not working", and the loop starts with them as tried.
    trace.begin()
    checks = spark.quick_checks(case["machine"], case["said"])
    said = (f"{case['said']}. Quick checks already tried, still not working: "
            + "; ".join(c["check"] for c in checks) + ". Do not repeat them.")
    print(f"  phase 0: {'; '.join(c['check'] for c in checks)}")
    state = {"seen": "", "hypotheses": [], "history": []}
    image = photo
    slowest = 0.0
    while True:
        trace.begin()
        t0 = time.time()
        out = agent.step(case["machine"], said, image=image,
                         seen=state["seen"], hypotheses=state["hypotheses"],
                         history=state["history"])
        took = time.time() - t0
        slowest = max(slowest, took)
        state["seen"], state["hypotheses"] = out["seen"], out["hypotheses"]
        board = " | ".join(f"{h['cause']} {round(h['p'] * 100)}%"
                           for h in out["hypotheses"])
        print(f"  round {out['round']} ({took:.1f}s)  {board}")
        if out["stop"]:
            s = out["stop"]
            extra = (f"  blocked test: {out['blocked_action'].get('part') or out['blocked_action'].get('question')}"
                     f" -> {s.get('title')}" if s["reason"] == "blocked" else "")
            if s.get("fix_blocked"):
                extra += f"  fix needs a handyman: {s['fix_blocked']['title']}"
            print(f"  STOP {s['reason']}{extra}")
            break
        a = out["action"]
        detail = a.get("question") or a.get("part") or a.get("what") or ""
        result, image = run_tool(case, photo, a)
        print(f"    test {a['tool']}: {detail}\n      why: {a['why']}\n      result: {result}")
        state["history"].append({"action": a, "result": result})
    r = {"stop": out["stop"]["reason"], "tests": len(state["history"]),
         "slowest": slowest, "fix_blocked": out["stop"].get("fix_blocked")}
    ok = case["check"](r) and slowest < 8.0
    print(f"[{'PASS' if ok else 'FAIL'}] {cid}: {r['tests']} tests, stop "
          f"{r['stop']}, slowest round {slowest:.1f}s (want {case['want']}, "
          "every round under 8 s)")
    r["ok"] = ok
    return r


def main() -> int:
    ids = sys.argv[1:] or list(CASES)
    results = [r for r in (run_case(c) for c in ids) if r]
    bad = sum(not r["ok"] for r in results)
    print(f"\n{len(results) - bad} of {len(results)} cases passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
