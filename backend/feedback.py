"""Outcome feedback: what happened after each run, from owners who opted in.

The loop (experimental, branch feat/agent-loop):
  1. record   the phone sends a run's outcome when the owner ticked
              "Help improve Handyman" (text only: machine, words, tests,
              answers, finding, verdict, outcome; never photos, sound,
              location or IP). One row per run, updated as it ends.
  2. learn    confirmed causes are counted per machine and symptom, and
              the counts go to the agent's first look and the first
              diagnosis pass as base rates ("past AC not-cooling cases:
              dirty filter 14, low gas 3"). A cause needs MIN_CONFIRMED
              confirmations before it is used; the safety rules never
              read this data.
  3. test     misses (a run that ended "still broken" and a later run on
              the same machine that fixed it another way) export as test
              cases for eval/suite.py (eval/from_feedback.py).

The weights of Meta's models are not changed (the API serves them, it
does not train them); the system around the model learns.

Storage: DATABASE_URL. postgres://... (Vercel Postgres / Neon, the
deployed backend) or sqlite:///path (local tests). Unset: everything
here is a no-op and the app behaves as before.
"""

import json
import os
import re
import threading
import time

MIN_CONFIRMED = 3
_lock = threading.Lock()
_conn = None
_cache: dict = {}
CACHE_S = 300

SCHEMA = ["""
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parent_id TEXT,
  machine TEXT,
  machine_key TEXT,
  said TEXT,
  symptom_key TEXT,
  route TEXT,
  finding TEXT,
  cause_key TEXT,
  verdict TEXT,
  rule TEXT,
  outcome TEXT,
  fixed_by TEXT,
  confirmed INTEGER,
  recheck TEXT,
  tests TEXT,
  answers TEXT,
  app TEXT
)
""", """
CREATE TABLE IF NOT EXISTS history_runs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  job TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
)
""", """
CREATE TABLE IF NOT EXISTS history_media (
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (user_id, run_id, kind)
)
"""]

OUTCOMES = ("fixed", "still broken", "handyman", "fixed by quick check")


def url() -> str:
    return (os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or "").strip()


def enabled() -> bool:
    return bool(url())


def _connect():
    global _conn
    if _conn is not None:
        return _conn
    u = url()
    if u.startswith("sqlite:///"):
        import sqlite3
        _conn = sqlite3.connect(u[len("sqlite:///"):], check_same_thread=False)
    else:
        import psycopg
        _conn = psycopg.connect(u, autocommit=True, connect_timeout=5)
    cur = _conn.cursor()
    for stmt in SCHEMA:
        cur.execute(stmt)
    if hasattr(_conn, "commit"):
        _conn.commit()
    return _conn


def _sql(q: str) -> str:
    """One query text for both drivers: ? for sqlite, %s for psycopg."""
    return q if url().startswith("sqlite:///") else q.replace("?", "%s")


def _run(q: str, args: tuple = (), fetch: bool = False):
    global _conn
    with _lock:
        for attempt in range(2):
            try:
                cur = _connect().cursor()
                cur.execute(_sql(q), args)
                rows = cur.fetchall() if fetch else None
                if url().startswith("sqlite:///"):
                    _conn.commit()
                return rows
            except Exception:
                # A dropped Postgres connection: reconnect once.
                _conn = None
                if attempt:
                    raise


# --- Keys: group runs about the same thing -------------------------------
MACHINES = [
    ("air conditioner", r"\bac\b|air ?con|split|window ac"),
    ("refrigerator", r"fridge|refrigerat|freezer"),
    ("washing machine", r"washing|washer|front ?load|top ?load"),
    ("inverter", r"inverter|ups\b"),
    ("laptop", r"laptop|notebook|macbook"),
    ("phone", r"phone|mobile|iphone|android"),
    ("scooter", r"scooter|activa|scooty|moped"),
    ("car", r"\bcar\b|hatchback|sedan|suv"),
    ("ceiling fan", r"\bfan\b"),
    ("water purifier", r"purifier|\bro\b"),
    ("printer", r"printer"),
    ("router", r"router|wi-?fi|modem"),
]

SYMPTOMS = [
    ("not cooling", r"not cool|warm air|not cold|thanda nahi|no cooling"),
    ("not heating", r"not heat|cold water|no hot"),
    ("won't start", r"won'?t (?:start|turn on|switch on)|not (?:starting|turning on|working)|dead|no power|kharab"),
    ("not charging", r"not charg|won'?t charge|doesn'?t charge"),
    ("beeping", r"beep"),
    ("noise", r"noise|banging|grinding|rattl|hum|click|squeal"),
    ("leak", r"leak|drip|tapak|water (?:on|under|from)"),
    ("smell or smoke", r"smell|smoke|burn|spark"),
    ("slow or weak", r"slow|weak|low (?:speed|pressure|suction)|faded|faint"),
    ("disconnects", r"disconnect|drops|keeps (?:cutting|going)"),
]


def machine_key(machine: str, said: str = "") -> str:
    m = (machine or "").lower()
    for key, rx in MACHINES:
        if re.search(rx, m):
            return key
    for key, rx in MACHINES:
        if re.search(rx, (said or "").lower()):
            return key
    return m.strip() or "unknown"


def symptom_key(said: str) -> str:
    s = (said or "").lower()
    for key, rx in SYMPTOMS:
        if re.search(rx, s):
            return key
    return "other"


_SAME = {"clogged": "dirty", "blocked": "dirty", "dusty": "dirty", "choked": "dirty",
         "flat": "drained", "dead": "drained", "discharged": "drained", "weak": "drained",
         "faulty": "failed", "broken": "failed", "bad": "failed", "worn": "failed"}


def cause_key(finding: str) -> str:
    """'Looks like clogged filters.' -> 'dirty filter'."""
    t = re.sub(r"^(?:looks like|most likely|probably)\s+", "", (finding or "").lower().strip())
    t = re.sub(r"\(\d+%\)|[^a-z ]", " ", t)
    words = [w for w in t.split() if w not in ("a", "an", "the", "is", "of", "on", "in")]
    words = [_SAME.get(w, w) for w in words]
    words = [w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w for w in words]
    return " ".join(words[:5])


# --- 1. Record -------------------------------------------------------------
def _txt(v, n: int) -> str:
    return (v if isinstance(v, str) else json.dumps(v or ""))[:n]


def record(run: dict) -> dict:
    """Insert or update one run (by the phone's run id)."""
    if not enabled():
        return {"status": "off"}
    rid = str(run.get("id") or "")[:64]
    outcome = str(run.get("outcome") or "")[:40]
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", rid):
        return {"status": "bad-id"}
    if outcome and outcome not in OUTCOMES:
        return {"status": "bad-outcome"}
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    machine = _txt(run.get("machine"), 80)
    said = _txt(run.get("said"), 300)
    finding = _txt(run.get("finding"), 200)
    confirmed = run.get("confirmed")
    row = (now, _txt(run.get("user_id"), 64) or None, _txt(run.get("parent_id"), 64) or None, machine, machine_key(machine, said), said,
           symptom_key(said), _txt(run.get("route"), 40), finding, cause_key(finding),
           _txt(run.get("verdict"), 10), _txt(run.get("rule"), 40), outcome or None,
           _txt(run.get("fixed_by"), 200), None if confirmed is None else int(bool(confirmed)),
           _txt(run.get("recheck"), 300), _txt(run.get("tests"), 4000), _txt(run.get("answers"), 2000),
           _txt(run.get("app"), 40))
    cols = ("updated_at, user_id, parent_id, machine, machine_key, said, symptom_key, route, finding, "
            "cause_key, verdict, rule, outcome, fixed_by, confirmed, recheck, tests, answers, app")
    sets = ", ".join(f"{c.strip()} = excluded.{c.strip()}" for c in cols.split(","))
    _run(f"INSERT INTO feedback (id, created_at, {cols}) VALUES (?, ?, {', '.join('?' * len(row))}) "
         f"ON CONFLICT (id) DO UPDATE SET {sets}", (rid, now) + row)
    _cache.clear()
    return {"status": "ok"}


# --- 2. Learn --------------------------------------------------------------
def confirmed_causes(machine: str, said: str, limit: int = 5) -> list:
    """[(cause, count)] confirmed for this machine and symptom, most
    common first; only causes with MIN_CONFIRMED or more."""
    if not enabled():
        return []
    key = (machine_key(machine, said), symptom_key(said))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    try:
        rows = _run(
            "SELECT cause_key, COUNT(*) AS n FROM feedback WHERE machine_key = ? AND symptom_key = ? "
            "AND cause_key <> '' AND (confirmed = 1 OR (confirmed IS NULL AND outcome = 'fixed')) "
            "GROUP BY cause_key HAVING COUNT(*) >= ? ORDER BY n DESC LIMIT ?",
            (key[0], key[1], MIN_CONFIRMED, limit), fetch=True) or []
    except Exception:
        rows = []  # the loop never blocks a diagnosis
    out = [(r[0], int(r[1])) for r in rows]
    _cache[key] = (time.time(), out)
    return out


def similar_cases(machine: str, said: str, k: int = 3) -> list:
    """Recent runs like this one that the owner confirmed ("Was it ...?
    Yes"): their words, finding and what fixed it, as worked examples."""
    if not enabled():
        return []
    try:
        rows = _run(
            "SELECT said, finding, fixed_by FROM feedback WHERE machine_key = ? AND symptom_key = ? "
            "AND confirmed = 1 AND outcome = 'fixed' AND finding <> '' "
            "ORDER BY updated_at DESC LIMIT ?",
            (machine_key(machine, said), symptom_key(said), k), fetch=True) or []
    except Exception:
        return []
    return [{"said": r[0], "finding": r[1], "fixed_by": r[2]} for r in rows]


def priors_text(machine: str, said: str) -> str:
    """Learned context for the model (counts of confirmed causes, then a
    few confirmed examples), or "" when there is nothing yet."""
    k = machine_key(machine, said)
    s = symptom_key(said)
    parts = []
    causes = confirmed_causes(machine, said)
    if causes:
        parts.append(f"Confirmed causes in past {k} '{s}' cases that owners fixed: "
                     + ", ".join(f"{c} ({n})" for c, n in causes) + ".")
    examples = similar_cases(machine, said)
    if examples:
        parts.append("Recent confirmed cases like this: " + " | ".join(
            f"owner said \"{e['said'][:80]}\", it was {cause_key(e['finding'])}"
            + (f", fixed by {e['fixed_by'][:60]}" if e["fixed_by"] else "") for e in examples) + ".")
    if not parts:
        return ""
    return " ".join(parts) + " Use these as base rates; the evidence in front of you still decides."


def quick_fixes(machine: str, said: str, limit: int = 4) -> list:
    """[(quick check, times it fixed this machine and symptom)]."""
    if not enabled():
        return []
    try:
        rows = _run(
            "SELECT fixed_by, COUNT(*) AS n FROM feedback WHERE machine_key = ? AND symptom_key = ? "
            "AND outcome = 'fixed by quick check' AND fixed_by <> '' "
            "GROUP BY fixed_by HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT ?",
            (machine_key(machine, said), symptom_key(said), limit), fetch=True) or []
    except Exception:
        return []
    return [(r[0], int(r[1])) for r in rows]


def quick_fix_text(machine: str, said: str) -> str:
    fixes = quick_fixes(machine, said)
    if not fixes:
        return ""
    return ("Quick checks that fixed this before for other owners (list a check like these "
            "first if it fits): " + "; ".join(f"{c} ({n})" for c, n in fixes) + ".")


# --- 3. Test ---------------------------------------------------------------
def misses(limit: int = 200) -> list:
    """Runs that ended 'still broken' whose follow-up run fixed it with a
    different finding: the wrong and the right answer, as test cases."""
    if not enabled():
        return []
    rows = _run(
        "SELECT a.machine, a.said, a.finding, b.finding, b.answers, b.tests, b.fixed_by "
        "FROM feedback a JOIN feedback b ON b.parent_id = a.id "
        "WHERE a.outcome = 'still broken' AND b.outcome = 'fixed' AND a.cause_key <> b.cause_key "
        "ORDER BY b.updated_at DESC LIMIT ?", (limit,), fetch=True) or []
    return [{"machine": r[0], "said": r[1], "wrong": r[2], "right": r[3], "answers": r[4],
             "tests": r[5], "fixed_by": r[6]} for r in rows]
