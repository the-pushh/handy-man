"""Maintained check for the appliance risk gate (no test framework:
run with the project interpreter).

Covers: every high-risk appliance class blocks, safe appliances do
not, danger symptoms block whatever the appliance, and empty input
fails closed to standard (no invented risk).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from risk import assess_risk  # noqa: E402


def check(device, issue, want_level, want_hazard=""):
    got = assess_risk(device, issue)
    assert got["level"] == want_level, (
        f"{device!r}/{issue!r}: level {got['level']!r} != {want_level!r}")
    if want_hazard:
        assert got["hazard"] == want_hazard, (
            f"{device!r}: hazard {got['hazard']!r} != {want_hazard!r}")
    if want_level == "high":
        assert got["reason"], f"{device!r}: high risk needs a reason"
    return got


# High-risk appliance classes block.
check("switchboard", "no power in one room", "high", "mains-voltage")
check("MCB distribution box", "", "high", "mains-voltage")
check("geyser", "not heating", "high", "water-and-electricity")
check("gas stove", "flame is yellow", "high", "gas")
check("microwave oven", "stopped mid-cycle", "high", "charged-capacitor")
check("split AC", "not cooling", "high", "mains-and-capacitor")

# Danger symptoms block whatever the appliance is.
check("washing machine", "sparking and burning smell", "high", "danger-symptom")
check("table fan", "gives a shock on touch", "high", "danger-symptom")

# Ordinary appliances pass through.
check("washing machine", "door will not open", "standard")
check("table fan", "making noise", "standard")
check("laptop", "slow", "standard")

# Empty input: no invented risk, no crash.
check("", "", "standard")
check("mystery box", "", "standard")

print("risk gate: all checks pass")
