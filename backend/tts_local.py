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
_lock = threading.Lock()

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


def synthesize(text: str, checkpoint: str, max_chars: int = 400) -> bytes:
    """Speak `text` with a local MMS-TTS checkpoint. Returns WAV bytes."""
    clean = _WS.sub(" ", (text or "").strip())[:max_chars]
    if not clean:
        raise ValueError("empty text")
    tokenizer, model, torch, rate = _get(checkpoint)
    inputs = tokenizer(clean, return_tensors="pt")
    with torch.no_grad():
        waveform = model(**inputs).waveform[0].cpu().numpy()
    peak = max(1e-6, float(abs(waveform).max()))
    pcm = (waveform / peak * 30000).astype("int16")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def available() -> bool:
    try:
        import torch  # noqa: F401
        from transformers import VitsModel  # noqa: F401
        return True
    except Exception:
        return False
