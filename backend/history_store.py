"""History on the server, per browser (no login).

One browser is one user: the phone makes a random ID once (crypto
randomUUID, kept in its localStorage) and sends it as x-handyman-user.
Under it the server keeps every run as the phone's own History record
(device, words, verdict, steps, answers, outcome, the handymen found and
who was contacted, the after-photo check) plus its small images: before
and after photos, each step's picture with the part outlined or the
illustrated highlight, and the beep clip. Enough to show History and
the shareable diagnosis on this browser, beyond the phone's 20 runs.

The phone keeps its own copy too (fast, offline); the server is the
backup and the full list. "Delete my history" removes the runs, the
media and this browser's feedback rows. Same database as backend/
feedback.py (DATABASE_URL); without one, every call is a no-op.
"""

import json
import re
import time

from .feedback import _run, enabled

USER = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
RUN = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
KIND = re.compile(r"^(?:before|after|clip|step\d{1,2})$")
MIMES = ("image/jpeg", "image/webp", "image/png", "audio/wav", "audio/x-wav", "audio/webm")
MAX_JOB = 96_000      # bytes of JSON per run
MAX_MEDIA = 600_000   # bytes per image or clip (the phone sends 320-480 px JPEGs)
MAX_RUNS = 500        # kept per browser, newest first


class Refused(ValueError):
    pass


def user_ok(user: str) -> str:
    u = (user or "").strip().lower()
    if not USER.match(u):
        raise Refused("bad user id")
    return u


def put_run(user: str, run_id: str, job: dict) -> None:
    u = user_ok(user)
    if not RUN.match(run_id or "") or not isinstance(job, dict):
        raise Refused("bad run")
    body = json.dumps(job)
    if len(body) > MAX_JOB:
        raise Refused("run too large")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _run("INSERT INTO history_runs (user_id, id, updated_at, job) VALUES (?, ?, ?, ?) "
         "ON CONFLICT (user_id, id) DO UPDATE SET updated_at = excluded.updated_at, job = excluded.job",
         (u, run_id, now, body))
    # Keep the newest MAX_RUNS per browser.
    _run("DELETE FROM history_runs WHERE user_id = ? AND id NOT IN (SELECT id FROM history_runs "
         "WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)", (u, u, MAX_RUNS))


def list_runs(user: str, limit: int = 200) -> list:
    u = user_ok(user)
    rows = _run("SELECT job FROM history_runs WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
                (u, limit), fetch=True) or []
    out = []
    for (job,) in rows:
        try:
            out.append(json.loads(job))
        except (TypeError, ValueError):
            continue
    return out


def put_media(user: str, run_id: str, kind: str, mime: str, data: bytes) -> None:
    u = user_ok(user)
    if not RUN.match(run_id or "") or not KIND.match(kind or ""):
        raise Refused("bad media key")
    mime = (mime or "").split(";")[0].strip().lower()
    if mime not in MIMES:
        raise Refused("unsupported type")
    if not data or len(data) > MAX_MEDIA:
        raise Refused("media too large")
    _run("INSERT INTO history_media (user_id, run_id, kind, mime, size, data) VALUES (?, ?, ?, ?, ?, ?) "
         "ON CONFLICT (user_id, run_id, kind) DO UPDATE SET mime = excluded.mime, size = excluded.size, "
         "data = excluded.data", (u, run_id, kind, mime, len(data), data))


def get_media(user: str, run_id: str, kind: str) -> tuple | None:
    u = user_ok(user)
    if not RUN.match(run_id or "") or not KIND.match(kind or ""):
        raise Refused("bad media key")
    rows = _run("SELECT mime, data FROM history_media WHERE user_id = ? AND run_id = ? AND kind = ?",
                (u, run_id, kind), fetch=True)
    if not rows:
        return None
    mime, data = rows[0]
    return mime, bytes(data)


def delete_all(user: str) -> None:
    u = user_ok(user)
    _run("DELETE FROM history_media WHERE user_id = ?", (u,))
    _run("DELETE FROM history_runs WHERE user_id = ?", (u,))
    _run("DELETE FROM feedback WHERE user_id = ?", (u,))


__all__ = ["enabled", "put_run", "list_runs", "put_media", "get_media", "delete_all", "Refused"]
