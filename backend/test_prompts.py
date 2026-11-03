"""Prompt assembly, with every optional part on and off (no model calls).

A broken concatenation in a prompt passes lint and only fails at run
time, on every diagnosis; this builds each prompt and stops before the
network.

    python backend/test_prompts.py
"""

import itertools
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("MUSE_SPARK_API_URL", "https://example.invalid/v1")
os.environ.setdefault("MUSE_SPARK_API_KEY", "test-placeholder")

from backend import agent, spark  # noqa: E402

seen = []


def fake_complete(url, key, payload, required, purpose="spark", image=None):
    msgs = payload["messages"]
    text = " ".join(m["content"] if isinstance(m["content"], str)
                    else " ".join(p.get("text", "") for p in m["content"]) for m in msgs)
    seen.append(text)
    return {k: [] for k in required} | {"steps": [], "causes": [], "relevant": [],
                                        "hypotheses": [{"cause": "x", "p": 1}],
                                        "action": {"tool": "ask_user", "question": "q?"}}


def test_diagnose_every_combination():
    spark._complete = fake_complete
    for priors, sound, answers, markings in itertools.product(
            ("", "Confirmed causes: dirty filter (3)."), ("", "3 beeps"),
            ("", "Weak airflow."), (None, ["MODEL X1"])):
        seen.clear()
        spark.diagnose("air conditioner", None, ["front panel"], "not cooling", sound=sound,
                       answers=answers, markings=markings, priors=priors)
        assert seen and "not cooling" in seen[0]
        assert (priors in seen[0]) if priors else True


def test_agent_step_prompts():
    spark._complete = fake_complete
    from backend import feedback
    feedback.priors_text = lambda m, s: "Confirmed causes: dirty filter (3)."
    seen.clear()
    agent.step("air conditioner", "not cooling")
    assert "dirty filter (3)" in seen[0]
    seen.clear()
    agent.step("air conditioner", "not cooling", hypotheses=[{"cause": "x", "p": 0.5}],
               history=[{"action": {"tool": "ask_user", "question": "q?"}, "result": "yes"}])
    assert "Tests so far" in seen[0]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} passed")
