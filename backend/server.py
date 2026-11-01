"""HandyMan FastAPI backend (pure JSON API; UI lives in frontend/).

Run from the project root:
    source .venv/bin/activate
    python -m uvicorn backend.server:app --host 127.0.0.1 --port 8000

The Next.js frontend (frontend/) proxies /api/* here during dev.

Model routing (Meta's hosted Model API, one gateway):
  - repair/analyze -> muse-spark perception, diagnose, decide; the rules
    layer (backend/risk.py) judges every proposed fix.
  - segment -> sam-3.1 masks; listen -> muse-wonder-1.0 + measured audio;
    recheck -> muse-spark before/after; pros -> Google Places (New).
  - tts -> local MMS-TTS WAV (backend/tts_local.py) in the transcript's
    own language; {"fallback": true} only when synthesis itself fails, in
    which case the frontend speaks with the browser voice.
  - transcribe -> muse-voice-transcribe endpoint when configured
    (MUSE_TRANSCRIBE_URL); the app otherwise uses the browser's built-in
    speech recognition, so this stays optional.
"""

import base64
import json
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

from . import config  # noqa: E402
config.validate()  # fail fast, naming every missing variable

from .lang import detect_language, language_name, mms_codes  # noqa: E402
from . import trace, tts_local  # noqa: E402
from .images import normalize_all as images_normalized  # noqa: E402

app = FastAPI(title="HandyMan backend")
# Production traffic is same-origin through the Vercel proxy, so CORS is
# only for direct calls: locked to ALLOWED_ORIGINS there. In development
# any origin works (phone on the LAN, tunnels). No credentials are used.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS or ([] if config.PRODUCTION else ["*"]),
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type", "x-session"],
)

from .limits import Window, wait_text  # noqa: E402

_requests = Window(config.RATE_REQUESTS_PER_HOUR, 3600)
_turns = Window(config.RATE_TURNS_PER_HOUR, 3600)
_places_session = Window(config.PLACES_PER_SESSION, 86400)
_places_ip = Window(config.PLACES_PER_IP_PER_DAY, 86400)


def _slow_down(wait: int, what: str) -> JSONResponse:
    return JSONResponse(status_code=429, headers={"Retry-After": str(wait)},
                        content={"status": "rate-limited", "detail":
                                 f"You've {what}. Please try again in "
                                 f"{wait_text(wait)}.", "retry_after": wait})


def _client_ip(request: Request) -> str:
    """The visitor's IP. Behind the Vercel proxy it arrives in
    x-client-ip, trusted only because the proxy secret matched."""
    if config.PROXY_SECRET:
        ip = request.headers.get("x-client-ip", "").split(",")[0].strip()
        if ip:
            return ip
    return request.client.host if request.client else "unknown"


@app.on_event("startup")
def warm_tts() -> None:
    """Load the English MMS voice in the background at boot, so the
    first spoken line is not a 5-8s cold model load."""
    import threading

    def warm():
        try:
            tts_local.synthesize("ready", "facebook/mms-tts-eng")
        except Exception:
            pass
    threading.Thread(target=warm, daemon=True).start()
    from . import sam31
    threading.Thread(target=sam31.warm, daemon=True).start()


@app.middleware("http")
async def time_requests(request: Request, call_next):
    """Guard and log every request.

    With PROXY_SECRET set (production), /api/* needs the secret the
    Vercel middleware adds, so the Modal URL can't be called directly
    to dodge the limits. Then a per-IP request budget, then one log line:
    path, upload size, server time.
    """
    import hashlib
    import hmac

    start = time.time()
    path = request.url.path
    guarded = (path.startswith("/api/") and path != "/api/health"
               and request.method != "OPTIONS")
    if guarded and config.PROXY_SECRET and not hmac.compare_digest(
            request.headers.get("x-handyman-proxy", ""), config.PROXY_SECRET):
        return JSONResponse(status_code=403, content={
            "status": "forbidden", "detail": "Use the app's own address."})
    ip = _client_ip(request)
    request.state.ip = ip
    trace.request_info.set({"path": path, "client": hashlib.sha256(
        ip.encode()).hexdigest()[:10]})
    if guarded:
        wait = _requests.take(ip)
        if wait:
            return _slow_down(wait, "been busy this hour")
    response = await call_next(request)
    size = request.headers.get("content-length", "0")
    print(f"[req] {time.strftime('%H:%M:%S', time.localtime(start))}"
          f".{int(start * 1000) % 1000:03d} {request.method} "
          f"{request.url.path} in={int(size) // 1024}KB "
          f"{(time.time() - start) * 1000:.0f}ms -> {response.status_code}",
          flush=True)
    return response


class TTSRequest(BaseModel):
    text: str
    lang: str | None = None
    max_seconds: float | None = None  # spoken verdicts: fit under this


@app.get("/api/health")
def health():
    return {"ok": True, "tts": "local mms-tts", "tts_ready": tts_local.available()}


@app.post("/api/smoke")
async def smoke():
    """Deploy smoke test: one tiny live Spark call (behind the proxy
    secret like every other model endpoint)."""
    from . import spark

    trace.begin()
    try:
        out = await run_in_threadpool(spark.ping)
        return {"status": "ok" if out["ok"] else "bad-reply", **out,
                "trace": trace.export()}
    except Exception as exc:
        return JSONResponse(status_code=502, content={
            "status": "spark-error", "detail": str(exc)[:200]})


@app.get("/api/languages")
def languages():
    """Every MMS-TTS voice with its narration coverage for the picker."""
    from .i18n import can_narrate
    return {"languages": [{"code": c, "name": language_name(c),
                           "narratable": can_narrate(c)}
                           for c in sorted(mms_codes())]}


class DetectRequest(BaseModel):
    text: str


@app.post("/api/detect-language")
def detect(req: DetectRequest):
    """Detect the transcript language -> MMS voice + STT locale hint."""
    return detect_language(req.text)


@app.post("/api/tts")
def tts(req: TTSRequest):
    """Speak `text` in the given MMS language (detected when omitted).

    `lang` is an MMS checkpoint suffix ("eng", "hin", "urd-script_arabic")
    or an authored alias ("en"/"hi"/"hinglish"). Unknown codes fall back
    to the browser voice rather than a wrong-language model.
    """
    alias = {"en": "eng", "hi": "hin", "hinglish": "hin"}
    if req.lang and req.lang in mms_codes():
        code = req.lang
    elif req.lang in alias:
        code = alias[req.lang]
    elif req.lang:
        return {"fallback": True, "text": req.text, "lang": req.lang,
                "error": "no MMS voice for this language"}
    else:
        detected = detect_language(req.text)
        code = detected["code"] or "eng"
    checkpoint = f"facebook/mms-tts-{code}"
    trace.begin()
    try:
        with trace.call(checkpoint + " (local)", "speak", kind="hop"):
            wav = tts_local.synthesize(req.text, checkpoint,
                                       max_seconds=req.max_seconds)
        recs = trace.export()
        for r in recs:
            r["parsed"] = {"text": req.text, "lang": code,
                           "audio_kb": len(wav) // 1024}
        return {"audio_b64": base64.b64encode(wav).decode(),
                "mime": "audio/wav", "model": checkpoint + " (local)",
                "lang": code, "trace": recs}
    except Exception as exc:
        return {"fallback": True, "text": req.text, "lang": code,
                "error": str(exc)}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Muse Voice Transcribe hook. Unconfigured until MUSE_TRANSCRIBE_URL set.

    The app prefers the browser's built-in speech recognition, so this
    endpoint is only a server-side option, not a requirement.
    """
    url = os.environ.get("MUSE_TRANSCRIBE_URL")
    await file.read()
    if not url:
        return {"status": "unconfigured",
                "detail": "Set MUSE_TRANSCRIBE_URL to enable server-side muse-voice-transcribe."}
    # TODO: POST the audio bytes to the muse-voice-transcribe endpoint.
    return {"status": "not-implemented"}


@app.get("/", include_in_schema=False)
def index():
    return {"service": "handyman-backend",
            "frontend": "Next.js app in frontend/ (port 3000)",
            "docs": "/docs"}


@app.post("/api/repair/analyze")
async def repair_analyze(request: Request,
                          file: UploadFile = File(...),
                          stills: list[UploadFile] = File(default=[]),
                          text: str = Form(""),
                          components: str = Form(""),
                          perception: str = Form(""),
                          sound: str = Form(""),
                          answers: str = Form(""),
                          owner: str = Form(""),
                          ahead: str = Form(""),
                          model: str | None = Form(None)):
    """Analyze, then attach every model call's trace record.

    `perception` (JSON) is the first look's Spark perception of this same
    still, sent back by the client so the walkthrough goes straight to
    diagnosis instead of perceiving the still a second time.
    `answers` are the owner's replies to the first diagnosis's
    questions ("Float level? Below the line."); the second pass decides.

    Uploads are read here; the blocking model calls run in a worker
    thread so they never stall the event loop (a stalled loop made
    concurrent /api/tts requests wait for the whole analysis). The
    worker inherits this request's trace context.
    """
    # A first look (photo, nothing said yet) starts a turn: that is what
    # the per-IP "turns per hour" limit counts.
    if not text.strip() and not perception.strip() and not answers.strip():
        wait = _turns.take(request.state.ip)
        if wait:
            return _slow_down(wait, f"started {config.RATE_TURNS_PER_HOUR} "
                              "fixes this hour")
    trace.begin()
    images = [await file.read()]
    for extra in stills or []:
        images.append(await extra.read())
    images = images_normalized(images)
    try:
        prior = json.loads(perception) if perception.strip() else None
    except json.JSONDecodeError:
        prior = None
    if owner.strip():
        # What the owner says the device is; kept even when extra views
        # are perceived afresh (no prior perception to carry it).
        prior = {**(prior or {}), "owner_says": owner.strip()}
    out = await run_in_threadpool(_repair_analyze, images, text,
                                  components, model, prior, sound,
                                  answers, bool(ahead.strip()))
    out["trace"] = trace.export()
    return out


def _repair_analyze(images, text, components, model, prior=None,
                    sound="", answers="", ahead=False):
    """Repair flow: image in -> Muse Spark analysis + overlay highlights.

    One hosted gateway (MUSE_SPARK_API_URL/KEY): Spark
    (muse-spark-contributor) names the components, sam-3.1 cuts a mask
    per name. SAM-only mode: pass `components` comma-separated to skip
    the Spark call (still needs the API key).
    """
    from concurrent.futures import ThreadPoolExecutor

    from . import spark
    from .risk import INVERTER

    wanted = [c.strip() for c in (components or "").split(",") if c.strip()]
    wanted_given = bool(wanted)
    analysis: dict = {}
    notes = ""
    causes: list = []
    steps: list = []
    relevant: list = []
    understood = ""
    resolution = ""
    device = ""
    details = {}
    ask = ""
    inventory = []
    safety: list = []
    questions: list = []
    diag_questions = False
    meta: dict = {}
    headline = ""
    reuse = (isinstance(prior, dict) and isinstance(prior.get("components"), list)
             and len(images) == 1)
    if not wanted:
        try:
            from concurrent.futures import as_completed
            if reuse:
                raise _Reuse()
            analyses = []
            first_error: Exception | None = None
            with ThreadPoolExecutor(max_workers=3) as pool:
                futures = [trace.run_in(pool, spark.analyze_image, b,
                                        user_text=text, model=model)
                           for b in images]
                for fut in as_completed(futures):
                    try:
                        analyses.append(fut.result())
                    except Exception as exc:
                        if first_error is None:
                            first_error = exc
            if not analyses:
                raise first_error or RuntimeError("no stills analyzed")
        except _Reuse:
            analyses = [prior]
        except RuntimeError as exc:
            status = ("needs-api-key" if "not configured" in str(exc)
                      else "spark-error")
            return {"status": status, "detail": str(exc)}
        except Exception as exc:
            return {"status": "unexpected-error",
                    "detail": f"{type(exc).__name__}: {exc}"}
        analysis = spark.merge_analyses(analyses)
        # The owner corrected the confirm card ("no, it's an inverter"):
        # their word beats the photo for diagnose, decide and the rules.
        owner = str((prior or {}).get("owner_says") or "").strip()
        if owner:
            analysis["owner_says"] = owner
            analysis["appliance"] = owner
            analysis["notes"] = f"The appliance is {owner}."
        wanted = [c["label"] for c in analysis["components"]]
        inventory = [{k: c.get(k) for k in
                      ("label", "color", "condition", "position")}
                     for c in analysis["components"]]
        notes = analysis["notes"]
        device = analysis.get("device") or ""
        details = analysis.get("details", {})
        ask = analysis.get("ask", "")
        if text.strip():
            try:
                diag = spark.diagnose(
                    notes.replace("The appliance is ", "").rstrip("."),
                    device or None, wanted, text, model=model,
                    sound=sound, answers=answers, ahead=ahead,
                    # Answers pass: medium where the call is subtle
                    # (inverter floats vs terminals), low elsewhere
                    # (same AC findings, ~1.5s faster).
                    effort=(("medium" if INVERTER.search(
                        f"{device} {analysis.get('appliance') or ''} {text}")
                        else "low") if answers.strip() else None),
                    markings=(details.get("markings", [])
                              + details.get("other", []))[:10])
            except Exception as exc:
                return {"status": "diagnose-error", "detail": str(exc),
                        "notes": notes,
                        "components": inventory,
                        "device": device, "details": details,
                        "ask": ask}
            causes = diag["causes"]
            steps = diag["steps"]
            understood = diag["issue"]
            resolution = diag["resolution"]
            safety = diag["safety"]
            headline = diag.get("headline", "")
            questions = diag.get("questions", [])
            diag_questions = bool(questions)
            meta = {k: diag.get(k) for k in ("difficulty", "minutes",
                                             "tools", "confidence",
                                             "based_on")}
            diag_rel = [r.lower() for r in diag["relevant"]]
            relevant = [w for w in wanted if w.lower() in diag_rel]
        else:
            relevant = []
    # The model proposed the steps; the rules decide which an owner may
    # do. A "pro" verdict keeps only the steps before the first blocked
    # one (safe checks) and names the fired rule in plain words.
    from .risk import judge
    # The spoken finding leads the causes: it is what the owner hears,
    # so a finding only a pro can fix ("low refrigerant") forces "pro".
    verdict = judge(f"{device} {analysis.get('appliance') or ''}".strip(),
                    text, steps, causes, finding=headline)
    proposed = len(steps)
    verdict["removed"] = [steps[i].get("check", "") + (
        f": {steps[i].get('how')}" if steps[i].get("how") else "")
        for i in verdict["blocked_steps"] if i < len(steps)]
    steps = [steps[i] for i in verdict["allowed_steps"]]
    verdict["proposed_steps"] = proposed
    verdict["headline"] = (verdict["spoken"] if verdict["verdict"] == "pro"
                           else headline)
    # Questions are look-only checks whose answer can flip the verdict.
    # The rules screen them like steps, and a danger symptom asks nothing.
    if "danger-symptom" in verdict["fired"]:
        questions = []
    questions = [q for q in questions if judge(
        f"{device} {analysis.get('appliance') or ''}".strip(), "",
        [{"check": q["ask"], "how": " ".join(q["options"])}])["verdict"]
        == "diy"]
    # One question when it looks like an owner fix (keeps the AC fast);
    # up to two for inverter/battery cases (indicator light + floats)
    # and for anything heading to a pro.
    ctx = f"{device} {analysis.get('appliance') or ''} {text}"
    questions = questions[:2 if (verdict["verdict"] == "pro"
                                 or INVERTER.search(ctx)) else 1]
    if not questions and not steps and text.strip() and answers.strip() == "" \
            and diag_questions:
        # Every question was dropped by the rules or the cap, and pass 1
        # left the steps for after the answers: decide with no answers.
        return _repair_analyze(images, text, components, model, analysis,
                               sound, "Nothing checked yet.", ahead)
    verdict.update(meta)
    verdict["final"] = not questions
    # The part the final camera re-check looks at: the issue-relevant
    # part the steps work on most, else the part named most often.
    from collections import Counter
    named = Counter(st.get("part") for st in steps
                    if isinstance(st, dict) and st.get("part"))
    focus = next((r for r in relevant if named.get(r)), None) or (
        named.most_common(1)[0][0] if named else
        (relevant[0] if relevant else None))
    risk = {"level": "high" if verdict["verdict"] == "pro" else "standard",
            "hazard": verdict["rule"] or "", "reason": verdict["title"] or ""}
    from .muse_image import assign_legend
    canonical = assign_legend(relevant or wanted[:4])
    # SAM runs in its own request (/api/segment) so the verdict does not
    # wait for masks. These are the noun phrases it should segment: the
    # parts the steps name (in step order) plus the relevant parts, or
    # the appliance itself on the first look.
    step_parts = [st.get("part") for st in steps
                  if isinstance(st, dict) and st.get("part")]
    appliance_name = analysis.get("appliance") if not wanted_given else None
    segment_labels = list(dict.fromkeys(step_parts + relevant)) or (
        [appliance_name or (wanted[0] if wanted else "")]
        if not text.strip() else wanted[:2])
    segment_labels = [lbl for lbl in segment_labels if lbl][:4]
    # Each part goes to SAM with Spark's plain visual phrase ("black
    # panel" for a display), which SAM finds far more often than the
    # trade name; masks keep the part label.
    looks = {str(c.get("label", "")).lower(): c.get("look")
             for c in analysis.get("components", []) if c.get("look")}
    if appliance_name:
        # "white box" missed the real inverter; "device" found it.
        looks[appliance_name.lower()] = [
            x for x in (analysis.get("appliance_look"), "device") if x]
    segment_labels = [{"label": lbl, "look": looks.get(lbl.lower())}
                      for lbl in segment_labels]
    has_text = bool(text.strip() or components.strip())
    if not has_text:
        return {"status": "ok", "notes": notes,
                "components": inventory,
                "causes": [], "steps": [],
                "issue": "", "resolution": resolution,
                "device": device, "details": details, "ask": ask,
                "perception": analysis or None,
                "segment_labels": segment_labels,
                "instances": [], "legend": [],
                "overlay": None}
    return {"status": "ok", "notes": notes,
            "components": inventory,
            "causes": causes, "steps": steps,
            "issue": understood, "resolution": resolution,
            "device": device, "details": details, "ask": ask,
            "safety": safety,
            "questions": questions,
            "focus": focus,
            "perception": analysis or None,
            "verdict": verdict,
            "risk": risk,
            "instances": [],
            "legend": canonical,
            "segment_labels": segment_labels,
            "overlay": None}


class _Reuse(Exception):
    """Internal: skip perception, the client sent the first look's."""


class ProsRequest(BaseModel):
    trade: str
    lat: float
    lng: float


@app.post("/api/pros")
async def pros(req: ProsRequest, request: Request):
    """Nearby pros for the verdict's trade (Places API New, key stays
    server-side; location travels in the body, never in a URL).
    Capped per browser session and per IP per day (Places is billed)."""
    from . import places

    session = request.headers.get("x-session", "").strip()[:64] or request.state.ip
    wait = (_places_session.take(session)
            or _places_ip.take(request.state.ip))
    if wait:
        return _slow_down(wait, "looked up nearby pros a few times already")
    trace.begin()
    try:
        found = await run_in_threadpool(places.nearby, req.trade,
                                        req.lat, req.lng)
        return {"status": "ok", "pros": found, "trade": req.trade,
                "trace": trace.export()}
    except LookupError as exc:
        return {"status": "needs-places-key", "detail": str(exc),
                "pros": [], "trace": trace.export()}
    except Exception as exc:
        return {"status": "places-error", "detail": str(exc)[:300],
                "pros": [], "trace": trace.export()}


@app.post("/api/listen")
async def listen(file: UploadFile = File(...)):
    """A 3-5s WAV -> measured features + Muse Wonder's hearing.

    The numbers (audiofeat) are the source of truth; Wonder is the
    cross-check. If they disagree on the beep count, the client asks
    the user to record again.
    """
    from concurrent.futures import ThreadPoolExecutor

    from . import audiofeat, wonder

    trace.begin()
    wav = await file.read()

    def work():
        with ThreadPoolExecutor(max_workers=1) as pool:
            heard = trace.run_in(pool, wonder.listen, wav)
            with trace.call("audiofeat (deterministic)", "measure beeps, "
                            "clicks, loudness", kind="hop") as rec:
                feats = audiofeat.from_wav(wav)
                rec["parsed"] = {k: v for k, v in feats.items()
                                 if k != "events"}
            try:
                ear = heard.result()
                ear_error = None
            except Exception as exc:
                ear, ear_error = None, str(exc)[:200]
        agree = (ear is not None and ear.get("beeps") is not None
                 and ear["beeps"] == feats["beeps"])
        return feats, ear, ear_error, agree

    try:
        feats, ear, ear_error, agree = await run_in_threadpool(work)
    except Exception as exc:
        return {"status": "listen-error", "detail": str(exc)[:300],
                "trace": trace.export()}
    from .audiofeat import summary
    return {"status": "ok", "features": feats, "wonder": ear,
            "wonder_error": ear_error, "agree": agree,
            # Disagreement on the count, or Wonder unavailable: ask the
            # user to record again rather than diagnose from doubt.
            "rerecord": not agree,
            "summary": summary(feats)
            + (f" Muse Wonder heard: {ear['sound']}." if ear and ear.get("sound") else ""),
            "trace": trace.export()}


@app.post("/api/segment")
async def segment(file: UploadFile = File(...), labels: str = Form(...)):
    """SAM 3.1 masks for up to 4 parts: JSON list of labels or
    {label, look} objects, or a comma list."""
    from . import sam31

    trace.begin()
    image = images_normalized([await file.read()])[0]
    try:
        wanted = json.loads(labels)
        if not isinstance(wanted, list):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        wanted = [w for w in labels.split(",")]
    wanted = [w if isinstance(w, dict) else str(w).strip() for w in wanted
              if (w.get("label") or w.get("look") if isinstance(w, dict)
                  else str(w).strip())]
    try:
        instances = await run_in_threadpool(sam31.segment, image, wanted)
        return {"status": "ok", "instances": instances,
                "trace": trace.export()}
    except Exception as exc:
        return {"status": "segment-error", "detail": str(exc),
                "instances": [], "trace": trace.export()}


@app.post("/api/recheck")
async def recheck(before: UploadFile = File(...),
                  after: UploadFile = File(...),
                  fix: str = Form(""), part: str = Form("")):
    """Final camera re-check: Spark compares the before and after stills."""
    from . import spark

    trace.begin()
    b, a = images_normalized([await before.read(), await after.read()])
    try:
        out = await run_in_threadpool(spark.recheck, b, a, fix,
                                      part.strip() or None)
        return {"status": "ok", **out, "trace": trace.export()}
    except Exception as exc:
        return {"status": "recheck-error", "detail": str(exc),
                "trace": trace.export()}


@app.post("/api/caption")
async def caption(file: UploadFile = File(...)):
    """Fast one-line caption for the live scan (separate tiny call)."""
    from . import spark

    trace.begin()
    image = images_normalized([await file.read()])[0]
    try:
        text = await run_in_threadpool(spark.caption, image)
        return {"status": "ok", "caption": text, "trace": trace.export()}
    except Exception as exc:
        return {"status": "caption-error", "detail": str(exc),
                "trace": trace.export()}


@app.post("/api/repair/highlight")
async def repair_highlight(file: UploadFile = File(...),
                            part: str = Form(...),
                            legend: str = Form("")):
    """One step's highlight on demand: image + part name -> overlay.

    `legend` (JSON) carries the walkthrough's canonical tag assignment
    so this step reuses the same letters, not A-from-scratch.
    """
    from . import muse_image

    trace.begin()
    image = images_normalized([await file.read()])[0]
    try:
        fixed = json.loads(legend) if legend.strip() else []
    except json.JSONDecodeError:
        fixed = []
    try:
        overlay = await run_in_threadpool(
            muse_image.highlight, image, [part.strip()], fixed=fixed)
        return {"status": "ok", "overlay": overlay,
                "trace": trace.export()}
    except Exception as exc:
        return {"status": "highlight-error", "detail": str(exc),
                "trace": trace.export()}
