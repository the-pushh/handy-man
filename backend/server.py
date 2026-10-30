"""HandyMan FastAPI backend (pure JSON API; UI lives in frontend/).

Run from the project root:
    source .venv/bin/activate
    python -m uvicorn backend.server:app --host 127.0.0.1 --port 8000

The Next.js frontend (frontend/) proxies /api/* here during dev.

Model routing:
  - diagnose / repair steps -> Modal Glimmer when deployed
    (HANDYMAN_MODAL=1 and `modal deploy backend/modal_app.py` done),
    otherwise the same heuristic fallback Modal itself serves.
  - tts -> Modal mms-tts WAV when deployed, else {"fallback": true}
    and the web app speaks with the browser voice.
  - transcribe -> muse-voice-transcribe endpoint when configured
    (MUSE_TRANSCRIBE_URL); the web app otherwise uses the browser's
    built-in speech recognition, so this stays optional.
  - detect -> SAM 3.1 hook; shell returns a whole-unit proposal box
    until weights land, and the user can tap-to-tag parts in the UI.
"""

import base64
import os

from fastapi import FastAPI, File, UploadFile
from pydantic import BaseModel, Field

USE_MODAL = os.environ.get("HANDYMAN_MODAL", "0") == "1"

app = FastAPI(title="HandyMan backend")


# ---------------------------------------------------------------- models

class Component(BaseModel):
    label: str = "unit"
    # Normalized box, origin top-left, 0..1 (matches web canvas coords).
    x: float = 0.05
    y: float = 0.05
    w: float = 0.9
    h: float = 0.9
    confidence: float = 0.5


class DiagnoseRequest(BaseModel):
    transcript: str
    components: list[Component] = Field(default_factory=list)


class Cause(BaseModel):
    title: str
    explanation: str
    relatedComponentLabel: str | None = None
    confidence: float


class StepsRequest(BaseModel):
    cause: Cause
    components: list[Component] = Field(default_factory=list)


class RepairStep(BaseModel):
    index: int
    instruction: str
    highlightLabel: str | None = None


class TTSRequest(BaseModel):
    text: str


def _modal_classes():
    """Look up deployed Modal classes; raises when not deployed/authed."""
    import modal

    glimmer = modal.Cls.from_name("handyman-models", "Glimmer")
    tts = modal.Cls.from_name("handyman-models", "MMSTTS")
    return glimmer, tts


# ---------------------------------------------------------------- routes

@app.get("/api/health")
def health():
    return {"ok": True, "modal": USE_MODAL}


@app.post("/api/detect")
async def detect(file: UploadFile = File(...)):
    """Object detection shell (SAM 3.1 hook).

    Accepts a still JPEG; returns component proposals. Today this is a
    whole-unit proposal so capture -> highlight works; the SAM 3.1 weights
    slot in here without changing the web client.
    """
    await file.read()
    # TODO: run SAM 3.1 (local weights or Modal) on the still and return
    # per-component boxes + masks.
    return {"components": [Component().model_dump()],
            "model": "sam-3.1 (shell proposal)"}


@app.post("/api/diagnose")
def diagnose(req: DiagnoseRequest):
    if USE_MODAL:
        try:
            glimmer, _ = _modal_classes()
            payload = {"transcript": req.transcript,
                       "components": [c.model_dump() for c in req.components]}
            return glimmer().diagnose.remote(payload)
        except Exception as exc:  # deployed lookup failed; fall through
            return {"causes": [], "model": "unavailable", "error": str(exc)}
    text = req.transcript.lower()
    first = req.components[0].label if req.components else None

    def cause(title, explanation, confidence):
        return {"title": title, "explanation": explanation,
                "relatedComponentLabel": first, "confidence": confidence}

    if "leak" in text or "water" in text:
        causes = [cause("Water inlet / hose fault",
                        "Leaks near the base usually come from the inlet hose or pump seal.", 0.6)]
    elif any(w in text for w in ("noise", "loud", "vibrat", "shak")):
        causes = [cause("Unbalanced load or worn bearing",
                        "Loud spin cycles often mean an unbalanced drum or a worn bearing.", 0.55)]
    elif "power" in text or "not turning on" in text or "dead" in text:
        causes = [cause("Power supply / breaker fault",
                        "No power usually traces to the supply, fuse, or breaker row.", 0.55)]
    else:
        causes = [cause("Needs visual inspection",
                        "Describe the symptom and I will narrow it down once components are segmented.", 0.4)]
    return {"causes": causes, "model": "local heuristic (Glimmer fallback)"}


@app.post("/api/steps")
def steps(req: StepsRequest):
    if USE_MODAL:
        try:
            glimmer, _ = _modal_classes()
            payload = {"cause": req.cause.model_dump(),
                       "components": [c.model_dump() for c in req.components]}
            return glimmer().repair_steps.remote(payload)
        except Exception as exc:
            return {"steps": [], "model": "unavailable", "error": str(exc)}
    label = req.cause.relatedComponentLabel or "the highlighted part"
    return {"steps": [
        {"index": 0, "instruction": "Power off the unit and confirm it is safe to touch.",
         "highlightLabel": req.cause.relatedComponentLabel},
        {"index": 1, "instruction": f"Inspect {label} for visible damage or loose connections.",
         "highlightLabel": req.cause.relatedComponentLabel},
        {"index": 2, "instruction": 'Say "next" when ready and I will walk you through the fix.',
         "highlightLabel": req.cause.relatedComponentLabel},
    ], "model": "local heuristic (Glimmer fallback)"}


@app.post("/api/overlay")
def overlay(req: StepsRequest):
    label = req.cause.relatedComponentLabel or "the highlighted part"
    return {"caption": f"Possible cause: {req.cause.title}. Inspect {label}.",
            "model": "muse-image (caption shell)"}


@app.post("/api/tts")
def tts(req: TTSRequest):
    if USE_MODAL:
        try:
            _, tts_cls = _modal_classes()
            wav: bytes = tts_cls().synthesize.remote({"text": req.text})
            return {"audio_b64": base64.b64encode(wav).decode(),
                    "mime": "audio/wav", "model": "mms-tts (modal)"}
        except Exception as exc:
            return {"fallback": True, "text": req.text, "error": str(exc)}
    return {"fallback": True, "text": req.text,
            "model": "browser speechSynthesis (mms-tts not deployed)"}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Muse Voice Transcribe hook. 501 until MUSE_TRANSCRIBE_URL is set.

    The web app prefers the browser's built-in speech recognition, so this
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
