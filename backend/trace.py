"""Per-request trace of every model call (and other slow hops).

Each request that runs models opens a trace with begin(); every model
call inside it is wrapped in call(), which records the model id, the
purpose, wall-clock latency, token usage, an input thumbnail and the
parsed reply. The records are returned to the frontend with the
response (the trace drawer renders them) and logged to stdout:

  [trace] +0.00s  4.85s  muse-spark-1.3  perceive  ok  893/995 tok

Worker threads must run inside the request's context to land in the
same trace: submit with contextvars.copy_context().run (see run_in()).
"""

import base64
import contextvars
import io
import threading
import time
import uuid
from contextlib import contextmanager

_current: contextvars.ContextVar = contextvars.ContextVar(
    "handyman_trace", default=None)
# Set by the server's request middleware: {"path", "client"} (client is
# a short hash of the IP, never the IP itself).
request_info: contextvars.ContextVar = contextvars.ContextVar(
    "handyman_request", default=None)


class Trace:
    def __init__(self) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.t0 = time.time()
        self.calls: list = []
        self.logged = False
        self._lock = threading.Lock()

    def add(self, rec: dict) -> None:
        with self._lock:
            self.calls.append(rec)


def begin() -> Trace:
    tr = Trace()
    _current.set(tr)
    return tr


def current() -> Trace | None:
    return _current.get()


def run_in(pool, fn, *args, **kwargs):
    """pool.submit() that keeps the caller's trace in the worker thread."""
    ctx = contextvars.copy_context()
    return pool.submit(ctx.run, fn, *args, **kwargs)


def thumbnail(image_bytes: bytes, side: int = 160) -> str | None:
    """Small JPEG data URL of a model input, for the trace drawer."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img.thumbnail((side, side))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=60)
        return ("data:image/jpeg;base64,"
                + base64.b64encode(buf.getvalue()).decode())
    except Exception:
        return None


@contextmanager
def call(model: str, purpose: str, image: bytes | None = None,
         kind: str = "model"):
    """Time one call; the caller fills rec["usage"]/["parsed"] as known.

    `kind` is "model" for Meta model calls and "hop" for anything else
    (TTS synthesis, Places lookups) so the drawer can tell them apart.
    """
    tr = current()
    start = time.time()
    rec = {"id": uuid.uuid4().hex[:8], "kind": kind, "model": model,
           "purpose": purpose,
           "start_s": round(start - tr.t0, 3) if tr else 0.0,
           "latency_ms": None, "status": "ok", "usage": None,
           "input_thumb": thumbnail(image) if image else None,
           "parsed": None, "error": None}
    try:
        yield rec
    except Exception as exc:
        rec["status"] = "error"
        rec["error"] = str(exc)[:300]
        raise
    finally:
        rec["latency_ms"] = int((time.time() - start) * 1000)
        if tr:
            tr.add(rec)
        u = rec.get("usage") or {}
        tok = (f"{u.get('prompt_tokens')}/{u.get('completion_tokens')} tok"
               if u else "")
        print(f"[trace {tr.id if tr else '-'}] +{rec['start_s']:6.2f}s "
              f"{rec['latency_ms'] / 1000:6.2f}s  {model}  {purpose}  "
              f"{rec['status']}  {tok}", flush=True)


def export() -> list:
    tr = current()
    calls = list(tr.calls) if tr else []
    if tr and calls and not tr.logged:
        tr.logged = True
        log_usage(tr, calls)
    return calls


def log_usage(tr: Trace, calls: list) -> None:
    """One JSON line per request with model usage, so Cloud Logging can
    sum what a turn costs (filter: jsonPayload.kind="usage")."""
    import json

    per_model: dict = {}
    for c in calls:
        u = c.get("usage") or {}
        m = per_model.setdefault(c.get("model", "?"), {
            "calls": 0, "input_tokens": 0, "output_tokens": 0, "ms": 0})
        m["calls"] += 1
        m["input_tokens"] += int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
        m["output_tokens"] += int(u.get("completion_tokens") or u.get("output_tokens") or 0)
        m["ms"] += int(c.get("latency_ms") or 0)
    info = request_info.get() or {}
    print(json.dumps({
        "severity": "INFO", "kind": "usage", "trace": tr.id,
        "path": info.get("path"), "client": info.get("client"),
        "purposes": [c.get("purpose") for c in calls],
        "models": per_model,
        "message": f"usage {info.get('path')} " + ", ".join(
            f"{k}: {v['calls']} call(s) {v['input_tokens']}->{v['output_tokens']} tok"
            for k, v in per_model.items()),
    }), flush=True)
