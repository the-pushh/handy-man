"""Boundaries of the safety rules (backend/risk.py).

Run: .venv/bin/python -m pytest backend/test_risk.py
 or: .venv/bin/python backend/test_risk.py   (no pytest needed)

Each case is a device, the user's issue and the steps a model might
propose. The rules decide: owner jobs stay "diy", forcing rules give
"pro" and name the rule in plain words.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from risk import judge  # noqa: E402


def step(check, how=""):
    return {"check": check, "how": how, "part": None, "caution": None}


def expect(v, verdict, rule=None, allowed=None):
    assert v["verdict"] == verdict, v
    if rule:
        assert v["rule"] == rule, v
    if verdict == "pro":
        assert v["title"] and v["spoken"] and v["trade"], v
    if allowed is not None:
        assert v["allowed_steps"] == allowed, v


# --- The eight boundaries ------------------------------------------------

def test_ac_filter_is_owner_maintenance():
    v = judge("LG split air conditioner", "AC is not cooling", [
        step("Air filter", "Lift the front panel and slide out both air filters"),
        step("Wash filter", "Rinse the filters under the tap, dry them, slide them back"),
        step("Re-check", "Close the front panel, run cool mode for 10 minutes"),
    ])
    expect(v, "diy", allowed=[0, 1, 2])


def test_ac_casing_is_pro():
    v = judge("split AC indoor unit", "not cooling", [
        step("Air filter", "Lift the front panel and check the filters"),
        step("Coil", "Unscrew the indoor unit casing and inspect the coil"),
    ])
    expect(v, "pro", "sealed-casing", allowed=[0])
    assert v["trade"] == "AC technician"


def test_ac_outdoor_unit_is_pro():
    v = judge("split air conditioner", "not cooling", [
        step("Outdoor unit", "Open the outdoor unit cover and check the capacitor"),
    ])
    expect(v, "pro")


def test_scooter_battery_terminals_are_pro():
    v = judge("Honda Activa scooter", "self start dead", [
        step("Battery", "Tighten the battery terminals with a spanner"),
    ])
    expect(v, "pro", "battery-terminals")
    assert v["trade"] == "two-wheeler mechanic"


def test_scooter_side_panel_is_pro():
    v = judge("Honda Activa scooter", "self start dead", [
        step("Battery", "Open the side panel to reach the battery"),
    ])
    expect(v, "pro", "vehicle-body-panel")
    assert v["title"] == "Opening the scooter's panel needs a mechanic."


def test_inverter_float_check_is_owner_job():
    v = judge("Luminous inverter with tubular battery", "inverter beeping", [
        step("Water level", "Look at the water-level floats on top of the battery"),
        step("Top up", "If a float is low, open its vent cap and top up with distilled water"),
    ])
    expect(v, "diy", allowed=[0, 1])


def test_inverter_terminals_are_pro():
    v = judge("inverter battery", "inverter beeping", [
        step("Float", "Look at the water-level floats"),
        step("Terminals", "Clean the white corrosion off the battery terminals"),
    ])
    expect(v, "pro", "battery-terminals", allowed=[0])
    assert v["trade"] == "inverter / battery service"


def test_laptop_ram_swap_is_owner_job():
    v = judge("Lenovo ThinkPad laptop", "want more memory", [
        step("Base cover", "Remove the bottom panel screws and lift off the base cover"),
        step("RAM", "Release the clips and swap the RAM stick for the new one"),
    ])
    expect(v, "diy", allowed=[0, 1])


def test_swollen_laptop_battery_is_pro():
    v = judge("laptop", "battery is swollen and the trackpad is bulging", [
        step("Base cover", "Remove the bottom panel screws"),
    ])
    expect(v, "pro", "swollen-battery", allowed=[])


# --- Spark's real scooter proposal (prod, 2026-11-01) is overridden ------

SPARK_SCOOTER_STEPS = [
    step("Side stand and kill switch cutoff",
         "Fold side stand fully up, flip kill switch to RUN, hold brake lever then press start button"),
    step("Brake lever interlock",
         "Squeeze left brake lever fully then right brake lever fully while pressing start button"),
    step("Start button condition",
         "With kill switch on RUN press start button firmly 5 times, wiggle start button while holding brake lever"),
    step("Battery check via horn button and side panel",
         "Press horn button with key ON; if weak, open side panel using plastic tool, check battery terminals tight and dry"),
    step("Final no-crank verification",
         "If still no crank, stop and call a professional"),
]


def test_spark_scooter_proposal_is_overridden():
    v = judge("Honda Activa", "self start dead, kick start works",
              SPARK_SCOOTER_STEPS)
    expect(v, "pro", "vehicle-body-panel", allowed=[0, 1, 2])
    assert v["blocked_step"] == 3
    assert "battery-terminals" in v["fired"]
    assert v["title"] == "Opening the scooter's panel needs a mechanic."


# --- Other forcing rules -------------------------------------------------

def test_danger_symptom_stops_everything():
    v = judge("table fan", "sparking and a burning smell", [step("Look", "Check the blades")])
    expect(v, "pro", "danger-symptom", allowed=[])


def test_mains_wiring_is_pro():
    v = judge("ceiling fan", "not spinning", [step("Wiring", "Open the switchboard and tighten the loose wire")])
    expect(v, "pro", "mains-electricity")


def test_gas_fitting_is_pro():
    v = judge("gas stove", "yellow flame", [step("Regulator", "Remove the regulator and clean it")])
    expect(v, "pro", "gas-fittings")


def test_model_caution_text_does_not_fire_symptoms():
    v = judge("split AC", "not cooling",
              [step("Filter", "Lift the front panel and wash the filters")],
              causes=["electric shock risk if opened while on"])
    expect(v, "diy")


def test_looking_at_terminals_is_allowed():
    v = judge("inverter battery", "beeping",
              [step("Terminals", "Look at the terminals for white powder")])
    expect(v, "diy")


def test_any_contact_with_terminals_is_pro():
    v = judge("inverter battery", "beeping",
              [step("Terminals", "Look at the terminals for white powder, without touching them")])
    # Even "without touching" mentions contact: the rule errs safe.
    expect(v, "pro", "battery-terminals")


def test_no_steps_no_risk():
    expect(judge("", "", []), "diy")


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"\n{len(tests)} passed")
