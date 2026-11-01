"""Muse Wonder (muse-wonder-1.0): hears the raw clip as a cross-check.

Same gateway, /responses with an input_audio part (WAV, base64).
Measured 2026-11-01 on 3s synthetic beep clips: minimal effort answers
in ~4s and counted beeps right 4/4; default effort is "max" (12-28s)
and miscounted 2/4. It times beeps poorly, so only its COUNT is
compared with the deterministic features (backend/audiofeat.py).
"""

import base64
import json
import os
import re
import urllib.error
import urllib.request

from . import trace

MODEL_ID = "muse-wonder-1.0"
PROMPT = ('Listen to this clip. Reply with only JSON: {"beeps": <number of '
          'distinct beeps>, "clicks": <number of short clicks>, "sound": '
          '"<what the sound most likely is, max 8 words>"}')


HEDGE_AFTER_S = 7.0  # usual 4-5s; a gateway tail once took 10.9s


def listen(wav: bytes) -> dict:
    """{"beeps": int | None, "clicks": int | None, "sound": str}.

    Hedged: if the first request has not answered in HEDGE_AFTER_S, a
    second identical one starts and the first answer wins.
    """
    from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = trace.run_in(pool, _listen_once, wav, "")
        done, _ = wait([first], timeout=HEDGE_AFTER_S)
        if done:
            return first.result()
        second = trace.run_in(pool, _listen_once, wav, " (hedge)")
        pending = {first, second}
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in done:
                if fut.exception() is None:
                    return fut.result()
        return first.result()
    finally:
        pool.shutdown(wait=False)


def _listen_once(wav: bytes, tag: str) -> dict:
    url = os.environ.get("MUSE_SPARK_API_URL", "").rstrip("/")
    key = os.environ.get("MUSE_SPARK_API_KEY", "")
    if not url or not key:
        raise RuntimeError("Model API is not configured.")
    payload = {
        "model": MODEL_ID,
        "reasoning": {"effort": "minimal"},
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": PROMPT},
            {"type": "input_audio", "input_audio": {
                "data": base64.b64encode(wav).decode(), "format": "wav"}},
        ]}],
    }
    req = urllib.request.Request(
        url + "/responses", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"})
    with trace.call(MODEL_ID, "listen: count beeps and clicks" + tag) as rec:
        rec["effort"] = "minimal"
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                reply = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Muse Wonder API error {exc.code}: "
                               f"{exc.read().decode(errors='replace')[:300]}")
        rec["usage"] = reply.get("usage")
        text = "".join(
            p.get("text") or "" for o in reply.get("output", [])
            if o.get("type") == "message" for p in o.get("content", []))
        rec["raw_text"] = text[:600]
        m = re.search(r"\{.*\}", text, re.S)
        try:
            parsed = json.loads(m.group(0)) if m else {}
        except json.JSONDecodeError:
            parsed = {}

        def num(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
        out = {"beeps": num(parsed.get("beeps")),
               "clicks": num(parsed.get("clicks")),
               "sound": str(parsed.get("sound") or "").strip()[:80]}
        rec["parsed"] = out
        return out
