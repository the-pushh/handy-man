"""Modal-hosted local models for HandyMan.

Deploy with:
    .venv/bin/python -m modal deploy backend/modal_app.py

This hosts the two on-device style models on Modal GPUs and serves
inference to the FastAPI backend (and any other client):

  - Glimmer  (muse-glimmer): issue diagnosis + repair steps from a
    voice transcript + detected component list.
  - MMSTTS   (mms-tts): text-to-speech for spoken repair guidance.

Until the real weights are dropped into MODEL_IDS below, both classes
serve clearly-marked heuristic fallbacks so the full voice -> highlight
-> speech loop works end to end.
"""

import io

import modal

app = modal.App("handyman-models")

# Base image shared by both models. Real weight downloads happen lazily
# inside @modal.enter() so a code-only deploy stays fast.
# CPU-only on purpose: no GPU billing until the real Glimmer / mms-tts
# weights land. Then add gpu="T4" back to @app.cls (needs a payment
# method on the Modal workspace).
base_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "transformers",
    "accelerate",
    "soundfile",
    "numpy",
)

GLIMMER_MODEL_ID = "muse-glimmer"  # TODO: real checkpoint, e.g. org/muse-glimmer- instruct
MMSTTS_MODEL_ID = "mms-tts"  # TODO: real checkpoint, e.g. facebook/mms-tts-eng


@app.cls(image=base_image, timeout=600)
class Glimmer:
    @modal.enter()
    def load(self):
        # TODO: load the muse-glimmer checkpoint with transformers here and
        # stash it on self (e.g. self.pipe = pipeline(...)).
        self.pipe = None

    @modal.method()
    def diagnose(self, payload: dict) -> dict:
        """payload: {"transcript": str, "components": [{"label": str, ...}]}.

        Returns {"causes": [{title, explanation, relatedComponentLabel, confidence}]}.
        """
        transcript = payload.get("transcript", "")
        components = payload.get("components", [])
        first_label = components[0].get("label") if components else None

        if self.pipe is not None:
            # TODO: real Glimmer inference over transcript + components.
            raise NotImplementedError("wire Glimmer inference to self.pipe")

        text = transcript.lower()
        if "leak" in text or "water" in text:
            causes = [self._cause(
                "Water inlet / hose fault",
                "Leaks near the base usually come from the inlet hose or pump seal.",
                first_label, 0.6)]
        elif any(w in text for w in ("noise", "loud", "vibrat", "shak")):
            causes = [self._cause(
                "Unbalanced load or worn bearing",
                "Loud spin cycles often mean an unbalanced drum or a worn bearing.",
                first_label, 0.55)]
        elif "power" in text or "not turning on" in text or "dead" in text:
            causes = [self._cause(
                "Power supply / breaker fault",
                "No power usually traces to the supply, fuse, or breaker row.",
                first_label, 0.55)]
        else:
            causes = [self._cause(
                "Needs visual inspection",
                "Describe the symptom and I will narrow it down once components are segmented.",
                first_label, 0.4)]
        return {"causes": causes, "model": "muse-glimmer (heuristic fallback)"}

    @modal.method()
    def repair_steps(self, payload: dict) -> dict:
        """payload: {"cause": {...}, "components": [...] dosage not needed}.

        Returns {"steps": [{index, instruction, highlightLabel}]}.
        """
        cause = payload.get("cause", {})
        label = cause.get("relatedComponentLabel") or "the highlighted part"
        steps = [
            {"index": 0,
             "instruction": "Power off the unit and confirm it is safe to touch.",
             "highlightLabel": cause.get("relatedComponentLabel")},
            {"index": 1,
             "instruction": f"Inspect {label} for visible damage or loose connections.",
             "highlightLabel": cause.get("relatedComponentLabel")},
            {"index": 2,
             "instruction": 'Say "next" when ready and I will walk you through the fix.',
             "highlightLabel": cause.get("relatedComponentLabel")},
        ]
        return {"steps": steps, "model": "muse-glimmer (heuristic fallback)"}

    @staticmethod
    def _cause(title, explanation, label, confidence):
        return {"title": title, "explanation": explanation,
                "relatedComponentLabel": label, "confidence": confidence}


@app.cls(image=base_image, timeout=600)
class MMSTTS:
    @modal.enter()
    def load(self):
        # TODO: load the mms-tts checkpoint here (self.tts = ...).
        self.tts = None

    @modal.method()
    def synthesize(self, payload: dict) -> bytes:
        """payload: {"text": str, "lang": "eng"}. Returns WAV bytes."""
        text = payload.get("text", "")
        if self.tts is not None:
            # TODO: real mms-tts synthesis -> wav bytes.
            raise NotImplementedError("wire mms-tts synthesis to self.tts")

        # Shell fallback: a short sine "beep" WAV so the audio path is
        # exercised end to end until weights land.
        import wave

        import numpy as np
        sr = 22050
        t = np.linspace(0, 0.4, int(sr * 0.4), endpoint=False)
        pcm = (np.sin(2 * np.pi * 660 * t) * 32767 * 0.3).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm.tobytes())
        return buf.getvalue()
