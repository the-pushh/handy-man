"""Narration translation for every MMS voice (NLLB-200, cached on disk).

Only CLOSED template sets are ever translated (~30 short strings from
voice_lines): each target language is translated once, on first use, then
served from backend/voice_lines_i18n.json forever. Nothing user-typed goes
to NLLB — transcripts only drive keyword matching.

First foreign-language turn pays a one-time cost (model + tokenizer
download ~2.5GB, then ~1-3s per line); every later turn is instant.
"""

import json
import threading
from pathlib import Path

MODEL_ID = "facebook/nllb-200-distilled-600M"
CACHE_FILE = Path(__file__).resolve().parent / "voice_lines_i18n.json"

# MMS code -> NLLB code where plain prefix matching misses:
# ara/fas are macrolanguage codes; NLLB uses arb_Arab / pes_Arab.
OVERRIDES: dict = {"ara": "arb_Arab", "fas": "pes_Arab"}

_lock = threading.Lock()
_model = None
_tokenizer = None
_torch = None


def nllb_codes() -> set:
    """Ground-truth NLLB language list from the installed transformers."""
    try:
        from transformers.models.nllb.tokenization_nllb import (
            FAIRSEQ_LANGUAGE_CODES,
        )
        return set(FAIRSEQ_LANGUAGE_CODES)
    except Exception:
        return set()


def _load():
    global _model, _tokenizer, _torch
    if _model is None:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        _torch = torch
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_ID)
        _model.eval()
    return _model, _tokenizer, _torch


def nllb_target(mms_code: str) -> str | None:
    """NLLB target code for an MMS checkpoint suffix (or None)."""
    base = mms_code.split("-script_")[0]
    if base in OVERRIDES:
        return OVERRIDES[base]
    cands = sorted(l for l in nllb_codes() if l.split("_")[0] == base)
    return cands[0] if cands else None


def can_narrate(mms_code: str) -> bool:
    """Whether narration text can be translated (NLLB covers the voice)."""
    return nllb_target(mms_code) is not None


def _read_cache() -> dict:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_cache(data: dict) -> None:
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    tmp.replace(CACHE_FILE)


def source_strings() -> list:
    """Every user-facing template string (English source)."""
    from . import voice_lines as V
    strings: list = []
    for key in V.LINES:
        strings.append(V.LINES[key][0])
    for family in V.CAUSES:
        strings.extend(V.CAUSES[family][0])
    for step in V.STEPS:
        strings.append(step[0])
    for _, names in V.DEVICE_KEYWORDS:
        strings.append(names[0])
    strings.append(V.FALLBACK_DEVICE[0])
    for zid in ("control", "body", "inlet"):
        from .pipeline import ZONE_NAMES
        strings.append(ZONE_NAMES[zid][0])
    from .pipeline import LOGO_NAMES
    strings.append(LOGO_NAMES[0])
    # de-dupe, preserve order
    return list(dict.fromkeys(strings))


def translate(text: str, mms_code: str) -> str:
    """Translate one English template string; cached; English on failure.

    NLLB translates {placeholders} too, so spans in braces are translated
    separately and spliced back (word order may follow the source).
    """
    import re as _re

    if not text or mms_code in ("eng", "hin", "hinglish"):
        return text
    if "{" in text and "}" in text:
        segments = _re.split(r"(\{[^}]*\})", text)
        return "".join(p if p.startswith("{") else translate(p, mms_code)
                       for p in segments)
    target = nllb_target(mms_code)
    if not target:
        return text
    return _generate(text, "eng_Latn", target, mms_code)


def to_english_from(text: str, src_nllb: str) -> str:
    """Translate INTO English from an explicit NLLB source code."""
    if not text or not src_nllb or src_nllb == "eng_Latn":
        return text
    try:
        return _generate(text, src_nllb, "eng_Latn", "src:" + src_nllb,
                          cache=False)
    except Exception:
        return text


def src_nllb_for_iso1(iso1: str) -> str:
    """NLLB source code for a detected ISO 639-1 language ('' if none)."""
    try:
        from iso639 import Lang
        iso3 = Lang(iso1).pt3 or ""
    except Exception:
        return ""
    if not iso3:
        return ""
    cands = sorted(l for l in nllb_codes() if l.split("_")[0] == iso3)
    return cands[0] if cands else ""


def _generate(text: str, src: str, target: str, mms_code: str,
              cache: bool = True) -> str:
    with _lock:
        store = _read_cache() if cache else {}
        entry = store.get(mms_code, {})
        if text in entry.get("map", {}):
            return entry["map"][text]
        model, tok, torch = _load()
        tok.src_lang = src
        inputs = tok([text], return_tensors="pt", truncation=True, max_length=128)
        with torch.no_grad():
            out = model.generate(
                **inputs,
                forced_bos_token_id=tok.convert_tokens_to_ids(target),
                max_new_tokens=128,
            )
        result = tok.batch_decode(out, skip_special_tokens=True)[0].strip()
        if not result:
            return text
        if cache:
            entry = {"nllb": target, "map": {**entry.get("map", {}), text: result}}
            store[mms_code] = entry
            _write_cache(store)
        return result
