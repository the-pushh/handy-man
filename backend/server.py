"""HandyMan FastAPI backend (pure JSON API; UI lives in frontend/).

Run from the project root:
    source .venv/bin/activate
    python -m uvicorn backend.server:app --host 127.0.0.1 --port 8000

The Next.js frontend (frontend/) proxies /api/* here during dev.

Model routing (all local-first; Modal is parked, not functional):
  - analyze -> staged SSE pipeline (backend/pipeline.py): language detect,
    device/logo/component proposals (SAM 3.1 hook points), evidence crops,
    localized causes + repair steps (Glimmer heuristic until weights exist).
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
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()

from .lang import detect_language, language_name, mms_codes
from .pipeline import analyze_events
from . import trace, tts_local

app = FastAPI(title="HandyMan backend")
# Sandbox talkback calls the backend directly (browser -> :8000) so long
# image-generation requests don't die in the Next dev proxy.
app.add_middleware(
    CORSMiddleware,
    # Dev only: the page may be opened from a phone on the LAN, so any
    # local origin is allowed. No credentials are used.
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def time_requests(request: Request, call_next):
    """One log line per request: path, upload size, server time."""
    start = time.time()
    response = await call_next(request)
    size = request.headers.get("content-length", "0")
    print(f"[req] {time.strftime('%H:%M:%S')} {request.method} "
          f"{request.url.path} in={int(size) // 1024}KB "
          f"{(time.time() - start) * 1000:.0f}ms -> {response.status_code}",
          flush=True)
    return response


class TTSRequest(BaseModel):
    text: str
    lang: str | None = None


@app.get("/api/health")
def health():
    return {"ok": True, "tts": "local mms-tts", "tts_ready": tts_local.available()}


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


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...), transcript: str = Form(""),
                  lang_override: str = Form("")):
    """One voice turn, streamed as it is gathered (SSE, one JSON per event).

    The frontend POSTs the transcript with a system-captured still and reads
    events incrementally: it speaks every "thinking" line while rendering
    that stage's boxes + evidence crops, so narration and SAM overlays run
    simultaneously. See backend/pipeline.py for the stage order.
    """
    still = await file.read()

    def gen():
        for event in analyze_events(still, transcript, override=lang_override):
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


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
    try:
        with trace.call(checkpoint + " (local)", "speak", kind="hop"):
            wav = tts_local.synthesize(req.text, checkpoint)
        return {"audio_b64": base64.b64encode(wav).decode(),
                "mime": "audio/wav", "model": checkpoint + " (local)",
                "lang": code}
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
async def repair_analyze(file: UploadFile = File(...),
                          stills: list[UploadFile] = File(default=[]),
                          text: str = Form(""),
                          components: str = Form(""),
                          model: str | None = Form(None)):
    """Analyze, then attach every model call's trace record.

    Uploads are read here; the blocking model calls run in a worker
    thread so they never stall the event loop (a stalled loop made
    concurrent /api/tts requests wait for the whole analysis). The
    worker inherits this request's trace context.
    """
    trace.begin()
    images = [await file.read()]
    for extra in stills or []:
        images.append(await extra.read())
    out = await run_in_threadpool(_repair_analyze, images, text,
                                  components, model)
    out["trace"] = trace.export()
    return out


def _repair_analyze(images, text, components, model):
    """Repair flow: image in -> Muse Spark analysis + overlay highlights.

    One hosted gateway (MUSE_SPARK_API_URL/KEY): Spark
    (muse-spark-contributor) names the components, sam-3.1 cuts a mask
    per name. SAM-only mode: pass `components` comma-separated to skip
    the Spark call (still needs the API key).
    """
    from concurrent.futures import ThreadPoolExecutor

    from . import sam31, spark

    image = images[-1]  # highlight/SAM work on the latest framing
    wanted = [c.strip() for c in (components or "").split(",") if c.strip()]
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
    if not wanted:
        try:
            from concurrent.futures import as_completed
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
        except RuntimeError as exc:
            status = ("needs-api-key" if "not configured" in str(exc)
                      else "spark-error")
            return {"status": status, "detail": str(exc)}
        except Exception as exc:
            return {"status": "unexpected-error",
                    "detail": f"{type(exc).__name__}: {exc}"}
        analysis = spark.merge_analyses(analyses)
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
                    device or None, wanted, text, model=model)
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
            diag_rel = [r.lower() for r in diag["relevant"]]
            relevant = [w for w in wanted if w.lower() in diag_rel]
        else:
            relevant = []
    highlight = None
    try:
        instances = sam31.segment(image, wanted)
    except Exception:
        instances = []
    from .muse_image import assign_legend
    canonical = assign_legend(relevant or wanted[:4])
    first_part = (steps[0].get("part") if steps
                  and isinstance(steps[0], dict) else None)
    to_mark = ([first_part] if first_part else relevant) or wanted[:4]
    has_intent = bool(text.strip() or components.strip() or steps)
    # muse-image takes 10-20s, so it is not run here: the client asks
    # /api/repair/highlight for these parts after showing the result.
    highlight_parts = (to_mark if (not instances and to_mark and has_intent)
                       else [])
    has_text = bool(text.strip() or components.strip())
    if not has_text:
        return {"status": "ok", "notes": notes,
                "components": inventory,
                "causes": [], "steps": [],
                "issue": "", "resolution": resolution,
                "device": device, "details": details, "ask": ask,
                "instances": [], "legend": [],
                "overlay": None}
    appliance = notes.replace("The appliance is ", "").rstrip(".").strip()
    from .risk import assess_risk
    risk = assess_risk(device or appliance, text)
    return {"status": "ok", "notes": notes,
            "components": inventory,
            "causes": causes, "steps": steps,
            "issue": understood, "resolution": resolution,
            "device": device, "details": details, "ask": ask,
            "safety": safety,
            "risk": risk,
            "instances": instances,
            "legend": canonical,
            "highlight_parts": highlight_parts,
            "overlay": highlight}


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
    image = await file.read()
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
