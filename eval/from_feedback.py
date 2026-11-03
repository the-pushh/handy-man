"""Misses from real use become test cases.

    DATABASE_URL=... .venv/bin/python -m eval.from_feedback
    SPARK_MODEL=prod .venv/bin/python -m eval.suite --feedback

A miss: a run the owner closed as "still broken" whose follow-up run on
the same machine was fixed with a different finding. Each becomes a case
whose stand-in owner knows the real cause, and which passes only when
the app now finds it. Written to eval/out/feedback_cases.json (not
committed: it holds owners' words).
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import feedback  # noqa: E402


def cases() -> list:
    def plain(t: str) -> str:
        import re
        return re.sub(r"^(?:looks like|most likely)\s+", "", (t or "").strip(), flags=re.I).rstrip(". ")

    out = []
    for i, m in enumerate(feedback.misses(), 1):
        right = feedback.cause_key(m["right"])
        words = [w for w in right.split() if len(w) > 3] or right.split()
        out.append(dict(
            id=f"R{i}", cat="From real use (past misses)", machine=m["machine"] or "machine",
            said=m["said"],
            truth=(f"The real cause, confirmed by the owner's fix, was {plain(m['right'])}. "
                   f"What the owner reported along the way: {plain(m['answers']) or 'nothing more'}. "
                   f"It was not {plain(m['wrong'])}."),
            expect=dict(headline=words[:3])))
    return out


def main() -> int:
    if not feedback.enabled():
        print("DATABASE_URL is not set: nothing to export.")
        return 1
    found = cases()
    out = ROOT / "eval" / "out" / "feedback_cases.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(found, indent=1))
    print(f"{len(found)} miss(es) -> {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
