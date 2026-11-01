"""Rate-limit window (backend/limits.py).

Run: .venv/bin/python backend/test_limits.py   (or pytest)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from limits import Window, wait_text  # noqa: E402


def test_allows_up_to_the_limit_then_waits():
    w = Window(3, 3600)
    assert [w.take("ip", now=t) for t in (0, 1, 2)] == [0, 0, 0]
    wait = w.take("ip", now=3)
    assert 3590 <= wait <= 3600


def test_window_slides():
    w = Window(2, 60)
    w.take("ip", now=0)
    w.take("ip", now=10)
    assert w.take("ip", now=30) > 0
    assert w.take("ip", now=61) == 0  # the first hit has aged out


def test_keys_are_separate():
    w = Window(1, 60)
    assert w.take("a", now=0) == 0
    assert w.take("b", now=0) == 0
    assert w.take("a", now=1) > 0


def test_zero_disables():
    w = Window(0, 60)
    assert all(w.take("ip", now=t) == 0 for t in range(100))


def test_wait_text():
    assert wait_text(30) == "1 minute"
    assert wait_text(600) == "10 minutes"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"\n{len(tests)} passed")
