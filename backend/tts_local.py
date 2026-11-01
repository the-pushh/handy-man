"""Local MMS-TTS synthesis — no Modal, no network at inference time.

Checkpoints (downloaded once from Hugging Face on first use):
  eng      -> facebook/mms-tts-eng
  hi/hinglish -> facebook/mms-tts-hin (Hinglish templates are authored in
                 Devanagari, so the Hindi acoustic model speaks them right)

Glimmer has no public local weights, so on-device reasoning stays a
heuristic (see voice_lines) until they exist — "glimmer locally" means the
same fallback logic, running here instead of on Modal.
"""

import io
import re
import threading
import wave

_cache: dict = {}
_lock = threading.RLock()

_WS = re.compile(r"\s+")


def _load(checkpoint: str):
    import torch
    from transformers import AutoTokenizer, VitsModel

    tokenizer = AutoTokenizer.from_pretrained(checkpoint)
    model = VitsModel.from_pretrained(checkpoint)
    model.eval()
    rate = int(getattr(model.config, "sampling_rate", 16000))
    return tokenizer, model, torch, rate


def _get(checkpoint: str):
    with _lock:
        if checkpoint not in _cache:
            _cache[checkpoint] = _load(checkpoint)
        return _cache[checkpoint]


def synthesize(text: str, checkpoint: str, max_chars: int = 400,
               max_seconds: float | None = None) -> bytes:
    """Speak `text` with a local MMS-TTS checkpoint. Returns WAV bytes.

    `max_seconds` (spoken verdicts): if the clip runs long, synthesise
    it again slightly faster to fit, never above 1.3x.
    """
    clean = _WS.sub(" ", (text or "").strip())[:max_chars]
    if not clean:
        raise ValueError("empty text")
    tokenizer, model, torch, rate = _get(checkpoint)
    inputs = tokenizer(clean, return_tensors="pt")
    with _lock:  # speaking_rate is model state; one synthesis at a time
        model.speaking_rate = 1.0
        with torch.no_grad():
            waveform = model(**inputs).waveform[0].cpu().numpy()
        waveform = _trim_silence(waveform, rate)
        speed = 1.0
        for _ in range(3):  # VITS durations vary run to run: re-check
            if not max_seconds or len(waveform) / rate <= max_seconds:
                break
            speed = min(1.3, speed * len(waveform) / rate
                        / (max_seconds * 0.92))
            model.speaking_rate = speed
            with torch.no_grad():
                waveform = model(**inputs).waveform[0].cpu().numpy()
            waveform = _trim_silence(waveform, rate)
        model.speaking_rate = 1.0
    if (max_seconds and len(waveform) / rate > max_seconds
            and clean.lower().startswith("looks like ")):
        # Still long at 1.3x: drop the hedge, keep the finding.
        rest = clean[len("looks like "):]
        return synthesize(rest[:1].upper() + rest[1:], checkpoint,
                          max_chars, max_seconds)
    peak = max(1e-6, float(abs(waveform).max()))
    pcm = (waveform / peak * 30000).astype("int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _trim_silence(x, rate: int, pad_s: float = 0.06):
    """MMS pads ~0.3-0.5s of silence at each end; keep only a short pad.

    Saves ~0.8s per spoken line and keeps short verdicts under 2s.
    """
    import numpy as np

    loud = np.flatnonzero(np.abs(x) > 0.02 * max(1e-6, float(np.abs(x).max())))
    if not len(loud):
        return x
    pad = int(pad_s * rate)
    return x[max(0, loud[0] - pad): min(len(x), loud[-1] + pad)]


def available() -> bool:
    try:
        import torch  # noqa: F401
        from transformers import VitsModel  # noqa: F401
        return True
    except Exception:
        return False
