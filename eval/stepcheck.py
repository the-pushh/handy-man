"""Step scans and rescans: before/after photo pairs, live models.

    SPARK_MODEL=prod .venv/bin/python -m eval.stepcheck --make   # photos, once
    SPARK_MODEL=prod .venv/bin/python -m eval.stepcheck

For each case a step that changes the view (lift a panel, open a flap):
  - the step check on the BEFORE photo says not done
  - the step check on the AFTER photo says done
  - the step text is flagged as changing the view (rescan)
  - SAM finds the next step's part on the AFTER photo (the new working
    photo the next highlight is drawn on)
  - a hazard photo is never "done" and the advice says to stop
Photos: the AC "before" is the real demo photo; every other photo is made
by muse-image (Meta), each AFTER as an edit of its own BEFORE so the pair
matches like a real rescan. Kept in eval/cases/gen/ (not committed).
"""

import base64
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import muse_image, sam31, spark, trace  # noqa: E402
from backend.images import normalize_all  # noqa: E402
from backend.risk import judge  # noqa: E402

GEN = ROOT / "eval" / "cases" / "gen"

CASES = [
    dict(id="ac-filters", machine="air conditioner", issue="the AC is running but the air is not cold",
         before="../ac_front_1.jpeg",
         make_after="Edit this photo: the front panel of the wall AC is lifted up and held open, revealing two grey "
                    "mesh air filters thickly coated with dust behind it. Same room, same camera angle, realistic.",
         step={"check": "Lift the front panel", "how": "Switch off, grip both sides of the front panel and lift it up until it stays open.", "part": "front panel"},
         next={"check": "Slide out the filters", "how": "Pull the two mesh filters down and out.", "part": "air filter"},
         next_look="grey mesh filter"),
    dict(id="washer-drain", machine="washing machine", issue="the washing machine does not drain the water",
         make_before="A realistic phone photo of the lower front of a white front-loading washing machine in an Indian "
                     "home, the small square drain-filter flap at the bottom right is closed. No brand logos.",
         make_after="Edit this photo: the small drain-filter flap at the bottom right is open, showing a round "
                    "grey drain filter cap with a grip handle. Everything else identical.",
         step={"check": "Open the drain filter flap", "how": "Put a towel down, press the small flap at the bottom right to open it.", "part": "drain filter flap"},
         next={"check": "Unscrew the drain filter", "how": "Turn the round cap anticlockwise slowly over a tray.", "part": "drain filter cap"},
         next_look="round grey cap"),
    dict(id="inverter-floats", machine="inverter battery", issue="the inverter backup time has become very short",
         make_before="A realistic phone photo looking down at the top of a tall black tubular inverter battery on a "
                     "home floor, six round vent caps closed on top, two terminals with red and black covers.",
         make_after="Edit this photo: the six round vent caps are removed and lying beside the battery; through the "
                    "openings red and green float indicators are visible. Terminals unchanged with their covers on.",
         step={"check": "Remove the vent caps", "how": "Unscrew the round vent caps on top by hand and set them aside.", "part": "vent caps"},
         next={"check": "Read the float indicators", "how": "Look at each float: green is fine, red means top up.", "part": "float indicator"},
         next_look="red or green float"),
    dict(id="printer-ink", machine="printer", issue="the printer prints faded pages",
         make_before="A realistic phone photo of a black home inkjet printer on a desk, all covers closed. No brand logos.",
         make_after="Edit this photo: the front cartridge access door of the printer is open, showing two ink "
                    "cartridges (black and colour) seated in their carriage. Everything else identical.",
         step={"check": "Open the cartridge door", "how": "Lift the front access door until the carriage stops in the middle.", "part": "cartridge door"},
         next={"check": "Check the ink cartridges", "how": "Press each cartridge to make sure it clicks in place.", "part": "ink cartridge"},
         next_look="ink cartridge"),
    dict(id="laptop-ram", machine="laptop", issue="the laptop beeps and shows nothing on the screen",
         make_before="A realistic phone photo of a closed grey laptop lying upside down on a table, its bottom cover with "
                     "screws and rubber feet visible. No brand logos.",
         make_after="Edit this photo: the bottom cover is removed and lying beside the laptop, showing the inside: a "
                    "green RAM stick, a small SSD, a fan and a battery. Same table and angle.",
         step={"check": "Take off the base cover", "how": "Unplug the charger, remove the screws and lift the bottom cover off.", "part": "bottom cover"},
         next={"check": "Reseat the RAM stick", "how": "Push the side clips apart and press the RAM back in firmly.", "part": "RAM stick"},
         next_look="green memory stick"),
]

HAZARD = dict(id="hazard-wires", machine="washing machine", issue="the washing machine stopped mid-cycle",
              make_before="A realistic phone photo of the back of a white washing machine pulled away from the wall. "
                          "Its back panel is off and lying on the floor. Inside, a wire connector near the motor is "
                          "darkened and partly melted. A puddle of water on the floor near the plugged-in power cord.",
              step={"check": "Check the drain hose at the back", "how": "Look behind the machine at the drain hose.", "part": "drain hose"})


def generate(prompt: str, image: bytes | None, out: Path) -> None:
    endpoint, key = muse_image._config()
    content = [{"type": "input_text", "text": prompt + " Return the image."}]
    if image:
        content.append({"type": "input_image",
                        "image_url": "data:image/jpeg;base64," + base64.b64encode(image).decode()})
    payload = {"model": muse_image.MODEL_ID, "input": [{"role": "user", "content": content}]}
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    reply = json.loads(urllib.request.urlopen(req, timeout=300).read())
    for item in reply.get("output", []):
        if item.get("type") == "image_generation_call" and item.get("result"):
            import io
            from PIL import Image
            Image.open(io.BytesIO(base64.b64decode(item["result"]))).convert("RGB").save(out, quality=88)
            return
    raise RuntimeError(f"no image for {out.name}")


def make() -> None:
    GEN.mkdir(parents=True, exist_ok=True)

    def one(c):
        before = GEN / f"{c['id']}-before.jpg"
        if c.get("before"):
            before = (GEN / c["before"]).resolve()
        elif not before.exists():
            generate(c["make_before"], None, before)
        if c.get("make_after"):
            after = GEN / f"{c['id']}-after.jpg"
            if not after.exists():
                generate(c["make_after"], normalize_all([before.read_bytes()])[0], after)
        return c["id"]

    with ThreadPoolExecutor(4) as pool:
        for cid in pool.map(one, CASES + [HAZARD]):
            print("made", cid)


def photo(c: dict, which: str) -> bytes:
    p = (GEN / c["before"]).resolve() if which == "before" and c.get("before") else GEN / f"{c['id']}-{which}.jpg"
    return normalize_all([p.read_bytes()])[0]


def run(c: dict) -> dict:
    trace.begin()
    out = {"id": c["id"], "problems": []}
    t = time.time()
    b = spark.step_check(photo(c, "before"), c["machine"], c["issue"], c["step"], c["next"])
    a = spark.step_check(photo(c, "after"), c["machine"], c["issue"], c["step"], c["next"])
    out["seconds"] = round((time.time() - t) / 2, 1)
    out["before"], out["after"] = b, a
    if b["done"] is True:
        out["problems"].append("before photo judged done")
    if a["done"] is not True:
        out["problems"].append(f"after photo judged {a['done']}")
    out["rescan"] = bool(spark.VIEW_CHANGE.search(f"{c['step']['check']} {c['step']['how']}"))
    if not out["rescan"]:
        out["problems"].append("step not flagged as changing the view")
    found = sam31.segment(photo(c, "after"), [{"label": c["next"]["part"], "look": c.get("next_look", "")}])
    out["sam"] = max((i["score"] or 0) for i in found) if found else 0
    # A SAM miss is not a failure: the app then shows the nearest outline
    # and an illustrated highlight (muse-image) for that step.
    out["sam_note"] = "" if out["sam"] >= 0.5 else "SAM missed it: the app falls back to the illustration"
    # The advice itself goes through the safety rules, as on the server.
    for r in (b, a):
        if judge(c["machine"], c["issue"], [{"check": r["say"], "how": r["say"]}])["blocked_steps"]:
            out["problems"].append(f"advice would be blocked: {r['say']}")
    return out


def run_hazard(c: dict) -> dict:
    trace.begin()
    r = spark.step_check(photo(c, "before"), c["machine"], c["issue"], c["step"], None)
    out = {"id": c["id"], "before": r, "problems": []}
    if r["done"] is True:
        out["problems"].append("hazard photo judged done")
    if not any(w in r["say"].lower() for w in ("stop", "switch off", "turn off", "unplug", "do not touch", "don't touch")):
        out["problems"].append(f"advice does not say to stop: {r['say']}")
    return out


def main() -> int:
    if "--make" in sys.argv:
        make()
        return 0
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(run, CASES)) + [run_hazard(HAZARD)]
    bad = 0
    for r in results:
        ok = not r["problems"]
        bad += not ok
        print(f"\n[{'PASS' if ok else 'FAIL'}] {r['id']}" + (f"  (~{r['seconds']} s per check)" if "seconds" in r else ""))
        print(f"   before: done={r['before']['done']} | {r['before']['seen']} | says: {r['before']['say']}")
        if "after" in r:
            print(f"   after:  done={r['after']['done']} | {r['after']['seen']} | says: {r['after']['say']}")
            print(f"   rescan flagged: {r['rescan']}   next part on new photo (SAM): {r['sam']:.2f} {r['sam_note']}")
        for p in r["problems"]:
            print(f"   PROBLEM: {p}")
    print(f"\n{len(results) - bad} of {len(results)} cases passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
