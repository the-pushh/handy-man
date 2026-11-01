"""Language-code mapping between MMS-TTS voices and NLLB-200.

Used by language detection (backend/lang.py) to say which voices have a
translation route. No text is translated here: every spoken line comes
from a live model reply, never from a canned template.
"""

# MMS code -> NLLB code where plain prefix matching misses:
# ara/fas are macrolanguage codes; NLLB uses arb_Arab / pes_Arab.
OVERRIDES: dict = {"ara": "arb_Arab", "fas": "pes_Arab"}


def nllb_codes() -> set:
    """Ground-truth NLLB language list from the installed transformers."""
    try:
        from transformers.models.nllb.tokenization_nllb import (
            FAIRSEQ_LANGUAGE_CODES,
        )
        return set(FAIRSEQ_LANGUAGE_CODES)
    except Exception:
        return set()


def nllb_target(mms_code: str) -> str | None:
    """NLLB target code for an MMS checkpoint suffix (or None)."""
    base = mms_code.split("-script_")[0]
    if base in OVERRIDES:
        return OVERRIDES[base]
    cands = sorted(l for l in nllb_codes() if l.split("_")[0] == base)
    return cands[0] if cands else None


def can_narrate(mms_code: str) -> bool:
    """Whether the voice has an NLLB translation route."""
    return nllb_target(mms_code) is not None


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
