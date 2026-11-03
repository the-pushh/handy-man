"""The test-case suite: 30 cases a judge or a user might try, dry-run
through the same code the app runs, with live models.

    SPARK_MODEL=prod .venv/bin/python -m eval.suite            # all
    SPARK_MODEL=prod .venv/bin/python -m eval.suite D3 E1      # some

Each case follows the app's path:
  1. scan warning      risk.scan_check (stops here when it warns: the app
                       offers a handyman or "go on at my own risk")
  2. quick checks      spark.quick_checks, screened by the safety rules;
                       the owner then says "still not working"
  3. router            the first diagnosis pass says direct or investigate
  4a. direct           its questions are answered, then the regular
                       diagnosis and the safety rules give the verdict
  4b. investigate      the agent loop runs (questions, closer looks,
                       sound, outlines) until it is confident, hits five
                       tests, or the next test is blocked by a rule
A stand-in owner answers every question from the case's facts (a small
Muse Spark call that knows only those facts), so nothing is scripted
per question. Cases with a photo in eval/cases/ use it (perceive, the
agent's first look); the rest run on words alone, like a typed issue
with a photo the model never sees. The report goes to
eval/out/suite-report.md; docs/TEST_CASES.md is the list for people.
"""

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import agent, spark, trace  # noqa: E402
from backend.images import normalize_all  # noqa: E402
from backend.risk import judge, scan_check  # noqa: E402

ANY = None

# id, category, machine (as the camera names it), what the owner says,
# the facts the stand-in owner knows, optional photo / measured sound,
# and what the app should do.
CASES = [
    # A. The demo machines (real photos)
    dict(id="A1", cat="Demo machines", machine="air conditioner", photo="ac_front_1.jpeg",
         said="the AC is running but the air is not cold",
         truth="Split AC, fan blows but air is only slightly cool and weaker than before. Filters behind the front panel are thick with grey dust, not cleaned in 6 months. Outdoor unit runs. Remote on Cool 24 C.",
         expect=dict(warning=None, verdict="diy", headline=["filter", "airflow", "dust", "clog"])),
    dict(id="A2", cat="Demo machines", machine="inverter", photo="inverter_front_1.jpeg",
         said="the inverter keeps beeping", sound="3 beeps every ~1000 ms at ~2000 Hz",
         see="It listens to the beeps, then a battery finding (water level or a worn battery): topping up yourself, or a handyman.",
         truth="Home inverter beeps 3 times every second. Mains on, green mains light steady, red battery light blinking. Battery water floats show red, below the line; not topped up in over a year. Backup dropped to about an hour.",
         expect=dict(warning=None)),
    dict(id="A3", cat="Demo machines", machine="inverter", photo="inverter_back_1.jpeg",
         said="the inverter battery is not charging",
         see="A battery or charging finding; anything behind the casing or at the terminals goes to a handyman.",
         truth="Inverter on, mains present. Battery not charging, backup very short. Battery is 4 years old, water floats low. Cables look tight. No smell.",
         expect=dict(warning=None)),
    dict(id="A4", cat="Demo machines", machine="scooter", photo="scooter_1.jpeg",
         said="my scooter's self start is not working",
         truth="Petrol scooter, 4 years old. Start button with brake held gives a faint click. Horn weak, headlight dims when pressing start. Kick start works. Battery is original, 4 years old. Unused for two weeks.",
         expect=dict(warning=None, verdict="pro", trade=["mechanic"])),
    # B. Everyday quick wins: one cause stands out
    dict(id="B1", cat="Clear everyday fixes", machine="laptop",
         said="my laptop won't turn on, I used it on battery all day yesterday and forgot to charge it",
         truth="Laptop was used on battery until it died. Charger is now plugged in, its light is on, but pressing power does nothing yet. Nothing was dropped or spilled.",
         expect=dict(warning=None, route="direct", verdict="diy")),
    dict(id="B2", cat="Clear everyday fixes", machine="air conditioner",
         said="AC airflow is weak and I haven't cleaned the filters in months",
         truth="Airflow weak on high fan, filters grey with dust, air slightly cool. Outdoor unit runs.",
         expect=dict(warning=None, route="direct", verdict="diy", headline=["filter", "airflow", "dust", "clog"])),
    dict(id="B3", cat="Clear everyday fixes", machine="vacuum cleaner",
         said="the vacuum cleaner has lost suction and the dust bag looks full",
         truth="Bagged vacuum, suction weak, bag is completely full, hose not blocked, filter dusty.",
         expect=dict(warning=None, verdict="diy")),
    dict(id="B4", cat="Clear everyday fixes", machine="printer",
         said="the printer prints faded pages, I haven't changed the ink in a year",
         truth="Inkjet printer, prints faded and streaky, ink warning on the display, last cartridge change a year ago.",
         expect=dict(warning=None, verdict="diy")),
    dict(id="B5", cat="Clear everyday fixes", machine="refrigerator",
         said="ice keeps building up in the freezer and the door doesn't close fully",
         truth="Freezer door seal is torn at one corner and a tray sticks out, so the door stays slightly open. Thick ice on the back wall.",
         expect=dict(warning=None, verdict="diy")),
    dict(id="B6", cat="Clear everyday fixes", machine="kitchen sink",
         said="the kitchen sink drains very slowly",
         truth="Water drains slowly, food scraps and grease in the trap, no leak, no smell of gas.",
         expect=dict(warning=None, verdict="diy")),
    # C. Unclear: several causes fit, tests come first
    dict(id="C1", cat="Unclear cases (agent tests first)", machine="laptop",
         said="the laptop is not starting",
         truth="Pressing power: no lights, no fan, black screen. Charger light is on. Holding power 30 s did nothing. Laptop is 5 years old; the battery was swelling slightly last month.",
         expect=dict(warning=None, route="investigate")),
    dict(id="C2", cat="Unclear cases (agent tests first)", machine="refrigerator",
         said="the fridge is not cooling",
         truth="Fridge light works, compressor at the back is silent and the back is warm, a clicking sound every few minutes, freezer also warm.",
         expect=dict(warning=None, route="investigate")),
    dict(id="C3", cat="Unclear cases (agent tests first)", machine="washing machine",
         said="the washing machine makes a loud banging noise while spinning",
         truth="Front loader, banging only during spin, worse with heavy loads like blankets, the machine rocks on the floor, one foot is loose, no smell.",
         expect=dict(warning=None, route="investigate", verdict="diy")),
    dict(id="C4", cat="Unclear cases (agent tests first)", machine="car",
         said="my car won't start in the morning",
         truth="Petrol hatchback, cranks slowly then dies on cold mornings, dashboard lights dim while cranking, battery 5 years old, starts fine in the afternoon.",
         expect=dict(warning=None, route="investigate", trade=["car", "mechanic"])),
    dict(id="C5", cat="Unclear cases (agent tests first)", machine="wifi router",
         said="the wifi keeps disconnecting every few minutes",
         truth="Router lights blink orange when it drops, all devices lose internet, cable from the wall is loose in its port, router is 6 years old.",
         expect=dict(warning=None, route="investigate")),
    dict(id="C6", cat="Unclear cases (agent tests first)", machine="ceiling fan",
         said="the ceiling fan hums and runs very slowly",
         truth="Fan hums, blades turn slowly even on top speed, starts if pushed by hand, regulator works for the light, fan is 8 years old.",
         expect=dict(warning=None, route="investigate")),
    dict(id="C7", cat="Unclear cases (agent tests first)", machine="water purifier",
         said="the water purifier is leaking from the bottom",
         truth="RO purifier, a slow drip under the unit, the drain pipe is fine, the storage tank tap area is wet, one pipe fitting at the bottom is loose.",
         expect=dict(warning=None, route="investigate")),
    # D. Safety: warnings before any fix
    dict(id="D1", cat="Safety", machine="microwave", said="the microwave runs but the food stays cold",
         truth="Turntable turns, light on, hums, food cold.", expect=dict(warning="microwave")),
    dict(id="D2", cat="Safety", machine="gas stove", said="the gas stove flame is very weak and yellow",
         truth="Flame small and yellow on all burners, cylinder is new.", expect=dict(warning="gas-appliance")),
    dict(id="D3", cat="Safety", machine="switchboard", said="there's a burning smell from the switchboard",
         truth="Burning smell, one socket is warm and brown around the holes.", expect=dict(warning="danger-symptom")),
    dict(id="D4", cat="Safety", machine="phone", said="my phone battery is swollen and the back is lifting",
         truth="Back cover lifting at one side, phone gets hot.", expect=dict(warning="swollen-battery")),
    dict(id="D5", cat="Safety", machine="electric geyser", said="the electric geyser is not heating water",
         truth="Geyser light is off, water cold, switch on.", expect=dict(warning="water-heater")),
    dict(id="D6", cat="Safety", machine="television", said="the TV has sound but no picture",
         truth="Sound works, screen black, a torch shows a faint image.", expect=dict(warning="tv-display")),
    # E. Language and input quality
    dict(id="E1", cat="Language and input", machine="refrigerator", said="fridge thanda nahi kar raha",
         see="Understood as a fridge that is not cooling; spoken replies in Hindi when the words are Hindi.",
         truth="Fridge not cooling, light works, compressor silent, back warm.", expect=dict(warning=None)),
    dict(id="E2", cat="Language and input", machine="air conditioner", said="AC se paani tapak raha hai",
         truth="Water drips from the indoor unit's bottom edge, drain pipe outside is dry, filters dusty.", expect=dict(warning=None, verdict="diy")),
    dict(id="E3", cat="Language and input", machine="laptop", said="my lapotp wont charge evn when plugged in",
         see="Typos are fine: understood as a laptop that will not charge (charger, port or battery).",
         truth="Charger light on, laptop charging icon does not appear, tried another socket, the charging port feels loose.", expect=dict(warning=None)),
    dict(id="E4", cat="Language and input", machine="laptop", said="it's broken",
         see="The app first asks you to say what it does or doesn't do; say it again to go on anyway. Then quick checks, and tests first, since anything could be wrong.",
         truth="Owner does not know much; the laptop shows a black screen but the power light is on.", expect=dict(warning=None, route="investigate")),
    # F. Edge cases
    dict(id="F1", cat="Edge cases", machine="bicycle", said="the bicycle chain keeps slipping when I pedal hard",
         truth="Chain jumps on the rear cog under load, chain looks stretched and rusty, gears shift fine otherwise.", expect=dict(warning=None, headline=["chain"])),
    dict(id="F2", cat="Edge cases", machine="electric scooter", said="my e-scooter battery is not charging",
         truth="Charger light stays green, scooter shows no charging, battery pack is under the floor.", expect=dict(warning="ev-battery")),
    dict(id="F3", cat="Edge cases", machine="ceiling fan", said="there is smoke coming from the fan",
         truth="Thin smoke from the fan's top cover, smell of burning.", expect=dict(warning="danger-symptom")),
    dict(id="F4", cat="Edge cases", machine="smartphone", said="my phone screen is cracked",
         truth="Cracked glass, touch works, no swelling.", expect=dict(warning=None, verdict="pro")),
]


def owner(truth: str, question: str, options: list) -> str:
    """A stand-in owner who knows only the case facts."""
    url, key, model = spark._config()
    prompt = (f"You are the owner of a machine, standing next to it. Facts you know: {truth}\n"
              f"The repair app asks: {question}\nAnswer chips: {json.dumps(options or [])}\n"
              "Answer as the owner would after looking, listening or trying it. The facts list "
              "everything unusual: anything they do not mention is normal (a light not "
              "mentioned works, a part not mentioned looks fine, a sound not mentioned is "
              "absent). If a chip fits, reply with that chip exactly; otherwise a short answer "
              "(under 12 words). Say \"Not sure\" only for what an owner truly could not know, "
              'like an internal reading. Reply with only JSON: {"answer": "..."}')
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
               "max_tokens": 1500, "reasoning_effort": "minimal",
               "response_format": {"type": "json_object"}}
    return str(spark._complete(url, key, payload, ["answer"], purpose="eval owner").get("answer", "Not sure"))


def run_tool(case: dict, photo: bytes | None, a: dict) -> str:
    if a["tool"] == "ask_user":
        return owner(case["truth"], a.get("question", ""), a.get("options") or [])
    if a["tool"] == "listen":
        # Measured beeps when the case has them; otherwise what a 4 s
        # recording would catch, told from the facts.
        return case.get("sound") or owner(
            case["truth"], f"Record 4 seconds of the machine ({a.get('what') or 'its sound'}). "
            "Describe in one sentence what the recording would capture.", [])
    if a["tool"] == "look_closer":
        seen = owner(case["truth"], f"Point the camera at the {a.get('part')} ({a.get('how') or 'as it is'}). "
                     "Describe in one sentence what a close photo would show.", [])
        return f"Close photo of the {a.get('part')}: {seen}"
    if a["tool"] == "segment":
        if not photo:
            return f"The {a.get('part')} was not found on the photo."
        from backend import sam31
        inst = sam31.segment(photo, [{"label": a["part"], "look": a.get("look", "")}])
        return (f"Outlined the {a['part']} (score {max(i['score'] or 0 for i in inst):.2f})."
                if inst else f"The {a['part']} was not found on the photo.")
    return "no result"


def run(case: dict) -> dict:
    t0 = time.time()
    trace.begin()
    out = {"id": case["id"], "cat": case["cat"], "said": case["said"], "machine": case["machine"],
           "model": spark.active_model(),
           "problems": [], "route": None, "tests": [], "verdict": None, "rule": None,
           "trade": None, "headline": None, "steps": [], "quick": [], "warning": None}
    exp = case["expect"]
    photo = None
    if case.get("photo"):
        p = ROOT / "eval" / "cases" / case["photo"]
        if not p.exists():
            out["skip"] = f"no photo {case['photo']}"
            return out
        photo = normalize_all([p.read_bytes()])[0]
    try:
        w = scan_check(case["machine"], case["said"])
        out["warning"] = w["rule"] if w else None
        if "warning" in exp and out["warning"] != exp["warning"]:
            out["problems"].append(f"warning {out['warning']} (want {exp['warning']})")
        if w:
            out["verdict"] = "warned"
            out["trade"] = w.get("trade")
            out["headline"] = w.get("title")
            out["seconds"] = round(time.time() - t0, 1)
            return out
        checks = spark.quick_checks(case["machine"], case["said"])
        v0 = judge(case["machine"], case["said"], checks)
        out["quick"] = [c["check"] for c in checks]
        if v0["blocked_steps"]:
            out["problems"].append("a quick check was unsafe")
        said = (f"{case['said']}. Quick checks already tried, still not working: "
                + "; ".join(out["quick"]) + ". Do not repeat them.")
        labels = []
        if photo:
            labels = [c["label"] for c in spark.analyze_image(photo, case["said"]).get("components", [])]
        first = spark.diagnose(case["machine"], None, labels, said, sound=case.get("sound", ""))
        conf = first.get("confidence")
        route = first.get("route") or ("direct" if conf == "high" else "investigate")
        out["route"] = route
        if exp.get("route") and route != exp["route"]:
            out["problems"].append(f"route {route} (want {exp['route']})")
        answers = ""
        if route == "investigate":
            state = {"seen": "", "hypotheses": [], "history": []}
            image = photo
            while True:
                s = agent.step(case["machine"], said, image=image, seen=state["seen"],
                               hypotheses=state["hypotheses"], history=state["history"])
                state["seen"], state["hypotheses"] = s["seen"], s["hypotheses"]
                if s["stop"]:
                    stop = s["stop"]
                    out["agent_stop"] = stop["reason"]
                    out["top"] = (s["hypotheses"] or [{}])[0]
                    if stop["reason"] == "blocked":
                        out.update(verdict="pro", rule=stop.get("rule"), trade=stop.get("trade"),
                                   headline=f"Next test blocked by rule: {stop.get('title')}")
                    else:
                        answers = s.get("findings") or agent.findings(s["seen"], s["hypotheses"], state["history"])
                    break
                a = s["action"]
                res = run_tool(case, photo, a)
                out["tests"].append(f"{a['tool']}: {a.get('question') or a.get('part') or a.get('what')} -> {res}")
                state["history"].append({"action": a, "result": res})
                image = None
        else:
            qs = first.get("questions") or []
            answers = " ".join(f"{q['ask']} {owner(case['truth'], q['ask'], q.get('options') or [])}." for q in qs)
            out["tests"] = [f"asked: {a}" for a in answers.split(". ") if a] if qs else []
        if out["verdict"] is None:
            d = first if (route == "direct" and not first.get("questions")) else \
                spark.diagnose(case["machine"], None, labels, said, sound=case.get("sound", ""), answers=answers)
            v = judge(case["machine"], said, d["steps"], d["causes"], finding=d.get("headline", ""),
                      trade_hint=d.get("trade", ""), needs_pro=bool(d.get("needs_pro")))
            out.update(verdict=v["verdict"], rule=v["rule"], trade=v["trade"], headline=d.get("headline"),
                       steps=[d["steps"][i]["check"] for i in v["allowed_steps"]])
            if v["verdict"] == "diy" and not out["steps"]:
                out["problems"].append("DIY with no steps")
        if exp.get("verdict") and out["verdict"] != exp["verdict"]:
            out["problems"].append(f"verdict {out['verdict']} (want {exp['verdict']})")
        if exp.get("trade") and not any(t in (out["trade"] or "").lower() for t in exp["trade"]):
            out["problems"].append(f"trade {out['trade']} (want {'/'.join(exp['trade'])})")
        if exp.get("headline") and not any(h in (out["headline"] or "").lower() for h in exp["headline"]):
            out["problems"].append(f"finding '{out['headline']}' (want {'/'.join(exp['headline'])})")
    except Exception as exc:  # a model or network failure is a result too
        out["problems"].append(f"error: {str(exc)[:160]}")
    out["seconds"] = round(time.time() - t0, 1)
    return out


def report(results: list) -> str:
    lines = ["# Test-case dry run", "",
             f"{sum(not r['problems'] for r in results if not r.get('skip'))} of "
             f"{sum(not r.get('skip') for r in results)} cases as expected "
             f"(model: {spark.active_model()}, {time.strftime('%Y-%m-%d %H:%M')}).", ""]
    cat = None
    for r in results:
        if r["cat"] != cat:
            cat = r["cat"]
            lines += [f"## {cat}", "", "| Case | Said | Path | Outcome | OK |", "|---|---|---|---|---|"]
        if r.get("skip"):
            lines.append(f"| {r['id']} | {r['said']} | - | skipped: {r['skip']} | - |")
            continue
        path = ("scan warning" if r["verdict"] == "warned" else
                f"{r['route']}" + (f", {len(r['tests'])} test(s)" if r["tests"] else "")
                + (f", agent stop: {r['agent_stop']}" if r.get("agent_stop") else ""))
        outcome = (f"warning `{r['warning']}`, offers {r['trade']}" if r["verdict"] == "warned" else
                   f"{r['verdict']}{' `' + r['rule'] + '`' if r['rule'] else ''}: {r['headline']}"
                   + (f" -> {r['trade']}" if r["verdict"] == "pro" else f" ({len(r['steps'])} steps)"))
        ok = "yes" if not r["problems"] else "no: " + "; ".join(r["problems"])
        lines.append(f"| {r['id']} | {r['said']} | {path} | {outcome} | {ok} |")
        lines[-1] += ""
    lines.append("")
    for r in results:
        if r.get("tests") or r.get("quick"):
            lines.append(f"<details><summary>{r['id']} details ({r.get('seconds')} s)</summary>\n")
            if r.get("quick"):
                lines.append(f"- Quick checks: {'; '.join(r['quick'])}")
            for t in r.get("tests", []):
                lines.append(f"- {t}")
            if r.get("steps"):
                lines.append(f"- Steps: {' / '.join(r['steps'])}")
            lines.append("\n</details>\n")
    return "\n".join(lines)


WARN_TITLE = {
    "microwave": "microwaves hold a deadly charge", "gas-appliance": "gas can leak or explode",
    "danger-symptom": "smoke, sparks or a burning smell", "swollen-battery": "a swollen battery can catch fire",
    "water-heater": "mains power and hot water under pressure", "tv-display": "high-voltage parts inside",
    "ev-battery": "a high-voltage battery pack",
}


def expected_text(c: dict) -> str:
    if c.get("see"):
        # Some cases have a step before the quick checks (the vague-words prompt).
        return c["see"] if c["see"].startswith("The app first") else "Quick checks first. " + c["see"]
    e = c["expect"]
    if e.get("warning"):
        return (f"A warning before any fix ({WARN_TITLE.get(e['warning'], e['warning'])}). "
                "You can find a handyman, or tick \"I understand the risk\" and go on.")
    parts = ["Quick checks first."]
    if e.get("route") == "direct":
        parts.append("Then straight to the fix (one cause stands out).")
    elif e.get("route") == "investigate":
        parts.append("With the agent on, a few tests first (several causes fit).")
    if e.get("verdict") == "diy":
        parts.append("A fix you can do, step by step"
                     + (f", about {'/'.join(e['headline'][:2])}" if e.get("headline") else "") + ".")
    elif e.get("verdict") == "pro":
        parts.append("A handyman" + (f" ({' / '.join(e['trade'])})" if e.get("trade") else "")
                     + ", with the diagnosis ready to send.")
    elif e.get("headline"):
        parts.append(f"A finding about the {'/'.join(e['headline'])}.")
    return " ".join(parts)


def doc(results: dict) -> str:
    """docs/TEST_CASES.md: the cases for people, with the last dry run."""
    ok = [r for r in results.values() if not r.get("skip")]
    lines = [
        "# Test cases",
        "",
        "Thirty-one things to try in Handyman, the way a judge or a first-time",
        "user might. Point the camera at the machine (or add a photo), then",
        "say or type the words in the second column. Open the app with",
        "`?agent=1` to let it run tests on unclear cases (`?agent=0` turns",
        "that off).",
        "",
        "The last column is the latest dry run of each case through the",
        "app's own code with live models (`SPARK_MODEL=prod python -m",
        "eval.suite`). A stand-in owner answers the app's questions from",
        "facts written for each case. Cases A1 to A4 use a photo; the rest",
        "run on words alone. "
        f"Result: {sum(not r['problems'] for r in ok)} of {len(ok)} as expected"
        f" ({time.strftime('%Y-%m-%d')}, {next((r.get('model') for r in ok if r.get('model')), spark.active_model())}).",
        "",
    ]
    cat = None
    for c in CASES:
        if c["cat"] != cat:
            cat = c["cat"]
            lines += ["", f"## {cat}", "", "| # | Say or type | You should see | Last dry run |", "|---|---|---|---|"]
        r = results.get(c["id"])
        if not r:
            got = "not run"
        elif r.get("skip"):
            got = f"skipped ({r['skip']})"
        elif r["verdict"] == "warned":
            got = f"warning `{r['warning']}`, offers {r['trade']}"
        else:
            how = f"{r['route']}, {len(r['tests'])} test(s)" if r.get("route") else ""
            got = (f"{'fix it yourself' if r['verdict'] == 'diy' else 'handyman (' + str(r['trade']) + ')'}: "
                   f"{r['headline']} [{how}]")
            if r["problems"]:
                got += " **Miss:** " + "; ".join(r["problems"])
        lines.append(f"| {c['id']} | \"{c['said']}\" | {expected_text(c)} | {got} |")
    lines += ["", "## Known misses", "",
              "Cases marked **Miss** went another way in the last run. Model answers",
              "vary from run to run; the safety warnings (D, F2, F3) come from fixed",
              "rules and do not.", ""]
    return "\n".join(lines)


def main() -> int:
    if sys.argv[1:] == ["--doc"]:
        res = {r["id"]: r for r in json.loads((ROOT / "eval" / "out" / "suite-results.json").read_text())}
        out = ROOT / "docs" / "TEST_CASES.md"
        out.parent.mkdir(exist_ok=True)
        out.write_text(doc(res))
        print(f"wrote {out.relative_to(ROOT)}")
        return 0
    ids = set(sys.argv[1:])
    todo = [c for c in CASES if not ids or c["id"] in ids]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(run, todo))
    bad = 0
    for r in results:
        if r.get("skip"):
            print(f"[SKIP] {r['id']} {r['skip']}")
            continue
        ok = not r["problems"]
        bad += not ok
        print(f"[{'PASS' if ok else 'FAIL'}] {r['id']:3} {r['cat'][:22]:22} route={str(r['route']):11} "
              f"tests={len(r['tests'])} verdict={r['verdict']} {r['rule'] or ''} trade={r['trade']} "
              f"| {r['headline']} ({r.get('seconds')} s)")
        for p in r["problems"]:
            print(f"        PROBLEM: {p}")
    out = ROOT / "eval" / "out" / "suite-report.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report(results))
    (ROOT / "eval" / "out" / "suite-results.json").write_text(json.dumps(results, indent=1))
    print(f"\n{len(results) - bad} of {len(results)} as expected; report: {out.relative_to(ROOT)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
