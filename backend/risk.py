"""Deterministic safety rules: the model proposes, the rules decide.

Spark's diagnose() proposes steps. judge() reads every step (what it
asks the user to *do*), plus the device and the reported symptoms, and
decides per step whether an owner may do it. Any forcing rule turns the
verdict into "call a pro";
blocked steps are dropped and the safe ones (before or after) stay as
checks the owner can do before the pro arrives.

Every rule carries plain words for the verdict card ("Opening the
scooter's panel needs a mechanic.") and a short spoken line (< 2s).

Owner jobs are allowed explicitly, before the forcing rules look at a
step: lifting an AC's front panel to wash the filter, checking an
inverter battery's water-level floats and topping up distilled water,
opening a laptop's base cover to swap RAM or an SSD.
"""

import re
from dataclasses import dataclass, field


def _rx(*words: str) -> re.Pattern:
    return re.compile(r"\b(?:" + "|".join(words) + r")", re.IGNORECASE)


# Verbs that open something up.
OPEN = [r"open", r"unscrew", r"unbolt", r"remov", r"pry", r"prise",
        r"take (?:off|apart|out)", r"detach", r"dismantl", r"unclip",
        r"split", r"lift off", r"pull off", r"undo"]
# Hands-on verbs (contact of any kind). A step that only says "look at"
# is visual inspection and never matches.
TOUCH = OPEN + [r"touch", r"tighten", r"loosen", r"disconnect",
                r"reconnect", r"connect", r"clean", r"scrub", r"wipe",
                r"brush", r"multimeter", r"probe", r"clamp", r"jump",
                r"bridge", r"short", r"reseat", r"wiggle", r"jiggle",
                r"grease", r"apply", r"spray", r"replace", r"swap", r"pull",
                r"rewir", r"solder", r"twist", r"hand-wiggle"]

VEHICLE = _rx(r"scooter", r"motorcycle", r"motorbike", r"\bbike\b",
              r"two[- ]wheeler", r"moped", r"activa", r"jupiter", r"access 125",
              r"vehicle", r"car\b")
AC = _rx(r"air ?condition", r"\bac\b", r"split ac", r"window ac",
         r"indoor unit", r"outdoor unit")
INVERTER = _rx(r"inverter", r"\bups\b", r"tubular battery",
               r"lead[- ]acid", r"battery bank")
LAPTOP = _rx(r"laptop", r"notebook", r"macbook", r"thinkpad", r"chromebook")


@dataclass
class Rule:
    id: str
    title: str          # plain words, shown on the verdict card
    spoken: str         # one short sentence, spoken before anything else
    trade: str          # who to call (drives the call-a-pro search)
    applies: object     # (job) -> bool  context check
    step: object = None  # (text) -> bool  per-step check, or None
    symptom: object = None  # (issue text) -> bool  whole-job check


@dataclass
class Job:
    device: str
    issue: str
    steps: list = field(default_factory=list)

    @property
    def context(self) -> str:
        return f"{self.device} {self.issue}".lower()


def _any(*patterns):
    rx = [p if isinstance(p, re.Pattern) else re.compile(p, re.I)
          for p in patterns]
    return lambda text: any(r.search(text) for r in rx)


# Clauses that are negated ("without touching them", "do not open")
# describe what NOT to do and never count as an action.
_NEGATED = re.compile(r"\b(?:without|never|don'?t|do not|avoid|no need to)"
                      r"\b[^,;.:]*", re.I)
_CLAUSE = re.compile(r"[,;.:\n]|\bthen\b|\band\b", re.I)


def _acts_on(verbs: list, *objects: str):
    """True when a step's clause applies one of `verbs` to an object.

    The verb and the object must sit in the same clause, at most four
    words apart (either order). "Lift the front panel up from the front
    casing" does not open the casing; "unscrew the indoor unit casing"
    does.
    """
    v = "(?:" + "|".join(verbs) + r")\w*"
    o = "(?:" + "|".join(objects) + ")"
    fwd = re.compile(rf"\b{v}(?:\s+[^\s]+){{0,4}}?\s+{o}", re.I)
    back = re.compile(rf"\b{o}\w*(?:\s+[^\s]+){{0,3}}?\s+{v}", re.I)

    def check(text: str) -> bool:
        text = _NEGATED.sub(" ", text)
        return any(fwd.search(c) or back.search(c)
                   for c in _CLAUSE.split(text) if c.strip())
    return check


def _hands_on(*objects):
    return _acts_on(TOUCH, *objects)


def _opens(*objects):
    return _acts_on(OPEN, *objects)


# --- Owner jobs, allowed before forcing rules look at the step ---------
#
# These strip the allowed phrase out of a step so the forcing rules only
# see what is left. "Lift the front panel and slide out the filter" is
# fully allowed; "lift the front panel and unscrew the casing" still
# trips the sealed-casing rule on "unscrew the casing".
OWNER_JOBS = [
    # AC: front panel / grille flips up, filters slide out and get washed.
    (AC, re.compile(r"\b(?:front|top|filter) (?:panel|grille|grill|cover|flap)"
                    r"|\b(?:air |dust |mesh )?filters?\b", re.I)),
    # Inverter battery: float indicators and vent caps for distilled water.
    (INVERTER, re.compile(r"\b(?:water[- ]level )?floats?\b|float indicators?"
                          r"|\bvent (?:caps?|plugs?)\b|\bdistilled water\b"
                          r"|\bwater level\b", re.I)),
    # Laptop: base cover screws for RAM / SSD.
    (LAPTOP, re.compile(r"\b(?:bottom|base|back) (?:panel|cover|plate|case)\b"
                        r"|\bram\b|\bmemory (?:stick|module)s?\b|\bssd\b"
                        r"|\bm\.?2\b|\bdimm\b|\bso-?dimm\b", re.I)),
]


def _strip_owner_jobs(job: Job, text: str) -> str:
    for context, allowed in OWNER_JOBS:
        if context.search(job.context):
            text = allowed.sub(" ", text)
    return text


# --- Forcing rules, in priority order (first fired is the headline) ----
RULES = [
    Rule("danger-symptom",
         "Sparks, smoke, a burning smell or a shock mean it stays off "
         "until a technician sees it.",
         "Switch it off now.",
         "electrician",
         applies=lambda job: True,
         symptom=_any(_rx(r"spark", r"smok", r"burning smell", r"burnt smell",
                          r"smell of burning", r"melt", r"scorch", r"shock",
                          r"current leak", r"on fire", r"caught fire",
                          r"catching fire"))),
    Rule("swollen-battery",
         "A swollen battery can catch fire; a technician must remove it.",
         "That battery needs a pro.",
         "laptop / phone repair",
         applies=lambda job: True,
         symptom=_any(_rx(r"swollen", r"swelling", r"bulg", r"puff",
                          r"battery (?:has )?expand"))),
    Rule("gas-fittings",
         "Gas pipes, regulators and burner fittings are for a gas "
         "technician only.",
         "Call a gas technician.",
         "gas technician",
         applies=lambda job: True,
         step=_hands_on(r"gas (?:pipe|line|hose|valve|regulator|fitting)",
                        r"regulator", r"lpg", r"cylinder valve",
                        r"burner (?:pipe|fitting|nozzle)")),
    Rule("mains-electricity",
         "Wiring, sockets and the switchboard carry mains power; that is "
         "an electrician's job.",
         "Call an electrician.",
         "electrician",
         applies=lambda job: True,
         step=_hands_on(r"(?:loose |live |\w+ )?wir(?:e|es|ing)\b", r"mains",
                        r"switchboard", r"switch board", r"mcb\b",
                        r"fuse box", r"distribution box", r"socket",
                        r"plug point", r"capacitor", r"pcb",
                        r"circuit board", r"control board")),
    Rule("vehicle-body-panel",
         "Opening the scooter's panel needs a mechanic.",
         "This one needs a mechanic.",
         "two-wheeler mechanic",
         applies=lambda job: bool(VEHICLE.search(job.context)),
         step=_opens(r"(?:\w+ )?panel", r"cowl", r"fairing",
                     r"floor ?(?:board|panel|mat)",
                     r"battery (?:cover|box|compartment|lid)",
                     r"(?:\w+ )?cover")),
    Rule("battery-terminals",
         "Battery terminals carry high current; anything beyond looking "
         "at them is for a technician.",
         "Needs a technician.",
         "battery service",
         applies=lambda job: True,
         step=_hands_on(r"(?:battery |\w+ )?terminals?",
                        r"battery (?:lead|cable|clamp|post|wire)s?",
                        r"negative lead", r"positive lead")),
    Rule("sealed-casing",
         "Opening the unit's sealed casing exposes live parts; a "
         "technician must do it.",
         "Needs a technician.",
         "appliance technician",
         applies=lambda job: True,
         step=_opens(r"(?:\w+ )?(?:\w+ )?casing", r"(?:\w+ )?housing",
                     r"enclosure", r"(?:back|rear) (?:panel|cover)",
                     r"cover screws", r"cabinet", r"(?:\w+ )?outdoor unit",
                     r"compressor", r"(?:\w+ )?coil", r"blower",
                     r"(?:\w+ )?panel", r"(?:\w+ )?cover")),
]

TRADE_BY_DEVICE = [
    (VEHICLE, "two-wheeler mechanic"),
    (INVERTER, "inverter / battery service"),
    (AC, "AC technician"),
    (LAPTOP, "laptop repair"),
]


def _step_text(step) -> str:
    if isinstance(step, dict):
        return " ".join(str(step.get(k) or "")
                        for k in ("check", "how", "part"))
    return str(step or "")


def judge(device: str = "", issue: str = "", steps: list | None = None,
          causes: list | None = None) -> dict:
    """Decide the verdict for a proposed fix.

    Returns {"verdict": "diy" | "pro", "rule": id | None, "title": plain
    words | None, "spoken": short line | None, "trade": str | None,
    "fired": [rule ids], "allowed_steps": [indices], "blocked_step":
    index | None}.
    """
    steps = list(steps or [])
    # Symptoms come from what the user reported, never from the model's
    # causes (which often mention "shock risk" as a warning).
    job = Job(device or "", issue or "", steps)
    fired: list = []
    blocked: list = []
    stop_all = False

    for rule in RULES:
        if rule.symptom and rule.applies(job) and rule.symptom(job.issue):
            fired.append(rule)
    if fired:
        stop_all = True  # a danger symptom: nothing hands-on at all

    for i, st in enumerate(steps):
        text = _strip_owner_jobs(job, _step_text(st))
        for rule in RULES:
            if rule.step and rule.applies(job) and rule.step(text):
                if rule not in fired:
                    fired.append(rule)
                if i not in blocked:
                    blocked.append(i)

    if not fired:
        return {"verdict": "diy", "rule": None, "title": None,
                "spoken": None, "trade": None, "fired": [],
                "allowed_steps": list(range(len(steps))),
                "blocked_steps": [], "blocked_step": None}

    head = min(fired, key=RULES.index)
    trade = head.trade
    for ctx, t in TRADE_BY_DEVICE:
        if ctx.search(job.context) and head.id not in ("danger-symptom",
                                                      "gas-fittings",
                                                      "mains-electricity"):
            trade = t
            break
    return {"verdict": "pro", "rule": head.id, "title": head.title,
            "spoken": head.spoken, "trade": trade,
            "fired": [r.id for r in sorted(fired, key=RULES.index)],
            # Safe steps stay (before or after a blocked one): they become
            # the checks the owner can still do before the pro arrives.
            "allowed_steps": [] if stop_all else
            [i for i in range(len(steps)) if i not in blocked],
            "blocked_steps": list(range(len(steps))) if stop_all else blocked,
            "blocked_step": 0 if stop_all and steps else
            (blocked[0] if blocked else None)}


def assess_risk(device: str = "", issue: str = "") -> dict:
    """Legacy shape for callers that only know device + issue."""
    v = judge(device, issue, [])
    return {"level": "high" if v["verdict"] == "pro" else "standard",
            "hazard": v["rule"] or "", "reason": v["title"] or ""}
