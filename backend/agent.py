"""Diagnostic agent loop (experimental, behind NEXT_PUBLIC_AGENT_LOOP).

Instead of one diagnosis with up to two questions, the model keeps 3-4
competing hypotheses with probabilities and runs one test per round,
picking the test that best separates the top hypotheses:

  ask_user     one question with answer chips
  look_closer  the owner frames one named part; the close photo comes back
  listen       4 s of the machine's sound (the existing /api/listen)
  segment      SAM 3.1 outlines one part on the photo already taken

Every proposed test goes through the safety rules (risk.judge) before
the owner sees it. The loop stops when the top hypothesis passes 75%,
after 5 tests, or when the best next test is blocked by a rule (then the
owner is sent to a handyman with "Next test blocked by rule: ...").

The client holds the state (hypotheses + the tests so far) and sends it
back each round, so the server keeps nothing between requests. One
Muse Spark call per round; the photo is only sent on the first look and
with a closer look, so text-only rounds stay fast.
"""

import base64
import os

from . import spark, trace
from .risk import judge

CONFIDENT = 0.75
MAX_TESTS = 5
TOOLS = ("ask_user", "look_closer", "listen", "segment")

SYSTEM = (
    "You are the diagnostic engine of a home repair app. You keep 3 or 4 "
    "competing hypotheses about what is wrong with the owner's machine, "
    "with probabilities that add up to 1, and you run one test per round "
    "to tell them apart.\n"
    "Tools, pick exactly one per round:\n"
    "- ask_user: one short question the owner can answer by looking, "
    "listening, feeling or remembering, with 2 to 4 short answer chips. "
    "Fields: question, options.\n"
    "- look_closer: the owner points the camera at one named part for a "
    "close photo. Fields: part (2 to 5 words, the exact spot), look (1 to 3 "
    "plain words for what it looks like), how (what the owner must "
    "physically do to show it, like \"nothing, it is in view\" or \"remove "
    "the side panel\").\n"
    "- listen: record 4 seconds of the machine's sound; the app measures "
    "the beep count, rhythm and pitch. When the complaint is a sound "
    "(beeping, clicking, humming, grinding), listen early: a measurement "
    "beats the owner's description. Field: what (what to listen for).\n"
    "- segment: outline one part on the photo already taken, to check it "
    "is there or where it is. Fields: part, look.\n"
    "Rank the hypotheses from base rates: how often each cause is behind "
    "this symptom in homes, weighted by what the owner already said (a "
    "remote that was dropped makes a loose battery contact the leading "
    "cause; a kettle that trips the switch only on one socket points to "
    "the socket before the kettle). Consumables, settings, loose fittings "
    "and wear come before failed parts. Do not lead with a rare cause "
    "while a common one is untested.\n"
    "Choose the test with the most expected information: first ask "
    "yourself which single result would most likely end the diagnosis, "
    "and prefer a test that could confirm or rule out the leading "
    "hypothesis over one that only trims an unlikely one. Among equally useful tests prefer the "
    "cheapest, in this order: a question, a look at something in view or "
    "behind a cover owners open in normal use (a filter flap, a battery "
    "cap, a lid), a sound, and only then anything that needs tools or "
    "opening the machine. But when the leading hypothesis is something "
    "that can be seen on a part the owner can reach that way, look at it: "
    "a close photo is harder evidence than an answer. A test the owner "
    "cannot answer is useless, so ask about things they can see, hear or "
    "remember. Before proposing any test that needs tools or opening the "
    "machine, use up the owner-doable tests that could still move a "
    "hypothesis by 10 points or more; a test that needs opening comes "
    "only when nothing the owner can safely do would still help. A strong "
    "safe test is a question about a symptom the leading hypothesis "
    "predicts and the others do not (what happens at the moment of the "
    "fault, what changes when something is switched or pressed). Never "
    "repeat a test already run. Propose the most informative test even if "
    "it means opening something: a separate safety layer decides whether "
    "the owner may do it, so state in how exactly what the owner would "
    "have to do. Probabilities must reflect the evidence: move them "
    "decisively when a result is clear (a close look that directly shows "
    "the cause, like visible dirt, a burnt part or a reading, puts it at "
    "0.8 to 0.9), and only go above 0.75 when the evidence really points "
    "to one cause. An answer of not sure changes little. Owner answers "
    "are softer evidence than a photo or a measurement: on answers alone, "
    "stay at or below 0.75 until three tests agree. Keep each cause's wording "
    "exactly as before so it can be tracked; add or drop a cause only when "
    "the evidence demands it. Every action has why: one line saying which "
    "hypotheses it separates and how.\n"
    "Keep it short: seen only on the first look (omit it after), causes "
    "of at most 6 words, why of at most 15 words, chips of at most 4 "
    "words, and only the fields the chosen tool uses.\n"
    "Reply with only compact JSON: {\"seen\": \"one sentence on what the "
    "photo shows\", \"hypotheses\": [{\"cause\": \"at most 8 words\", "
    "\"p\": 0.0}], \"action\": {\"tool\": \"ask_user\", \"question\": \"...\", "
    "\"options\": [\"...\"], \"part\": \"...\", \"look\": \"...\", \"how\": "
    "\"...\", \"what\": \"...\", \"why\": \"...\"}}"
)


def _effort() -> str:
    # "minimal" keeps a round near 4-6 s; "low" reasons more but runs
    # 6-10 s. Set AGENT_EFFORT on the agent backend to compare.
    return (os.environ.get("AGENT_EFFORT") or "minimal").strip()


def _hypotheses(raw) -> list:
    """3-4 {cause, p}, probabilities normalised to 1, best first."""
    out = []
    for h in raw if isinstance(raw, list) else []:
        if not isinstance(h, dict):
            continue
        cause = str(h.get("cause", "")).strip()
        try:
            p = max(0.0, float(h.get("p", 0)))
        except (TypeError, ValueError):
            p = 0.0
        if cause and not any(o["cause"].lower() == cause.lower() for o in out):
            out.append({"cause": cause, "p": p})
    total = sum(h["p"] for h in out) or 1.0
    for h in out:
        h["p"] = round(h["p"] / total, 3)
    out.sort(key=lambda h: -h["p"])
    return out[:4]


HARD = ("look_closer", "listen", "segment")
SOFT_TESTS_NEEDED = 3


def _calibrated(hyps: list, history: list) -> list:
    """Owner answers are soft evidence (memory, guesses, wording). Until
    a photo or measurement backs it, or three tests agree, the leading
    cause is held at 75%: the loop keeps testing instead of stopping on
    two answers. The remainder is shared out in proportion."""
    if not hyps or hyps[0]["p"] <= CONFIDENT:
        return hyps
    hard = any((h.get("action") or {}).get("tool") in HARD for h in history)
    if hard or len(history) >= SOFT_TESTS_NEEDED:
        return hyps
    rest = sum(h["p"] for h in hyps[1:])
    out = [{**hyps[0], "p": CONFIDENT}]
    for h in hyps[1:]:
        share = h["p"] / rest if rest else 1 / max(1, len(hyps) - 1)
        out.append({**h, "p": round(share * (1 - CONFIDENT), 3)})
    return out


def _soft_only(history: list) -> bool:
    """Only owner answers so far, and fewer than three of them."""
    return (len(history) < SOFT_TESTS_NEEDED and not any(
        (h.get("action") or {}).get("tool") in HARD for h in history))


def _action(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    tool = str(raw.get("tool", "")).strip()
    if tool not in TOOLS:
        return None
    a = {"tool": tool, "why": str(raw.get("why", "")).strip()}
    for k in ("question", "part", "look", "how", "what"):
        v = str(raw.get(k) or "").strip()
        if v:
            a[k] = v
    opts = [str(o).strip() for o in raw.get("options") or [] if str(o).strip()]
    if tool == "ask_user":
        if not a.get("question"):
            return None
        a["options"] = opts[:4] or ["Yes", "No"]
    if tool in ("look_closer", "segment") and not a.get("part"):
        return None
    return a


def _blocked(machine: str, issue: str, action: dict) -> dict | None:
    """The safety rules on the test itself: would the owner have to do
    something an owner should not (open a panel, touch terminals)?"""
    if action["tool"] == "listen":
        return None
    check = action.get("question") or f"look closer at the {action.get('part', '')}"
    step = {"check": check, "how": action.get("how", ""),
            "part": action.get("part")}
    v = judge(machine, issue, [step])
    if not v["blocked_steps"]:
        return None
    return {"rule": v["rule"], "title": v["title"], "trade": v["trade"],
            "spoken": v["spoken"]}


def _history_text(history: list) -> str:
    lines = []
    for i, h in enumerate(history, 1):
        a = h.get("action") or {}
        test = {
            "ask_user": f"asked \"{a.get('question', '')}\"",
            "look_closer": f"close photo of the {a.get('part', '')}",
            "listen": f"listened for {a.get('what', 'the sound')}",
            "segment": f"outlined the {a.get('part', '')} on the photo",
        }.get(a.get("tool"), a.get("tool", "test"))
        lines.append(f"{i}. {test}: {h.get('result') or 'no result'}")
    return "\n".join(lines) or "none yet"


def step(machine: str, issue: str, *, image: bytes | None = None,
         seen: str = "", hypotheses: list | None = None,
         history: list | None = None) -> dict:
    """One round. With no history: the first look (photo + words). After
    a test: the latest result updates the hypotheses and the next test
    is chosen. Returns the new state and whether to stop."""
    url, key, model = spark._config()
    history = list(history or [])
    first = not history
    n = len(history)  # tests already run
    if first:
        text = (f"Machine: {machine or 'unknown'}. The owner says: "
                f"{issue.strip()[:300]}\nFirst look: describe what the photo "
                "shows in seen, list the hypotheses, choose the first test.")
    else:
        latest = history[-1]
        text = (f"Machine: {machine or 'unknown'}. The owner says: "
                f"{issue.strip()[:300]}\nThe photo shows: {seen or 'unknown'}\n"
                f"Hypotheses before the latest test: "
                + "; ".join(f"{h['cause']} {round(h['p'] * 100)}%"
                            for h in hypotheses or [])
                + f"\nTests so far:\n{_history_text(history)}\n"
                + ("The close photo from the latest test is attached. "
                   if latest.get("action", {}).get("tool") == "look_closer"
                   and image else "")
                + "Update the hypotheses with the latest result, then "
                "choose the next test.")
    if _soft_only(history):
        # Only while the case rests on answers: a safe fallback in case
        # the best test needs opening (it is not asked for later, which
        # keeps the later, longer rounds shorter).
        text += ("\nAlso give safe: the most useful test the owner can do "
                 "without tools or opening anything (same fields as action), "
                 "or null if none would still help; it is used if the safety "
                 "layer blocks action. Reply shape: {..., \"safe\": {...}}")
    content: list | str = text
    if image:
        b64 = base64.b64encode(image).decode()
        content = [{"type": "text", "text": text},
                   {"type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": content}],
        "max_tokens": 2500,
        "reasoning_effort": _effort(),
        "response_format": {"type": "json_object"},
    }
    parsed = spark._complete(url, key, payload, ["hypotheses", "action"],
                             purpose=f"agent round {n + 1}"
                             if not first else "agent first look",
                             image=image)
    hyps = _hypotheses(parsed.get("hypotheses")) or _hypotheses(hypotheses)
    hyps = _calibrated(hyps, history)
    action = _action(parsed.get("action"))
    seen = str(parsed.get("seen") or seen or "").strip()
    top = hyps[0] if hyps else {"cause": "", "p": 0.0}

    stop = None
    if top["p"] > CONFIDENT:
        stop = {"reason": "confident"}
        # The cause is known; may the owner fix it? (A weak scooter
        # battery sits behind the body panel: that is a handyman's job.)
        v = judge(machine, issue, [], causes=[top["cause"]],
                  finding=top["cause"])
        if v["verdict"] == "pro":
            stop["fix_blocked"] = {"rule": v["rule"], "title": v["title"],
                                   "trade": v["trade"]}
    elif n >= MAX_TESTS:
        stop = {"reason": "max-rounds"}
    elif action is None:
        stop = {"reason": "no-test"}
    else:
        blocked = _blocked(machine, issue, action)
        safe = _action(parsed.get("safe"))
        if blocked and safe and not _blocked(machine, issue, safe) \
                and _soft_only(history):
            # The best test needs opening, but the case rests on answers
            # alone: run the owner's best safe test first, and say why.
            safe["why"] = (f"Best test blocked ({blocked['title']}), so a "
                           f"safe one first: {safe.get('why', '')}").strip()
            safe["blocked"] = blocked
            action = safe
        elif blocked:
            stop = {"reason": "blocked", **blocked}

    with trace.call("Handyman agent", f"round {n + 1}: "
                    + (f"stop ({stop['reason']})" if stop
                       else action["tool"]), kind="hop") as rec:
        rec["parsed"] = {"hypotheses": hyps, "action": action,
                         "stop": stop, "tests_run": n}
    trace.log_outcome("agent", round=n + 1, tool=action and action["tool"],
                      top=top["cause"], p=top["p"],
                      stop=stop and stop["reason"],
                      rule=stop and stop.get("rule"))
    return {"seen": seen, "hypotheses": hyps,
            "action": None if stop else action, "stop": stop,
            "round": n + 1,
            # The blocked test is still shown: "Next test blocked by
            # rule: ..." names what the owner should not do.
            "blocked_action": action if stop and stop["reason"] == "blocked"
            else None}


def findings(seen: str, hypotheses: list, history: list) -> str:
    """The loop's evidence as one answers string for the final
    diagnosis (the existing analyze endpoint turns it into steps)."""
    top = hypotheses[0] if hypotheses else None
    parts = [f"Diagnostic tests run: {_history_text(history)}".replace("\n", " ")]
    if seen:
        parts.append(f"Photo: {seen}")
    if top:
        parts.append("Most likely cause after testing: "
                     f"{top['cause']} ({round(top['p'] * 100)}%). Others: "
                     + ", ".join(f"{h['cause']} {round(h['p'] * 100)}%"
                                 for h in hypotheses[1:]))
    return " ".join(parts)
