"""Agent loop rules that need no model: probabilities, the soft-evidence
cap, the safety check on a proposed test, stop and fallback decisions.

    python backend/test_agent.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import agent  # noqa: E402


def test_hypotheses_normalised_and_sorted():
    h = agent._hypotheses([{"cause": "a", "p": 2}, {"cause": "b", "p": 6},
                           {"cause": "B", "p": 1}, {"cause": "", "p": 1}])
    assert [x["cause"] for x in h] == ["b", "a"], h
    assert abs(sum(x["p"] for x in h) - 1) < 0.01


def test_soft_answers_capped_until_three_tests():
    hyps = [{"cause": "weak battery", "p": 0.85}, {"cause": "relay", "p": 0.15}]
    asked = [{"action": {"tool": "ask_user"}, "result": "click"}]
    capped = agent._calibrated(hyps, asked * 2)
    assert capped[0]["p"] == agent.CONFIDENT, capped
    assert abs(sum(x["p"] for x in capped) - 1) < 0.01
    # Three answers, or any photo or measurement, lift the cap.
    assert agent._calibrated(hyps, asked * 3)[0]["p"] == 0.85
    looked = [{"action": {"tool": "look_closer"}, "result": "dusty"}]
    assert agent._calibrated(hyps, looked)[0]["p"] == 0.85


def test_scooter_battery_behind_panel_is_blocked():
    a = {"tool": "look_closer", "part": "battery", "how": "remove the floor panel and battery cover"}
    b = agent._blocked("scooter", "self start not working", a)
    assert b and b["rule"] == "vehicle-body-panel", b


def test_owner_jobs_are_not_blocked():
    ac = {"tool": "look_closer", "part": "air filters", "how": "lift the front panel flap"}
    assert agent._blocked("air conditioner", "not cooling", ac) is None
    q = {"tool": "ask_user", "question": "Is the horn weak?", "how": ""}
    assert agent._blocked("scooter", "self start not working", q) is None
    assert agent._blocked("inverter", "beeping", {"tool": "listen"}) is None


def test_action_validation():
    assert agent._action({"tool": "ask_user", "question": "Q?"})["options"] == ["Yes", "No"]
    assert agent._action({"tool": "look_closer"}) is None  # no part
    assert agent._action({"tool": "open_it", "part": "x"}) is None


def test_findings_names_the_top_cause():
    text = agent.findings("an AC", [{"cause": "dirty filters", "p": 0.82},
                                    {"cause": "low gas", "p": 0.18}],
                          [{"action": {"tool": "look_closer", "part": "filters"},
                            "result": "thick dust"}])
    assert "dirty filters (82%)" in text and "thick dust" in text, text


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} passed")
