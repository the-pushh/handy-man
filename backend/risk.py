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
CAR = _rx(r"car\b", r"sedan", r"hatchback", r"\bsuv\b", r"jeep", r"truck")
# AC findings only a technician can fix: the sealed refrigerant circuit,
# the compressor and its electrics.
AC_SEALED = _rx(r"refrigerant", r"gas (?:leak|charg|refill|top)", r"low gas",
                r"compressor", r"capacitor", r"outdoor unit", r"pcb",
                r"control board", r"condenser fan")
# What sits behind a two-wheeler's body panels.
BEHIND_PANEL = _rx(r"batter", r"starter (?:relay|motor|solenoid)", r"relay",
                   r"fuse", r"wiring", r"regulator rectifier", r"\becu\b")


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
# A clause about calling a pro describes the pro's work, not the owner's.
_FOR_PRO = re.compile(r"\b(?:call|calling|contact|ask|book|get)\b[^,;.:]*\b"
                      r"(?:professional|technician|mechanic|electrician|pro|"
                      r"service centre|service center|dealer)\b[^,;.:]*", re.I)


def _acts_on(verbs: list, *objects: str):
    """True when a step's clause applies one of `verbs` to an object.

    The verb must come first and the object follow in the same clause,
    at most six words later. Object-then-verb is a description of state
    ("the louver on the casing is fully open"), not an action. "Lift the front panel up from the front
    casing" does not open the casing; "unscrew the indoor unit casing"
    does.
    """
    v = "(?:" + "|".join(verbs) + r")\w*"
    o = "(?:" + "|".join(objects) + ")"
    # Between verb and object: up to six words, none a preposition, so
    # "swing the louver fully open on the front casing" (open as a
    # state, casing as a location) does not read as opening the casing.
    gap = (r"(?:\s+(?!(?:on|in|at|from|under|behind|near|with|by|into|"
           r"onto|over|beside|inside|below|above|for|if|after|before|"
           r"until|when|while|or|but|so)\b)[^\s]+)")
    fwd = re.compile(rf"\b{v}{gap}{{0,6}}?\s+{o}", re.I)
    # The verb acting on a pronoun for an object named earlier in the
    # same clause: "do the terminals move when you wiggle them?".
    obj = re.compile(rf"\b{o}", re.I)
    ana = re.compile(rf"\b{v}\s+(?:it|them|these|those)\b", re.I)

    def check(text: str) -> bool:
        text = _FOR_PRO.sub(" ", _NEGATED.sub(" ", text))
        return any(fwd.search(c) or (obj.search(c) and ana.search(c))
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
    # Any machine (not a vehicle): the parts owners are meant to open —
    # a printer's paper tray and ink/toner door, a lid or a door, a
    # washer's filter or drain flap, a remote's battery cover.
    (re.compile(r"^(?!.*\b(?:scooter|motorcycle|motorbike|bike|moped|car|"
                r"vehicle|two[- ]wheeler)\b)", re.I | re.S),
     re.compile(r"\b(?:paper|input|output) tray(?: cover)?\b"
                r"|\b(?:ink|toner|cartridge)(?: access)? (?:door|cover|lid)\b"
                r"|\b(?:top |front |washer |machine )?lid\b"
                r"|\b(?:oven |fridge |freezer |washer |machine |front |loading )?door\b"
                r"|\b(?:lint |drain |pump )?filter (?:cover|flap|door|cap)\b"
                r"|\bdrain (?:pump )?(?:cover|flap|cap)\b"
                r"|\bremote(?:'s)? battery (?:cover|compartment|door)\b", re.I)),
    # Laptop: base cover screws for RAM / SSD.
    (LAPTOP, re.compile(r"\b(?:bottom|base|back) (?:panel|cover|plate|case)\b"
                        r"|\bram\b|\bmemory (?:stick|module)s?\b|\bssd\b"
                        r"|\bm\.?2\b|\bdimm\b|\bso-?dimm\b", re.I)),
]


# Safety prep any owner does first: switching off or unplugging at the
# wall. "Disconnect mains, then top up" is not electrical work; anything
# naming wiring, cables, leads or terminals still reaches the rules.
SAFETY_PREP = re.compile(
    r"\b(?:switch(?:ing)? off|turn(?:ing)? off|unplug(?:ging)?|"
    r"disconnect(?:ing)?|isolat(?:e|ing)|cut(?:ting)?)"
    r"(?:\s+(?:the|it|from|at|its))*"
    r"\s+(?:mains|power|supply|plug|electricity)\b"
    r"(?!\s+(?:wir|cable|lead|terminal|socket|board))"
    r"(?:\s+(?:power|supply|switch|at the wall))?", re.I)


def _strip_owner_jobs(job: Job, text: str) -> str:
    text = SAFETY_PREP.sub(" ", text)
    for context, allowed in OWNER_JOBS:
        if context.search(job.context):
            text = allowed.sub(" ", text)
    return text


# --- Forcing rules, in priority order (first fired is the headline) ----
RULES = [
    Rule("danger-symptom",
         "Sparks, smoke, a burning smell or a shock mean it stays off "
         "until a handyman checks it.",
         "Switch it off now.",
         "electrician",
         applies=lambda job: True,
         symptom=_any(_rx(r"spark", r"smok", r"burning smell", r"burnt smell",
                          r"smell of burning", r"melt", r"scorch", r"shock",
                          r"current leak", r"on fire", r"caught fire",
                          r"catching fire"))),
    Rule("swollen-battery",
         "A swollen battery can catch fire. Let a handyman take it out.",
         "That battery needs a handyman.",
         "laptop / phone repair",
         applies=lambda job: True,
         symptom=_any(_rx(r"swollen", r"swelling", r"bulg", r"puff",
                          r"battery (?:has )?expand"))),
    Rule("gas-fittings",
         "Gas pipes, regulators and burner fittings can leak. Leave them "
         "to a handyman who works with gas.",
         "Call a handyman for the gas.",
         "gas technician",
         applies=lambda job: True,
         step=_hands_on(r"gas (?:pipe|line|hose|valve|regulator|fitting)",
                        r"regulator", r"lpg", r"cylinder valve",
                        r"burner (?:pipe|fitting|nozzle)")),
    Rule("mains-electricity",
         "Wiring, sockets and the switchboard carry mains power. Leave "
         "them to a handyman.",
         "Call a handyman for this.",
         "electrician",
         applies=lambda job: True,
         step=_hands_on(r"wir(?:e|es|ing)\b", r"mains",
                        r"switchboard", r"switch board", r"mcb\b",
                        r"fuse box", r"distribution box", r"socket",
                        r"plug point", r"capacitor", r"pcb",
                        r"circuit board", r"control board")),
    Rule("vehicle-body-panel",
         "Opening the scooter's panel is a job for a handyman.",
         "This one needs a handyman.",
         "two-wheeler mechanic",
         applies=lambda job: bool(VEHICLE.search(job.context)),
         step=_opens(r"panel", r"cowl", r"fairing",
                     r"floor ?(?:board|panel|mat)",
                     r"battery (?:cover|box|compartment|lid)",
                     r"cover")),
    Rule("ac-sealed-system",
         "Refrigerant and the compressor are sealed. A handyman has to "
         "test and recharge them.",
         "This one needs a handyman.",
         "AC technician",
         applies=lambda job: bool(AC.search(job.context))),
    Rule("battery-terminals",
         "Battery terminals carry high current. Look, but leave the rest "
         "to a handyman.",
         "This one needs a handyman.",
         "battery service",
         applies=lambda job: True,
         step=_hands_on(r"terminals?",
                        r"battery (?:lead|cable|clamp|post|wire)s?",
                        r"negative lead", r"positive lead")),
    Rule("sealed-casing",
         "Opening the sealed casing exposes live parts. Let a handyman "
         "do it.",
         "This one needs a handyman.",
         "appliance technician",
         applies=lambda job: True,
         step=_opens(r"casing", r"housing",
                     r"enclosure", r"(?:back|rear) (?:panel|cover)",
                     r"cover screws", r"cabinet", r"outdoor unit",
                     r"compressor", r"coil", r"blower",
                     r"panel", r"cover")),
]

# A step that is itself "get a professional" means the model has run out
# of owner fixes (typical on a second run): the verdict is a pro.
PRO_STEP = _rx(r"professional", r"technician", r"mechanic", r"electrician",
               r"service (?:centre|center|visit)", r"call a pro",
               r"book a (?:service|repair)")
FALLBACK = _rx(r"if\b", r"in case", r"otherwise", r"unless", r"when .{0,30}fail",
              r"still not", r"doesn'?t (?:work|help)", r"does not (?:work|help)")
PRO_RECOMMENDED = Rule(
    "pro-recommended",
    "What's left to try needs a handyman's tools and training.",
    "Time to call a handyman.",
    "appliance technician",
    applies=lambda job: True)

TRADE_BY_DEVICE = [
    (CAR, "car mechanic"),
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
          causes: list | None = None, finding: str = "",
          trade_hint: str = "", needs_pro: bool = False) -> dict:
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

    for i, st in enumerate(steps):
        check = st.get("check", "") if isinstance(st, dict) else str(st)
        # "If it still won't start, call a technician" is a fallback the
        # owner may never need, not the verdict.
        if PRO_STEP.search(check) and not FALLBACK.search(check):
            if PRO_RECOMMENDED not in fired:
                fired.append(PRO_RECOMMENDED)
            if i not in blocked:
                blocked.append(i)

    # The model judged that the likely fix itself needs a technician
    # (opening, wiring, sealed parts, special tools): the verdict says so,
    # and its safe checks stay for the owner to do first.
    if needs_pro and PRO_RECOMMENDED not in fired:
        fired.append(PRO_RECOMMENDED)

    # The finding itself can force a pro even when the model only
    # proposed outside checks: on a two-wheeler the battery, starter
    # relay, fuses and wiring all sit behind body panels, so a most-
    # likely cause there means the fix needs the panel off.
    # The top cause and the spoken finding (headline) both count: the
    # finding is what the owner hears.
    top_cause = f"{(causes or [''])[0] or ''} {finding or ''}"
    panel = next(r for r in RULES if r.id == "vehicle-body-panel")
    if (VEHICLE.search(job.context) and BEHIND_PANEL.search(top_cause)
            and panel not in fired):
        fired.append(panel)
    # Same for an AC whose finding is the sealed system (refrigerant,
    # compressor): owner checks cannot fix it.
    sealed = next(r for r in RULES if r.id == "ac-sealed-system")
    if (AC.search(job.context) and AC_SEALED.search(top_cause)
            and sealed not in fired):
        fired.append(sealed)

    if not fired:
        # No rule fired, but if the fix fails the owner still needs the
        # right kind of pro for this device.
        # Who fixes this kind of machine: the rules' table for the trades
        # they know, else the model's own answer (a bicycle mechanic, a
        # printer repair shop), else a general technician.
        trade = next((t for ctx, t in TRADE_BY_DEVICE
                      if ctx.search(job.context)),
                     (trade_hint or "").strip() or "appliance technician")
        return {"verdict": "diy", "rule": None, "title": None,
                "spoken": None, "trade": trade, "fired": [],
                "allowed_steps": list(range(len(steps))),
                "blocked_steps": [], "blocked_step": None}

    order = RULES + [PRO_RECOMMENDED]
    head = min(fired, key=order.index)
    trade = head.trade
    specific = head.id in ("danger-symptom", "gas-fittings", "mains-electricity")
    if not specific:
        trade = next((t for ctx, t in TRADE_BY_DEVICE if ctx.search(job.context)),
                     (trade_hint or "").strip() or head.trade)
    title = head.title
    if head.id == "vehicle-body-panel":
        noun = next((n for n in ("scooter", "motorcycle", "motorbike", "moped",
                                 "car", "bike") if re.search(rf"\b{n}\b", job.context)),
                    "scooter" if re.search(r"activa|jupiter|access 125|scooty|dio|"
                                           r"pleasure|maestro|ntorq|two[- ]wheeler",
                                           job.context) else "vehicle")
        title = f"Opening the {noun}'s panel is a job for a handyman."
    return {"verdict": "pro", "rule": head.id, "title": title,
            "spoken": head.spoken, "trade": trade,
            "fired": [r.id for r in sorted(fired, key=order.index)],
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


# --- Scan-time check: machines an owner should not tinker with -----------
#
# Runs the moment the camera finds the machine the owner named, before
# any diagnosis: the owner hears the warning first and may go on at their
# own risk (the walkthrough then shows every step, marked as their risk).
# Symptoms the owner reported (smoke, a swollen battery) warn here too.
MACHINES = [
    ("microwave",
     _rx(r"microwave", r"\botg\b", r"convection oven"),
     "A microwave holds a deadly charge even when unplugged. Only a "
     "handyman should open it.",
     "Microwaves are a job for a handyman.",
     "appliance technician"),
    ("gas-appliance",
     _rx(r"gas (?:stove|hob|cooktop|geyser|heater|cylinder|pipe|burner)",
         r"\blpg\b", r"cylinder", r"regulator", r"gas chulha"),
     "Gas appliances can leak or explode. Let a handyman handle them.",
     "Gas is a job for a handyman.",
     "gas technician"),
    ("water-heater",
     _rx(r"geyser", r"water heater", r"boiler", r"immersion rod"),
     "A water heater mixes mains power and hot water under pressure. "
     "Let a handyman open it.",
     "Water heaters are a job for a handyman.",
     "appliance technician"),
    ("mains-board",
     _rx(r"switch ?board", r"\bmcb\b", r"fuse box", r"distribution (?:box|board)",
         r"electric(?:al)? panel", r"breaker (?:box|panel)", r"meter box",
         r"wall socket", r"socket", r"plug point", r"wiring"),
     "Switchboards, sockets and wiring carry mains power. Leave them "
     "to a handyman.",
     "This needs a handyman.",
     "electrician"),
    ("ev-battery",
     _rx(r"electric (?:scooter|bike|vehicle|car)", r"\bev\b", r"e-?scooter",
         r"e-?bike", r"lithium (?:battery|pack)", r"battery pack"),
     "An electric vehicle's battery is high voltage and can catch "
     "fire. Let a handyman handle it.",
     "EV batteries need a handyman.",
     "EV service centre"),
    ("tv-display",
     _rx(r"\btv\b", r"television", r"\bcrt\b", r"monitor"),
     "A TV or monitor holds high-voltage parts that stay charged. Let "
     "a handyman open it.",
     "TVs are a job for a handyman.",
     "TV repair"),
]


def scan_check(machine: str = "", issue: str = "") -> dict | None:
    """Warn before diagnosis: the machine itself, or a danger symptom the
    owner reported. None when nothing fires.

    {"rule", "title", "spoken", "trade"}: the walkthrough's verdict uses
    the same shape.
    """
    job = Job(machine or "", issue or "", [])
    for rule in RULES:
        if rule.symptom and rule.applies(job) and rule.symptom(job.issue):
            return {"rule": rule.id, "title": rule.title,
                    "spoken": rule.spoken, "trade": rule.trade}
    for rid, rx, title, spoken, trade in MACHINES:
        if rx.search(job.context):
            return {"rule": rid, "title": title, "spoken": spoken,
                    "trade": trade}
    return None
