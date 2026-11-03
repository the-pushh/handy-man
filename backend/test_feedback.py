"""The feedback loop's store on a throwaway SQLite file (no model calls).

    python backend/test_feedback.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import feedback  # noqa: E402


def fresh() -> None:
    """An empty store: a new SQLite file, or with TEST_DATABASE_URL set
    (a throwaway Postgres), the same tests against real Postgres."""
    pg = os.environ.get("TEST_DATABASE_URL")
    os.environ["DATABASE_URL"] = pg or f"sqlite:///{tempfile.mkdtemp()}/fb.db"
    feedback._conn = None
    feedback._cache.clear()
    if pg:
        feedback._run("DROP TABLE IF EXISTS feedback")
        feedback._conn = None


def run(i, **kw):
    base = {"id": f"run-{i:04d}", "machine": "air conditioner", "said": "the AC is not cooling",
            "finding": "Looks like clogged filters.", "verdict": "diy", "outcome": "fixed"}
    base.update(kw)
    return feedback.record(base)


def test_keys_group_the_same_thing():
    assert feedback.machine_key("AC", "") == "air conditioner"
    assert feedback.machine_key("", "fridge thanda nahi kar raha") == "refrigerator"
    assert feedback.symptom_key("fridge thanda nahi kar raha") == "not cooling"
    assert feedback.symptom_key("washing machine makes a banging noise") == "noise"
    assert feedback.cause_key("Looks like clogged filters.") == feedback.cause_key("Looks like dirty filter.")
    assert feedback.cause_key("Most likely weak battery (82%).") == "drained battery"


def test_off_without_a_database():
    os.environ.pop("DATABASE_URL", None)
    feedback._conn = None
    assert feedback.record({"id": "run-0001"}) == {"status": "off"}
    assert feedback.priors_text("AC", "not cooling") == ""


def test_counts_need_three_confirmations():
    fresh()
    for i in range(2):
        run(i)
    assert feedback.confirmed_causes("AC", "not cooling") == []
    run(2, finding="Looks like dirty filter.")
    assert feedback.confirmed_causes("AC", "air not cold") == [("dirty filter", 3)]
    text = feedback.priors_text("air conditioner", "the air is not cold")
    assert "dirty filter (3)" in text and "base rates" in text, text


def test_only_confirmed_fixes_count():
    fresh()
    for i in range(3):
        run(i, finding="Looks like low gas.", outcome="handyman")
    for i in range(3, 6):
        run(i, finding="Looks like low gas.", outcome="fixed", confirmed=False)
    assert feedback.confirmed_causes("AC", "not cooling") == []


def test_a_run_updates_in_place():
    fresh()
    run(1, outcome="", finding="Looks like dirty filter.")
    run(1, outcome="still broken")
    rows = feedback._run("SELECT COUNT(*), MAX(outcome) FROM feedback", fetch=True)
    assert rows[0] == (1, "still broken"), rows


def test_bad_input_is_refused():
    fresh()
    assert feedback.record({"id": "x"})["status"] == "bad-id"
    assert feedback.record({"id": "run-0009", "outcome": "drop table"})["status"] == "bad-outcome"


def test_misses_become_test_cases():
    fresh()
    run(1, finding="Looks like dirty filter.", outcome="still broken")
    run(2, parent_id="run-0001", finding="Looks like low gas.", outcome="fixed")
    m = feedback.misses()
    assert len(m) == 1 and m[0]["wrong"].endswith("dirty filter.") and "low gas" in m[0]["right"], m



def test_confirmed_examples_and_quick_fixes_are_learned():
    fresh()
    run(1, finding="Looks like dirty filter.", confirmed=True, fixed_by="all 3 steps")
    text = feedback.priors_text("AC", "the AC is not cooling")
    assert "Recent confirmed cases like this" in text and "dirty filter" in text, text
    for i in range(2, 4):
        run(i, outcome="fixed by quick check", finding="", fixed_by="Set mode to Cool")
    assert feedback.quick_fixes("AC", "AC not cooling") == [("Set mode to Cool", 2)]
    assert "Set mode to Cool (2)" in feedback.quick_fix_text("AC", "AC not cooling")


def test_history_per_browser():
    from backend import history_store as h
    fresh()
    a, b = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
    h.put_run(a, "run-0001", {"id": "run-0001", "device": "AC", "pros": [{"name": "Cool Care"}]})
    h.put_media(a, "run-0001", "step0", "image/jpeg", b"\xff\xd8jpeg")
    assert h.list_runs(a)[0]["pros"][0]["name"] == "Cool Care"
    assert h.get_media(a, "run-0001", "step0") == ("image/jpeg", b"\xff\xd8jpeg")
    assert h.list_runs(b) == [] and h.get_media(b, "run-0001", "step0") is None
    for bad in (lambda: h.put_run("not-a-uuid", "run-0001", {}),
                lambda: h.put_media(a, "run-0001", "../etc", "image/jpeg", b"x"),
                lambda: h.put_media(a, "run-0001", "step1", "text/html", b"x"),
                lambda: h.put_media(a, "run-0001", "step1", "image/jpeg", b"x" * (h.MAX_MEDIA + 1))):
        try:
            bad()
            raise AssertionError("not refused")
        except h.Refused:
            pass
    run(9, user_id=a)
    h.delete_all(a)
    assert h.list_runs(a) == [] and h.get_media(a, "run-0001", "step0") is None
    left = feedback._run("SELECT COUNT(*) FROM feedback WHERE user_id = ?", (a,), fetch=True)
    assert left[0][0] == 0, left

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} passed")
