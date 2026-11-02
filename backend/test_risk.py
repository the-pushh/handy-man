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
from risk import judge, scan_check  # noqa: E402


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
    assert v["trade"] == "AC technician"  # if the fix does not work


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
        step("Top up", "Open the vent cap and top up distilled water to the mark"),
    ])
    # The terminal step is blocked; the float check and top-up stay as
    # safe checks before the technician comes.
    expect(v, "pro", "battery-terminals", allowed=[0, 2])
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
    expect(v, "pro", "vehicle-body-panel", allowed=[0, 1, 2, 4])
    assert v["blocked_step"] == 3 and v["blocked_steps"] == [3]
    assert v["title"] == "Opening the scooter's panel needs a mechanic."


def test_scooter_weak_battery_finding_needs_mechanic_even_without_panel_step():
    # Spark sometimes proposes only the outside checks; the finding
    # (battery) still means the panel has to come off.
    v = judge("Honda Activa scooter", "self start dead, kick start works",
              SPARK_SCOOTER_STEPS[:3], causes=["weak battery", "brake switch"])
    expect(v, "pro", "vehicle-body-panel", allowed=[0, 1, 2])
    assert v["title"] == "Opening the scooter's panel needs a mechanic."


def test_scooter_kill_switch_finding_stays_diy():
    v = judge("Honda Activa scooter", "self start dead",
              SPARK_SCOOTER_STEPS[:2], causes=["kill switch left off", "weak battery"])
    expect(v, "diy")


def test_calling_a_pro_is_not_an_owner_action():
    v = judge("LG air conditioner", "beeping", [
        step("Expert", "if beeps continue after detector battery swap try calling a professional for AC control board test"),
        step("Expert", "Call a technician to open the casing and check the compressor"),
    ])
    expect(v, "diy")


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


def test_looking_without_touching_terminals_is_allowed():
    v = judge("inverter battery", "beeping",
              [step("Terminals", "Look at the terminals for white powder, without touching them")])
    expect(v, "diy")


def test_wiggling_terminals_is_pro():
    v = judge("inverter battery", "beeping",
              [step("Terminals", "Turn off inverter, hand-wiggle battery terminals, retighten if loose")])
    expect(v, "pro", "battery-terminals")


# Spark's real AC proposals (prod) call the AC body the "front casing".
# Working on the front panel and filter near it is still owner work.
SPARK_AC_STEPS = [
    step("front panel closure", "Press front panel shut then lift front panel to check filter seating behind front casing"),
    step("inspect front panel dust buildup", "lift front panel up from front casing and slide filters out with plastic handle, wash dry and refit"),
    step("Clear air outlet vent", "With front casing closed, wipe air outlet vent slats with dry cloth using wooden stick for dust"),
    step("Inspect front panel filter", "Unplug AC, lift front panel with plastic tool, remove filter, wash dry fully, refit under front casing"),
    step("Louver", "Power on, use remote to swing louver fully open on front casing and confirm cold air exits"),
    step("Louver angle", "Check louver on front casing is fully open and angled down for airflow"),
]


def test_spark_ac_front_casing_wording_stays_diy():
    v = judge("LG DUALCOOL air conditioner", "AC is not cooling", SPARK_AC_STEPS)
    expect(v, "diy", allowed=[0, 1, 2, 3, 4, 5])


def test_opening_the_front_casing_is_pro():
    v = judge("LG DUALCOOL air conditioner", "AC is not cooling",
              [step("Coil", "Remove the front casing screws and take off the casing")])
    expect(v, "pro", "sealed-casing")


def test_look_only_questions_pass_the_rules():
    # Diagnose's questions are screened like steps (server.py): issue
    # empty, the options as the "how".
    for ask, opts in [
        ("Which light is on the front panel?", "MAINS ON; CHARGING; OVERLOAD; LOW BATT"),
        ("Where do the battery floats sit?", "Red, below the line; Green, at the line"),
    ]:
        expect(judge("inverter battery", "", [step(ask, opts)]), "diy")


def test_hands_on_question_is_dropped():
    v = judge("inverter battery", "",
              [step("Do the battery terminals move when you wiggle them?", "Yes; No")])
    expect(v, "pro", "battery-terminals")


def test_switching_off_mains_is_safety_prep():
    v = judge("inverter battery", "inverter beeping", [
        step("Top up", "Disconnect mains and battery then add distilled water "
             "to low floats using a plastic funnel"),
        step("Still beeping", "If beeps persist, disconnect mains and battery "
             "and call a professional"),
    ])
    expect(v, "diy", allowed=[0, 1])


def test_mains_wiring_is_still_pro():
    v = judge("inverter battery", "inverter beeping",
              [step("Wiring", "Disconnect the mains wiring at the socket")])
    expect(v, "pro", "mains-electricity")


def test_ac_low_refrigerant_finding_is_pro():
    # Spark's steps were owner checks, but the finding is the sealed system.
    v = judge("Panasonic split air conditioner", "AC is not cooling",
              [step("Mode", "Check the remote is set to COOL at 24")],
              ["wrong mode setting"], finding="Looks like low refrigerant.")
    expect(v, "pro", "ac-sealed-system", allowed=[0])
    assert v["trade"] == "AC technician"


def test_ac_clogged_filter_finding_stays_diy():
    v = judge("Panasonic split air conditioner", "AC is not cooling",
              [step("Filter", "Lift the front panel and slide out the filters")],
              ["clogged filter behind front panel"], finding="Looks like a clogged filter.")
    expect(v, "diy")


def test_no_steps_no_risk():
    expect(judge("", "", []), "diy")


# --- Scan-time warnings -----------------------------------------------

def test_scan_warns_for_a_microwave():
    w = scan_check("Samsung microwave oven", "it stopped heating")
    assert w and w["rule"] == "microwave"


def test_scan_warns_for_a_geyser_and_a_switchboard():
    assert scan_check("geyser", "no hot water")["rule"] == "water-heater"
    assert scan_check("switch board", "socket not working")["rule"] == "mains-board"


def test_scan_warns_for_a_danger_symptom_on_any_machine():
    w = scan_check("air conditioner", "there is smoke coming out")
    assert w and w["rule"] == "danger-symptom"


def test_scan_lets_the_demo_machines_through():
    assert scan_check("Panasonic air conditioner", "not cooling") is None
    assert scan_check("Honda Activa scooter", "self start not working") is None
    assert scan_check("inverter", "keeps beeping") is None
    assert scan_check("laptop", "very slow") is None


def test_a_get_a_professional_step_makes_it_a_pro_job():
    v = judge("Panasonic air conditioner",
              "my AC is not cooling. Run 1 already tried: clean the filter. "
              "It is still not fixed: still blowing warm air.",
              [{"check": "filter behind front panel", "how": "wash the filter"},
               {"check": "book an AC technician to test the cooling",
                "how": "call a local AC service"}])
    assert v["verdict"] == "pro" and v["rule"] == "pro-recommended"
    assert v["trade"] == "AC technician"
    assert v["allowed_steps"] == [0]


def test_a_fallback_professional_step_stays_diy():
    # "If it still doesn't work, call a technician" is a fallback, not the
    # verdict: a vague "laptop seems broken" must not become a pro job.
    v = judge("laptop", "the laptop seems to be broken",
              [{"check": "press caps lock and watch its light", "how": "press it once"},
               {"check": "if it still doesn't power on, get a professional laptop repair",
                "how": "take it to a service centre"}])
    assert v["verdict"] == "diy", v



# --- Beyond the demo machines -----------------------------------------

def test_printer_paper_tray_is_an_owner_job():
    v = judge("printer", "printer is not printing",
              [{"check": "paper tray", "how": "open the paper tray cover and reseat the paper"}])
    assert v["verdict"] == "diy", v


def test_washer_drain_filter_flap_is_an_owner_job():
    v = judge("washing machine", "not draining",
              [{"check": "drain filter", "how": "open the drain filter flap and clean the filter"}])
    assert v["verdict"] == "diy", v


def test_scooter_battery_cover_still_needs_a_mechanic():
    v = judge("scooter", "self start not working",
              [{"check": "battery", "how": "open the battery cover under the seat"}])
    assert v["verdict"] == "pro" and v["rule"] == "vehicle-body-panel", v
    assert "scooter" in v["title"]


def test_a_car_gets_a_car_mechanic():
    v = judge("car", "car won't start", [{"check": "battery", "how": "open the battery cover"}],
              ["dead battery"], finding="Looks like dead battery.")
    assert v["trade"] == "car mechanic" and "car" in v["title"], v


def test_the_models_trade_is_used_for_machines_the_table_does_not_know():
    v = judge("bicycle", "chain slipping", [{"check": "chain", "how": "look at the chain"}],
              trade_hint="bicycle mechanic")
    assert v["verdict"] == "diy" and v["trade"] == "bicycle mechanic", v



def test_the_model_saying_the_fix_needs_a_pro_makes_it_a_pro_job():
    v = judge("microwave", "runs but food stays cold",
              [{"check": "power level setting", "how": "set power to high and test a cup of water"}],
              ["magnetron failure"], finding="Looks like a failed magnetron.",
              trade_hint="microwave repair", needs_pro=True)
    assert v["verdict"] == "pro" and v["trade"] == "microwave repair", v
    assert v["allowed_steps"] == [0]  # the safe check stays for the owner



if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"\n{len(tests)} passed")
