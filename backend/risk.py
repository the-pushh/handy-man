"""Appliance-based risk gate.

assess_risk() classifies a job from the detected device plus the user's
issue text. High-risk jobs (mains voltage, water + electricity, gas,
charged capacitors) must pass a blocking warning sheet in the app:
offer a handyman, or continue only on the user's explicit
"I proceed at my own risk" tap, which is logged in the transcript.

Levels are deliberately binary: "high" blocks, "standard" does not.
A high call costs one extra tap, so ambiguous appliances fail closed.
"""

# (keywords, hazard code, reason). Keywords match against the
# lowercased "device + issue" string.
RISK_RULES = [
    (("switchboard", "mcb", "distribution box", "mains panel",
       "breaker panel", "fuse box", "meter box", "switch board"),
     "mains-voltage",
     "This involves mains voltage. One wrong touch can kill."),
    (("geyser", "water heater", "immersion rod"),
     "water-and-electricity",
     "This mixes water and electricity. Never open it live."),
    (("gas stove", "gas pipeline", "lpg", "cylinder", "gas leak",
       "gas pipe"),
     "gas",
     "This involves cooking gas. A leak or spark can explode."),
    (("microwave", "microwave oven"),
     "charged-capacitor",
     "A microwave holds a lethal charge even when unplugged."),
    (("air conditioner", "split ac", "window ac", "outdoor unit",
       "compressor"),
     "mains-and-capacitor",
     "This involves mains power and charged capacitors."),
    # Symptom triggers: dangerous whatever the appliance is.
    (("spark", "sparking", "burning smell", "smoke", "electric shock",
       "shock", "current leak", "melted wire", "burnt wire"),
     "danger-symptom",
     "There are signs of danger: sparks, burning or shock. "
     "Treat this as live and dangerous."),
]

STANDARD = {"level": "standard", "hazard": "", "reason": ""}


def assess_risk(device: str = "", issue: str = "") -> dict:
    """Return {"level", "hazard", "reason"} for a device + issue pair."""
    haystack = f"{device or ''} {issue or ''}".lower()
    for keywords, hazard, reason in RISK_RULES:
        if any(k in haystack for k in keywords):
            return {"level": "high", "hazard": hazard, "reason": reason}
    return dict(STANDARD)
