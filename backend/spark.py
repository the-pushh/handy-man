"""Muse Spark intelligence adapter (repair flow).

Config (environment):
  MUSE_SPARK_API_URL   base URL of the completions endpoint
  MUSE_SPARK_API_KEY   bearer key (paste yours; never commit it)
  SPARK_MODEL          local (default) -> muse-spark-1.3-contributor, cheap
                       prod            -> muse-spark-1.3, used for latency
                                          targets, eval and the demo
                       any other value is used as a raw model id

WIRE-FORMAT ASSUMPTION (unverified until the key lands): an
OpenAI-compatible POST {url}/chat/completions with
{"model", "messages": [{role, content: [{type: text/image_url}]}]} and a
{"choices": [{"message": {"content"}}]} reply. If the real endpoint differs,
only _post() and analyze_image()'s payload/response parsing change.
"""

import base64
import json
import os
import re
import urllib.request

from dotenv import load_dotenv

from . import trace

load_dotenv()

SPARK_MODELS = {"local": "muse-spark-1.3-contributor",
                "prod": "muse-spark-1.3"}


def active_model() -> str:
    """Resolve SPARK_MODEL (local|prod|raw id) to a gateway model id."""
    choice = (os.environ.get("SPARK_MODEL") or "local").strip()
    return SPARK_MODELS.get(choice, choice)


def _config() -> tuple:
    url = os.environ.get("MUSE_SPARK_API_URL", "").rstrip("/")
    key = os.environ.get("MUSE_SPARK_API_KEY", "")
    model = active_model()
    if not url or not key:
        raise RuntimeError(
            "Muse Spark is not configured: set MUSE_SPARK_API_URL and "
            "MUSE_SPARK_API_KEY in the environment."
        )
    return url, key, model


# Gateway tail latency: the same diagnose (same tokens) usually takes
# 5-8s but occasionally 20s+. If a call has not returned by its normal
# worst case, one identical "hedge" request is sent and whichever
# finishes first wins. Both show in the trace.
HEDGE_AFTER_S = {"perceive": 7.0, "diagnose": 8.0, "decide": 12.0,
                 "recheck": 8.0}


def _post(url: str, key: str, payload: dict, timeout: int = 120,
          purpose: str = "spark", image: bytes | None = None) -> dict:
    hedge = HEDGE_AFTER_S.get(purpose)
    if not hedge:
        return _post_once(url, key, payload, timeout, purpose, image)
    from concurrent.futures import (FIRST_COMPLETED, ThreadPoolExecutor,
                                    wait)
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        first = trace.run_in(pool, _post_once, url, key, payload, timeout,
                             purpose, image)
        done, _ = wait([first], timeout=hedge)
        if done:
            return first.result()
        second = trace.run_in(pool, _post_once, url, key, payload, timeout,
                              purpose + " (hedge)", image)
        pending = {first, second}
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for fut in done:
                if fut.exception() is None:
                    return fut.result()
        return first.result()  # both failed: raise the first error
    finally:
        pool.shutdown(wait=False)  # the slower call finishes in background


def _post_once(url: str, key: str, payload: dict, timeout: int,
               purpose: str, image: bytes | None) -> dict:
    with trace.call(payload.get("model", "?"), purpose, image) as rec:
        reply = _post_raw(url, key, payload, timeout)
        rec["usage"] = reply.get("usage")
        rec["effort"] = payload.get("reasoning_effort")
        rec["max_tokens"] = payload.get("max_tokens")
        try:
            rec["finish"] = reply["choices"][0].get("finish_reason")
            rec["raw_text"] = (reply["choices"][0]["message"]
                               .get("content") or "")[:2000]
        except (KeyError, IndexError, TypeError):
            pass
        reply["_trace"] = rec
        return reply


def _post_raw(url: str, key: str, payload: dict, timeout: int) -> dict:
    import urllib.error
    req = urllib.request.Request(
        url + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(
            f"Muse Spark API error {exc.code}: {body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Muse Spark request failed: {exc}") from exc


def _extract_json(reply: dict) -> dict:
    """Pull the JSON object out of a chat-completion reply."""
    try:
        message = reply["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(
            f"Unexpected Muse Spark reply shape ({exc}): "
            f"{json.dumps(reply)[:300]}")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        refusal = message.get("refusal") or message.get("tool_calls") or reply
        raise RuntimeError(
            "Muse Spark returned no text "
            f"(finish: {reply.get('choices', [{}])[0].get('finish_reason')}, "
            f"detail: {json.dumps(refusal)[:300]})"
        )
    try:
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", content, re.DOTALL)
    try:
        parsed = json.loads(match.group(0)) if match else {}
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, AttributeError):
        return {}


def _complete(url: str, key: str, payload: dict,
              required: list, purpose: str = "spark",
              image: bytes | None = None) -> dict:
    """POST once; retry once when the reply is cut off or drops keys.

    The contributor model sometimes truncates (finish: length) or
    returns partial JSON. The retry nudges it to complete/repair.
    """
    try:
        reply = _post(url, key, payload, purpose=purpose, image=image)
        parsed = _extract_json(reply)
        reply["_trace"]["parsed"] = parsed
        # Retry only when keys are absent (cut off / broken JSON). An
        # empty list is a valid answer, e.g. no parts in the photo.
        if all(k in parsed for k in required):
            return parsed
    except RuntimeError:
        parsed = {}
    fix = dict(payload)
    msgs = fix["messages"]
    if isinstance(msgs, list):
        reminder = ("Your last reply was cut off or missed keys. Reply "
                    "again with the COMPLETE single JSON object, all keys, "
                    "compact, starting with {.")
        if isinstance(msgs[0], dict):
            msgs = [{"role": "user", "content": reminder}] + msgs
        else:
            msgs = [reminder] + msgs
        fix["messages"] = msgs
    reply = _post(url, key, fix, purpose=purpose + " (retry)", image=image)
    parsed = _extract_json(reply)
    reply["_trace"]["parsed"] = parsed
    return parsed


def analyze_image(image_bytes: bytes, user_text: str = "",
                  model: str | None = None) -> dict:
    """Ask Muse Spark what components are in the image.

    Returns {"notes": str, "components": [{"label": str, "hint": str}]}.
    `hint` is free text Spark may add about where the part is (SAM 3.1
    does the actual locating from `label`).
    """
    url, key, default_model = _config()
    b64 = base64.b64encode(image_bytes).decode()
    prompt = (
        "You are inspecting a household appliance. Respond with "
        "a single JSON object and nothing else, with exactly these keys: "
        '{"components": [{"label": "inlet hose", "look": "black hose", '
        '"hint": "bottom left", '
        '"color": "black", "condition": "worn", '
        '"position": "bottom-left rear"}], '
        '"appliance": "water heater geyser", '
        '"appliance_look": "white cylinder", '
        '"brand": "LG or null", "model": "XQB70 or null", '
        '"details": {"serial": "abc123 or null", '
        '"color": "white", "markings": ["energy sticker top right"], '
        '"condition": "rust near bottom edge", '
        '"other": ["anything else noteworthy"]}, '
        '"ask": "question asking what the problem is"}. '
        "Read the device like a detective: brand, model, serial number, "
        "every sticker, label, badge, button icon, and printed text you "
        "can see, plus color, material, visible wear, rust, dents, or "
        "damage. Report each marking with where it sits. Null when "
        "something is not visible — never invent one. "
        "For EVERY component also report its color, its visible "
        "condition, and its position in the image. "
        "List every visible physical component with short, concrete, "
        "segmentable part names. Empty components "
        "array only if truly nothing is visible. "
        "For each component give `look`, and for the appliance "
        "`appliance_look`: "
        "1-3 plain words describing what it looks like, colour or "
        "shape plus an everyday noun, the way someone who has never "
        "seen this device would point at it. Never a trade name: "
        "'black panel' not 'display', 'green light' not 'LED', "
        "'round vent' not 'fan', 'red switch' not 'MCB', "
        "'white device' not 'inverter' (that one goes in "
        "appliance_look). "
        "Never diagnose or suggest fixes in this call. "
        "Emit compact JSON with no extra whitespace. "
        "Start your reply with { and keep it under 600 tokens."
    )
    if user_text.strip():
        prompt += f" The user reports: {user_text.strip()}"
    payload = {
        "model": model or default_model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
        "max_tokens": 4000,
        "reasoning_effort": "low",
        "response_format": {"type": "json_object"},
    }
    # Only `components` is required: a photo with no appliance in it
    # legitimately has no appliance, and retrying for one wasted ~4s.
    parsed = _complete(url, key, payload, ["components"],
                       purpose="perceive", image=image_bytes)
    raw_components = parsed.get("components", [])
    components = [{"label": str(c.get("label", "")).strip(),
                   "hint": str(c.get("hint", "")).strip(),
                   "look": str(c.get("look") or "").strip() or None,
                   "color": str(c.get("color") or "").strip() or None,
                   "condition": str(c.get("condition") or "").strip() or None,
                   "position": str(c.get("position") or "").strip() or None}
                  for c in raw_components
                  if isinstance(c, dict) and c.get("label")]
    appliance = str(parsed.get("appliance", "") or "").strip()
    notes = (f"The appliance is {appliance}." if appliance
             else "I can see the appliance.")
    ask = str(parsed.get("ask", "")).strip()
    brand = str(parsed.get("brand") or "").strip() or None
    device_model = str(parsed.get("model") or "").strip() or None
    device = " ".join([s for s in [brand, device_model] if s]) or None
    det = parsed.get("details", {})
    details = {
        "serial": str(det.get("serial") or "").strip() or None,
        "color": str(det.get("color") or "").strip() or None,
        "condition": str(det.get("condition") or "").strip() or None,
        "markings": [str(m).strip() for m in det.get("markings", [])
                     if str(m).strip()][:8],
        "other": [str(m).strip() for m in det.get("other", [])
                  if str(m).strip()][:8],
    } if isinstance(det, dict) else {
        "serial": None, "color": None, "condition": None,
        "markings": [], "other": []}
    return {"notes": notes, "appliance": appliance or None,
            "appliance_look": str(parsed.get("appliance_look") or "").strip()
            or None,
            "components": components,
            "brand": brand, "device_model": device_model, "device": device,
            "details": details, "ask": ask,
            "model": model or default_model}


def merge_analyses(analyses: list) -> dict:
    """Fuse per-still perceptions: union of parts, richest details win.

    First non-empty notes/appliance/device/details/ask are kept;
    components merge by label with missing color/condition/position
    filled in from later stills.
    """
    merged: dict = {"notes": "", "appliance": None,
                    "appliance_look": None, "components": [],
                    "brand": None,
                    "device_model": None, "device": None, "details": {},
                    "ask": ""}
    seen: dict = {}
    for a in analyses:
        if not merged["notes"] and a.get("notes"):
            merged["notes"] = a["notes"]
        for key in ("appliance", "appliance_look", "brand",
                    "device_model", "device", "ask"):
            if not merged[key] and a.get(key):
                merged[key] = a[key]
        det, mdet = a.get("details", {}), merged["details"]
        for key in ("serial", "color", "condition"):
            if not mdet.get(key) and det.get(key):
                mdet[key] = det[key]
        for key in ("markings", "other"):
            for item in det.get(key, []):
                if item not in mdet.setdefault(key, []):
                    mdet[key].append(item)
        for c in a.get("components", []):
            label = str(c.get("label", "")).strip()
            if not label:
                continue
            slot = seen.get(label.lower())
            if slot is None:
                slot = {"label": label}
                seen[label.lower()] = slot
                merged["components"].append(slot)
            for key in ("hint", "look", "color", "condition", "position"):
                if not slot.get(key) and c.get(key):
                    slot[key] = c[key]
    merged["model"] = analyses[0].get("model") if analyses else None
    return merged


def diagnose(appliance: str, device: str | None, labels: list,
             user_text: str, model: str | None = None,
             sound: str = "", answers: str = "",
             markings: list | None = None, ahead: bool = False,
             effort: str | None = None) -> dict:
    """Call 2 (text-only): causes, relevant parts, steps, safety, fix check.

    Split from perception so neither reply hits the token ceiling.
    Without `answers` it may also return up to two look-only questions
    whose answer changes the plan (which light is on, where a float
    sits). With `answers` (the owner's replies) it decides and asks
    nothing more.
    """
    url, key, default_model = _config()
    prompt = (
        "You are a hands-on helper for household appliances — repairs, "
        "setup, assembly, and installation alike. Respond with a single "
        "JSON object and nothing else, with exactly these keys: "
        '{"issue": "restate the problem in one line", '
        '"headline": "Looks like a clogged filter.", '
        '"causes": ["likely cause one"], '
        '"relevant": ["part label tied to the issue"], '
        '"steps": [{"check": "what to inspect", '
        '"how": "exactly how to inspect or fix it", '
        '"part": "part label from the list or null", '
        '"caution": "what not to touch on this step or null"}], '
        '"safety": ["unplug and remove the battery before opening"], '
        '"questions": [{"ask": "Which light is on?", '
        '"part": "part label or null", '
        '"options": ["Green CHARGING", "Red LOW BATT", "None"]}], '
        '"resolution": "how to verify the fix worked and what to do '
        'if it did not", '
        '"difficulty": "easy", "minutes": 20, '
        '"tools": ["soft brush", "bucket of water"], '
        '"confidence": "high", '
        '"based_on": ["photo: dust on the front grille", '
        '"you said: airflow weak on high fan"]}. '
        f"Appliance: {appliance or 'unknown'}. "
        f"Exact device: {device or 'unknown'}. "
        f"Visible parts: {', '.join(labels) or 'none listed'}. "
        + (f"Printed on the device: {'; '.join(markings)}. "
           if markings else "") +
        f"The user wants: {user_text.strip()} "
        + (f"Measured sound evidence (deterministic, trust these "
           f"numbers): {sound.strip()} " if sound.strip() else "")
        + (f"The owner already checked: {answers.strip()} Base the "
           "causes, steps and headline on these answers, and return "
           "an empty questions list. " if answers.strip() else
           "questions: at most 2 things the owner can check right now "
           "by only looking or listening (no tools, no opening, no "
           "touching anything electrical), and only when one of the "
           "options would change whether the owner can fix it or which "
           "fix it is; skip anything that would only add detail. Most "
           "decisive question first. Ask about the condition that makes "
           "the answer decisive, not whether something works at all: "
           "'Is the airflow weak even on high fan speed?', not 'Is air "
           "blowing from the vent?'. E.g. "
           "which indicator light is lit, or, for anything on "
           "a lead-acid battery (inverter, UPS), where the battery's "
           "water-level floats sit (ask even when the battery is out of "
           "frame: the owner can walk over and look). Ask in plain "
           "everyday words, at most "
           "8 words. 2-4 short options each, using the exact words "
           "printed on the device when there are any. Empty list when "
           "the photo, the "
           "report and the sound already settle it. When you ask any "
           "question, return steps, safety and resolution empty: they "
           "are written once the owner answers. ") +
        "If it is a setup or assembly task, steps are the build/install "
        "order with parts and tools needed; if a repair, steps diagnose "
        "and fix. Each step must name WHAT and exactly HOW, referencing "
        "the visible parts by name — never generic advice. Mention "
        "calling a professional exactly once, as the final step. Always "
        "include safety: power/battery to disconnect, non-conductive "
        "tools (wood/plastic), parts to never touch, water/heat "
        "warnings where relevant; each step gets its own caution. "
        "difficulty is easy, medium or hard for an untrained owner; "
        "minutes is the owner's time for the steps; tools are what they "
        "need at home (empty if none); confidence is high, medium or low "
        "in the finding; based_on is 2-3 short pieces of evidence FOR "
        "THE FINDING, each starting with 'photo:', 'you said:', "
        "'you checked:' or 'sound:', taken only from what is given here "
        "(never brand names, labels or background that do not bear on "
        "the finding). Leave these out when steps are empty. "
        "headline is the finding as one spoken sentence of at most 5 "
        "words in total, starting with \"Looks like\". "
        "Emit compact JSON, start with {, keep it under 700 tokens."
    )
    payload = {
        "model": model or default_model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 8000,
        # The answers pass is the verdict: it gets more reasoning.
        "reasoning_effort": effort or ("medium" if answers.strip() else "low"),
        "response_format": {"type": "json_object"},
    }
    parsed = _complete(url, key, payload, ["causes", "steps"],
                       purpose=("decide (ahead)" if ahead else "decide")
                       if answers.strip() else "diagnose")
    causes = [str(c).strip() for c in parsed.get("causes", [])
              if str(c).strip()][:5]
    relevant = [str(r).strip() for r in parsed.get("relevant", [])
                if str(r).strip()][:4]
    steps = []
    for s in parsed.get("steps", []):
        if isinstance(s, dict):
            check = str(s.get("check", "")).strip()
            if check:
                steps.append({
                    "check": check,
                    "how": str(s.get("how", "")).strip(),
                    "part": str(s.get("part", "") or "").strip() or None,
                    "caution": str(s.get("caution", "") or "").strip() or None,
                })
        elif str(s).strip():
            steps.append({"check": str(s).strip(), "how": "",
                          "part": None, "caution": None})
    safety = [str(x).strip() for x in parsed.get("safety", [])
              if str(x).strip()][:6]
    questions = []
    for q in parsed.get("questions", []) if not answers.strip() else []:
        if not isinstance(q, dict) or not str(q.get("ask", "")).strip():
            continue
        opts = [str(o).strip() for o in q.get("options", [])
                if str(o).strip()][:4]
        if len(opts) < 2:
            continue
        questions.append({"ask": str(q["ask"]).strip(),
                          "part": str(q.get("part") or "").strip() or None,
                          "options": opts})
    words = str(parsed.get("headline", "")).split()
    headline = " ".join(words[:5]).rstrip(".,;") + "." if words else ""
    return {"issue": str(parsed.get("issue", "")).strip(),
            "headline": headline,
            "causes": causes, "relevant": relevant, "steps": steps[:8],
            "safety": safety, "questions": questions[:2],
            "difficulty": str(parsed.get("difficulty") or "").strip().lower()
            if str(parsed.get("difficulty") or "").strip().lower()
            in ("easy", "medium", "hard") else None,
            "minutes": int(parsed["minutes"])
            if str(parsed.get("minutes", "")).strip().isdigit() else None,
            "tools": [str(t).strip() for t in parsed.get("tools") or []
                      if str(t).strip()][:5],
            "confidence": str(parsed.get("confidence") or "").strip().lower()
            if str(parsed.get("confidence") or "").strip().lower()
            in ("high", "medium", "low") else None,
            "based_on": [str(b).strip() for b in parsed.get("based_on") or []
                         if str(b).strip()][:3],
            "resolution": str(parsed.get("resolution", "")).strip()}


def recheck(before: bytes, after: bytes, fix: str, part: str | None = None,
            model: str | None = None) -> dict:
    """Final camera re-check: does the after photo show the fix done?

    Two stills (before the fix, after it) and what the fix was. Returns
    {"looks_fixed": bool | None, "seen": str, "next": str | None};
    None means the after photo does not show the part clearly enough.
    """
    url, key, default_model = _config()
    img = lambda b: {"type": "image_url", "image_url": {  # noqa: E731
        "url": "data:image/jpeg;base64," + base64.b64encode(b).decode()}}
    prompt = (
        "Two photos of the same device: the first BEFORE a home fix, "
        "the second AFTER it. "
        f"The fix: {fix.strip()} "
        + (f"Part to check: {part}. " if part else "") +
        "Judge only what the AFTER photo shows. Respond with one JSON "
        'object: {"looks_fixed": true, "seen": "what the after photo '
        'shows about that part, max 12 words", "next": "the one thing '
        'to redo, max 12 words, or null"}. looks_fixed is null when the '
        "after photo does not show the part clearly enough to tell; "
        "never guess. Start with {.")
    payload = {
        "model": model or default_model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt}, img(before), img(after)]}],
        "max_tokens": 3000,
        "reasoning_effort": "low",
        "response_format": {"type": "json_object"},
    }
    parsed = _complete(url, key, payload, ["looks_fixed"],
                       purpose="recheck", image=after)
    lf = parsed.get("looks_fixed")
    nxt = str(parsed.get("next") or "").strip()
    return {"looks_fixed": lf if isinstance(lf, bool) else None,
            "seen": str(parsed.get("seen") or "").strip(),
            "next": None if nxt.lower() in ("", "null", "none") else nxt}


def caption(image_bytes: bytes, model: str | None = None) -> str:
    """One-line "I'm looking at: X" for the live scan, at minimal effort.

    Runs in parallel with full perception so the user sees the model
    has recognised the object within a few seconds.
    """
    url, key, default_model = _config()
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": model or default_model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "Name the main object in this photo in at most 6 words, "
                    "with its brand if a logo is readable. Reply with only "
                    "the name, no punctuation.")},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
        "max_tokens": 400,
        "reasoning_effort": "minimal",
    }
    reply = _post(url, key, payload, purpose="caption", image=image_bytes)
    try:
        text = (reply["choices"][0]["message"].get("content") or "").strip()
    except (KeyError, IndexError, TypeError):
        text = ""
    text = text.splitlines()[0].strip(" .\"'") if text else ""
    reply["_trace"]["parsed"] = {"caption": text}
    if not text:
        raise RuntimeError("caption came back empty "
                           f"(finish: {reply['_trace'].get('finish')})")
    return f"I'm looking at: {text}"
